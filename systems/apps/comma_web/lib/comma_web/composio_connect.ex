defmodule CommaWeb.ComposioConnect do
  @moduledoc false
  alias Comma.Workspaces
  alias SalixStore.ComposioAccess, as: Access
  alias Salix.Control.RemoteMCPOAuth
  alias Salix.Control.ComposioConnect, as: Connect

  def get(user, session, workspace_id) do
    with {:ok, scope} <- scope(user, session, workspace_id),
         {:ok, profile} <- Access.profile(scope.tenant, scope.group, scope.user),
         {:ok, accounts} <- Access.accounts(scope.tenant, scope.group, scope.user) do
      {:ok, public(profile, accounts)}
    end
  end

  def command(user, session, workspace_id, action, params) do
    with {:ok, scope} <- scope(user, session, workspace_id),
         {:ok, result} <- run(scope, action, params) do
      {:ok,
       Map.drop(
         result,
         ~w(authorization project_configuration connection_id mcp_session_headers schemas)
       )}
    end
  end

  defp run(s, "authorize", _) do
    RemoteMCPOAuth.start_composio_authorization(s.tenant, s.group, s.user, s.workspace)
  end

  defp run(s, "cancel", _) do
    with {:ok, profile} <- Access.profile(s.tenant, s.group, s.user),
         {:ok, _} <- Access.cancel(s.tenant, s.group, s.user) do
      if state = get_in(profile, ["attempt", "state"]),
        do: SalixStore.OAuth.AuthState.cancel_pending(state)

      {:ok, %{"status" => "cancelled"}}
    end
  end

  defp run(s, "verify", _) do
    with {:ok, schemas} <- Salix.Control.ComposioConnect.schemas(s.tenant, s.group, s.user),
         {:ok, profile} <-
           Access.update_profile(s.tenant, s.group, s.user, fn current ->
             {:ok, Map.put(current, "schemas", schemas)}
           end),
         {:ok, accounts} <- Access.accounts(s.tenant, s.group, s.user),
         do: {:ok, public(profile, accounts)}
  end

  defp run(s, "project", %{"api_key" => key}) when is_binary(key) and byte_size(key) in 1..4096 do
    # Validate before save. Do not adopt a deployment default on failure.
    with {:ok, _} <- SalixStore.Composio.list_toolkits_page(%{"api_key" => key}, limit: 1),
         {:ok, _} <- Access.put_project_settings(s.tenant, s.group, s.user, %{"api_key" => key}) do
      {:ok, %{"status" => "connected", "mode" => "project"}}
    else
      _ -> {:error, :composio_project_validation_failed}
    end
  end

  defp run(_s, "catalog", %{"toolkits" => toolkits}) do
    with {:ok, items} <- Salix.Control.ComposioCatalog.lookup(toolkits),
         do: {:ok, %{"items" => items, "next_cursor" => nil}}
  end

  defp run(s, "catalog", params) do
    with {:ok, profile} <- Access.profile(s.tenant, s.group, s.user) do
      if profile["mode"] == "project" do
        with {:ok, settings} <- Access.project_settings(s.tenant, s.group, s.user),
             {:ok, page} <-
               SalixStore.Composio.list_toolkits_page(settings,
                 search: params["query"],
                 cursor: params["cursor"],
                 limit: 20
               ) do
          {:ok,
           Map.update!(page, "items", fn items ->
             Enum.map(items, fn item ->
               %{
                 "slug" => item["slug"],
                 "name" => item["name"],
                 "description" =>
                   item["description"] || get_in(item, ["meta", "description"]) || "",
                 "logo" => "https://logos.composio.dev/api/" <> item["slug"]
               }
             end)
           end)}
        end
      else
        Salix.Control.ComposioCatalog.page(params)
      end
    end
  end

  defp run(s, "connect", %{"toolkit" => toolkit}) when is_binary(toolkit) do
    with true <- String.match?(toolkit, ~r/^[a-z0-9_]{1,100}$/),
         {:ok, p} <- Access.profile(s.tenant, s.group, s.user) do
      if p["mode"] == "project" do
        connect_project(s, toolkit)
      else
        connect_personal(s, toolkit)
      end
    else
      false -> {:error, :invalid_toolkit}
      error -> error
    end
  end

  defp run(s, "account", %{"account_id" => id, "operation" => op} = params) when is_binary(id) do
    with {:ok, account} <- Access.account(s.tenant, s.group, s.user, id) do
      case {op, account["mode"]} do
        {"disable", _} ->
          Access.enable_account(s.tenant, s.group, s.user, id, false)

        {"enable", _} ->
          Access.enable_account(s.tenant, s.group, s.user, id, true)

        {"verify", _} ->
          verify_account(s, account)

        {"reopen", _} ->
          Access.account_authorization(s.tenant, s.group, s.user, id)

        {"cancel", _} ->
          Access.cancel_account(s.tenant, s.group, s.user, id)

        {"reconnect", "connect"} ->
          connect_personal(s, account["toolkit"], id)

        {"disconnect", "connect"} ->
          with {:ok, _} <- Access.enable_account(s.tenant, s.group, s.user, id, false),
               :ok <- Connect.remove_account(s.tenant, s.group, s.user, account["toolkit"], id) do
            Access.put_account(
              s.tenant,
              s.group,
              s.user,
              id,
              Map.put(account, "status", "DISCONNECTED")
            )
          end

        {"reconnect", "project"} ->
          connect_project(s, account["toolkit"], id)

        {"disconnect", "project"} ->
          # Disable local effects first. A remote error remains visible and retryable.
          with {:ok, _} <- Access.enable_account(s.tenant, s.group, s.user, id, false),
               {:ok, settings} <- Access.project_settings(s.tenant, s.group, s.user),
               {:ok, _} <- owned_project_account(s, settings, id),
               :ok <- SalixStore.Composio.delete_connected_account(settings, id),
               do:
                 Access.put_account(
                   s.tenant,
                   s.group,
                   s.user,
                   id,
                   Map.put(account, "status", "DISCONNECTED")
                 )

        {"grant", _} ->
          agent_id = params["agent_id"]

          tools = params["tools"] || []

          with true <- is_binary(agent_id),
               true <- tools == [] or params["share_with_workspace"] == true,
               {:ok, agent} <- SalixAgent.Control.get(agent_id),
               true <- agent["group_id"] == s.group and agent["tenant_id"] == s.tenant do
            Access.grant(s.tenant, s.group, s.user, id, agent_id, tools)
          else
            _ -> {:error, :composio_access_denied}
          end

        _ ->
          {:error, :unsupported_composio_operation}
      end
    end
  end

  defp run(s, "consent", %{"toolkit" => toolkit, "operation" => "get"})
       when is_binary(toolkit) and byte_size(toolkit) in 1..100 do
    case Access.consent(s.tenant, s.group, s.user, toolkit) do
      {:ok, consent} -> {:ok, %{"consent" => public_consent(consent)}}
      {:error, :not_found} -> {:ok, %{"consent" => nil}}
      error -> error
    end
  end

  defp run(s, "consent", %{"toolkit" => toolkit, "consent_id" => id, "operation" => op} = params)
       when is_binary(toolkit) and byte_size(toolkit) in 1..100 and is_binary(id) and
              byte_size(id) in 1..128 do
    case op do
      "reopen" ->
        Access.consent_authorization(s.tenant, s.group, s.user, toolkit, id)

      "cancel" ->
        with {:ok, consent} <- Access.cancel_consent(s.tenant, s.group, s.user, toolkit, id),
             do: {:ok, %{"consent" => public_consent(consent)}}

      "select" ->
        select_consent_account(s, toolkit, id, params["account_id"])

      _ ->
        {:error, :unsupported_composio_operation}
    end
  end

  defp run(s, "refresh_accounts", %{"toolkit" => toolkit}) when is_binary(toolkit) do
    with {:ok, profile} <- Access.profile(s.tenant, s.group, s.user),
         true <- profile["mode"] == "connect",
         {:ok, remote} <- Connect.accounts(s.tenant, s.group, s.user, toolkit),
         :ok <- remember_accounts(s, remote),
         {:ok, accounts} <- Access.accounts(s.tenant, s.group, s.user) do
      {:ok, public(profile, accounts)}
    else
      false -> {:error, :unsupported_composio_operation}
      error -> error
    end
  end

  defp run(s, "tools", %{"account_id" => id} = params) when is_binary(id) do
    with {:ok, account} <- Access.account(s.tenant, s.group, s.user, id) do
      if account["mode"] == "project" do
        with {:ok, settings} <- Access.project_settings(s.tenant, s.group, s.user),
             {:ok, page} <-
               SalixStore.Composio.list_tools_page(settings,
                 toolkit: account["toolkit"],
                 query: params["query"],
                 cursor: params["cursor"]
               ) do
          {:ok,
           Map.update!(
             page,
             "items",
             &Enum.filter(&1, fn tool -> tool["toolkit"] == account["toolkit"] end)
           )}
        end
      else
        Salix.Control.ComposioCatalog.tools(account["toolkit"], params)
      end
    end
  end

  defp run(s, "accounts", params) do
    with {:ok, page} <- Access.accounts(s.tenant, s.group, s.user, params["cursor"]),
         do:
           {:ok,
            %{"items" => public_accounts(page["items"]), "next_cursor" => page["next_cursor"]}}
  end

  defp run(s, "grant", %{"account_id" => id, "agent_id" => agent})
       when is_binary(id) and is_binary(agent) do
    with {:ok, _} <- Access.account(s.tenant, s.group, s.user, id) do
      case Access.agent_account_grant(s.tenant, s.group, agent, id) do
        {:ok, %{"user_id" => user} = grant} when user == s.user ->
          {:ok, Map.take(grant, ~w(tools enabled))}

        {:error, :not_found} ->
          {:ok, %{"tools" => [], "enabled" => false}}

        _ ->
          {:error, :composio_access_denied}
      end
    end
  end

  defp run(s, "approvals", params) do
    SalixAgent.CapabilityRequests.list_composio_page(s.group, s.tenant, s.user,
      cursor: params["cursor"]
    )
  end

  defp run(s, "decide", %{"request_id" => id, "approved" => approved})
       when is_binary(id) and is_boolean(approved) do
    SalixAgent.CapabilityRequests.decide_composio(s.group, id, s.tenant, s.user, approved)
  end

  defp run(_, _, _), do: {:error, :invalid_composio_request}

  defp remember_accounts(s, remote) do
    Enum.reduce_while(remote, :ok, fn account, :ok ->
      # Existing pending/cancelled attempts have their own confirmation path.
      result =
        case Access.account(s.tenant, s.group, s.user, account["id"]) do
          {:error, :not_found} ->
            Access.put_account(s.tenant, s.group, s.user, account["id"], account)

          {:ok, _} ->
            Access.update_account_name(s.tenant, s.group, s.user, account["id"], account)

          error ->
            error
        end

      case result do
        {:ok, _} -> {:cont, :ok}
        error -> {:halt, error}
      end
    end)
  end

  defp connect_personal(s, toolkit, replaces \\ nil) do
    with {:ok, %{"mode" => "connect", "status" => "connected"}} <-
           Access.profile(s.tenant, s.group, s.user),
         {:ok, consent} <- Access.begin_consent(s.tenant, s.group, s.user, toolkit, replaces),
         {:ok, link} <- Connect.add_account(s.tenant, s.group, s.user, toolkit),
         {:ok, _} <-
           Access.finish_consent(
             s.tenant,
             s.group,
             s.user,
             toolkit,
             consent["id"],
             link["authorization_url"]
           ) do
      {:ok, Map.merge(link, %{"consent_id" => consent["id"], "status" => "pending"})}
    else
      {:error, _} = error -> error
      _ -> {:error, :composio_sign_in_required}
    end
  end

  defp select_consent_account(s, toolkit, id, account_id)
       when is_binary(account_id) and byte_size(account_id) in 1..256 do
    with {:ok, %{"mode" => "connect", "status" => "connected"}} <-
           Access.profile(s.tenant, s.group, s.user),
         {:ok, consent} <- Access.consent(s.tenant, s.group, s.user, toolkit),
         :ok <- selectable_consent(consent, id, account_id) do
      if consent["status"] == "completed" do
        Access.account(s.tenant, s.group, s.user, account_id)
      else
        complete_consent_account(s, toolkit, id, account_id)
      end
    else
      {:error, _} = error -> error
      _ -> {:error, :composio_access_denied}
    end
  end

  defp select_consent_account(_, _, _, _), do: {:error, :invalid_composio_account}

  defp complete_consent_account(s, toolkit, id, account_id) do
    with {:ok, remote} <- Connect.account(s.tenant, s.group, s.user, toolkit, account_id),
         true <- remote["status"] == "ACTIVE",
         {:ok, completed} <-
           Access.complete_consent(s.tenant, s.group, s.user, toolkit, id, account_id) do
      case completed["status"] do
        "completed" ->
          Access.account(s.tenant, s.group, s.user, account_id)

        "selecting" ->
          with {:ok, selected} <-
                 Access.put_account(s.tenant, s.group, s.user, account_id, remote),
               :ok <- retire_replaced(s, Map.put(completed, "id", account_id), remote),
               {:ok, _} <-
                 Access.settle_consent(s.tenant, s.group, s.user, toolkit, id, account_id),
               do: {:ok, selected}

        _ ->
          {:error, :composio_access_denied}
      end
    else
      false -> {:error, :composio_account_not_active}
      {:error, _} = error -> error
      _ -> {:error, :composio_access_denied}
    end
  end

  defp selectable_consent(
         %{"id" => id, "status" => "completed", "selected_account_id" => selected},
         id,
         selected
       ),
       do: :ok

  defp selectable_consent(%{"id" => id, "status" => "selecting"}, id, _),
    do: {:error, :composio_consent_in_progress}

  defp selectable_consent(%{"id" => id, "status" => "pending", "expires_at" => expiry}, id, _)
       when is_integer(expiry) do
    if expiry > System.system_time(:millisecond),
      do: :ok,
      else: {:error, :composio_attempt_not_pending}
  end

  defp selectable_consent(_, _, _), do: {:error, :composio_attempt_not_pending}

  defp public_consent(consent) do
    public = Map.take(consent, ~w(id toolkit status expires_at))

    if consent["status"] in ["starting", "pending"] and
         consent["expires_at"] <= System.system_time(:millisecond),
       do: Map.put(public, "status", "expired"),
       else: public
  end

  defp connect_project(s, toolkit, replaces \\ nil) do
    with {:ok, settings} <- Access.project_settings(s.tenant, s.group, s.user),
         {:ok, auth_config} <- SalixStore.Composio.ensure_auth_config(settings, toolkit),
         {:ok, link} <-
           SalixStore.Composio.create_connect_link(settings, auth_config, personal_project_id(s)),
         id when is_binary(id) <- link["connected_account_id"],
         url when is_binary(url) <- link["redirect_url"],
         {:ok, _} <-
           Access.put_account(s.tenant, s.group, s.user, id, %{
             "toolkit" => toolkit,
             "name" => toolkit,
             "status" => "INITIATED",
             "mode" => "project"
           }),
         {:ok, _} <- Access.begin_account(s.tenant, s.group, s.user, id, url, replaces) do
      {:ok, %{"account_id" => id, "authorization_url" => url, "status" => "pending"}}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  defp verify_account(_, %{"status" => "CANCELLED"}),
    do: {:error, :composio_authorization_cancelled}

  defp verify_account(s, %{"mode" => "project", "id" => id} = local) do
    with :ok <- account_attempt_current(local),
         {:ok, settings} <- Access.project_settings(s.tenant, s.group, s.user),
         {:ok, remote} <- owned_project_account(s, settings, id),
         toolkit = get_in(remote, ["toolkit", "slug"]),
         true <- is_binary(toolkit),
         {:ok, confirmed} <-
           Access.confirm_account(s.tenant, s.group, s.user, id, %{
             "toolkit" => toolkit,
             "name" => remote["name"] || toolkit,
             "status" => remote["status"],
             "mode" => "project"
           }),
         :ok <- retire_replaced(s, local, remote) do
      {:ok, confirmed}
    else
      false -> {:error, :invalid_composio_response}
      error -> error
    end
  end

  defp verify_account(s, %{"mode" => "connect", "id" => id} = local) do
    with :ok <- account_attempt_current(local),
         {:ok, remote} <- Connect.account(s.tenant, s.group, s.user, local["toolkit"], id),
         {:ok, confirmed} <- Access.confirm_account(s.tenant, s.group, s.user, id, remote),
         :ok <- retire_replaced(s, local, remote),
         do: {:ok, confirmed}
  end

  defp verify_account(_, _), do: {:error, :unsupported_composio_operation}

  defp account_attempt_current(%{"status" => "INITIATED"} = account) do
    if is_integer(account["authorization_expires_at"]) and
         account["authorization_expires_at"] > System.system_time(:millisecond),
       do: :ok,
       else: {:error, :composio_authorization_expired}
  end

  defp account_attempt_current(_), do: :ok

  defp retire_replaced(s, local, remote) do
    if remote["status"] == "ACTIVE" and is_binary(local["replaces"]) and
         local["replaces"] != local["id"] do
      with {:ok, _} <- Access.enable_account(s.tenant, s.group, s.user, local["replaces"], false),
           do: :ok
    else
      :ok
    end
  end

  defp owned_project_account(s, settings, id) do
    with {:ok, account} <- SalixStore.Composio.get_connected_account(settings, id),
         true <- account["user_id"] == personal_project_id(s) do
      {:ok, account}
    else
      false -> {:error, :composio_account_not_owned}
      error -> error
    end
  end

  defp personal_project_id(s), do: "comma:" <> s.group <> ":" <> s.user

  defp public(profile, accounts) do
    %{
      "mode" => profile["mode"],
      "status" => profile["status"],
      "user_id" => profile["user_id"],
      "accounts" => public_accounts(accounts["items"]),
      "next_cursor" => accounts["next_cursor"],
      "capabilities" => %{
        "catalog" => true,
        "search" => true,
        "account_management" => true
      },
      "expires_at" => get_in(profile, ["attempt", "expires_at"])
    }
  end

  defp public_accounts(accounts) do
    Enum.map(accounts, fn account ->
      public = Map.take(account, ~w(id toolkit name status mode enabled))

      if account_attempt_current(account) == :ok,
        do: public,
        else: Map.put(public, "status", "EXPIRED")
    end)
  end

  defp scope(user, session, workspace_id) do
    with {:ok, workspace} <- Workspaces.authorize(user, session, workspace_id) do
      {:ok,
       %{
         tenant: workspace["salix_tenant_id"],
         group: workspace["default_group_id"],
         user: user["id"],
         workspace: workspace_id
       }}
    end
  end
end
