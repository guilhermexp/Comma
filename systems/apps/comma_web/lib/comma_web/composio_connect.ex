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
         {:ok, result} <-
           if(action == "google_drive",
             do: CommaWeb.GoogleDriveBrowser.browse(user, session, workspace_id, params),
             else: run(scope, action, params)
           ) do
      {:ok,
       Map.drop(
         result,
         ~w(authorization project_configuration connection_id mcp_session_headers schemas)
       )}
    end
  end

  defp run(s, "reconcile_accounts", params) do
    CommaWeb.RecommendationMemberRead.within(
      CommaWeb.RecommendationMemberRead.deadline(30_000),
      fn ->
        with {:ok, profile} <- Access.profile(s.tenant, s.group, s.user) do
          if profile["mode"] == "connect" and profile["status"] == "connected" do
            reconcile_accounts(s, profile, params)
          else
            with {:ok, page} <- Access.accounts(s.tenant, s.group, s.user),
                 do:
                   {:ok,
                    public(profile, page)
                    |> Map.put("consent", nil)
                    |> Map.put("remote_accounts", [])}
          end
        end
      end
    )
  end

  defp run(s, "routine_source", %{"operation" => operation, "account_id" => id} = params)
       when operation in ~w(prepare enable) and is_binary(id) do
    with {:ok, workspace} <- Workspaces.authorize(%{"id" => s.user}, %{}, s.workspace),
         {:ok, profile} <- Comma.Recommendations.get_runtime_profile(s.workspace, s.user),
         source when is_map(source) <- Enum.find(profile.sources, &(&1["connectionId"] == id)) do
      if is_nil(source["composioMode"]) do
        {:ok, %{"required" => false}}
      else
        with {:ok, identity} <-
               CommaWeb.RecommendationComposioMemberSource.identify_source(
                 workspace,
                 s.user,
                 source
               ) do
          confirmation = %{
            "required" => true,
            "identity" => identity["display"],
            "subject" => identity["subject"],
            "configuration" =>
              source["composioAuthorization"]
              |> Map.take(~w(mode authorization_revision))
              |> Map.put_new("authorization_revision", 0),
            "account_id" => id,
            "source_revision" => profile.source_revision,
            "consent" =>
              Comma.MemberSourceConsents.binding(s.workspace, s.user, source["toolkit"])
          }

          case operation do
            "prepare" ->
              {:ok, confirmation}

            "enable" ->
              with true <- params["confirmation"] == confirmation,
                   true <-
                     CommaWeb.RecommendationComposioTransport.current?(workspace, s.user, source) do
                Comma.Recommendations.confirm_composio_source(
                  %{"id" => s.user},
                  %{},
                  s.workspace,
                  source,
                  identity,
                  confirmation["consent"]
                )
              else
                _ -> {:error, :member_identity_or_source_unavailable}
              end
          end
        end
      end
    else
      {:error, _} = error -> error
      _ -> {:error, :member_identity_or_source_unavailable}
    end
  end

  defp run(s, "authorize", _) do
    with {:ok, result} <-
           RemoteMCPOAuth.start_composio_authorization(s.tenant, s.group, s.user, s.workspace),
         {:ok, :ok} <- revoke_routine_sources(s, :all),
         do: {:ok, result}
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
         {:ok, _} <- Access.put_project_settings(s.tenant, s.group, s.user, %{"api_key" => key}),
         {:ok, :ok} <- revoke_routine_sources(s, :all) do
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
          disable_account(s, id)

        {"enable", _} ->
          Access.enable_account(s.tenant, s.group, s.user, id, true)

        {"verify", _} ->
          with {:ok, verified} <- verify_account(s, account) do
            if verified["status"] == "ACTIVE",
              do: {:ok, verified},
              else: with({:ok, :ok} <- revoke_routine_sources(s, [id]), do: {:ok, verified})
          end

        {"reopen", _} ->
          Access.account_authorization(s.tenant, s.group, s.user, id)

        {"cancel", _} ->
          Access.cancel_account(s.tenant, s.group, s.user, id)

        {"reconnect", "connect"} ->
          connect_personal(s, account["toolkit"], id)

        {"disconnect", "connect"} ->
          with {:ok, _} <- disable_account(s, id),
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
          with {:ok, _} <- disable_account(s, id),
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

          enabled = params["enabled"]

          with true <- is_binary(agent_id),
               true <- is_boolean(enabled),
               true <- not enabled or params["share_with_workspace"] == true,
               {:ok, agent} <- SalixAgent.Control.get(agent_id),
               true <- agent["group_id"] == s.group and agent["tenant_id"] == s.tenant do
            Access.grant(s.tenant, s.group, s.user, id, agent_id, enabled)
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

  # Consent discovery does not adopt candidates. Only consent select can enable
  # a newly discovered account; ordinary metadata refresh keeps its old contract.
  defp run(s, "refresh_accounts", %{"toolkit" => toolkit, "consent_id" => id})
       when is_binary(toolkit) and is_binary(id) do
    with {:ok, %{"mode" => "connect"} = profile} <- Access.profile(s.tenant, s.group, s.user),
         {:ok, %{"id" => ^id}} <- Access.consent(s.tenant, s.group, s.user, toolkit),
         {:ok, remote} <- Connect.accounts(s.tenant, s.group, s.user, toolkit),
         {:ok, %{"id" => ^id} = consent} <- Access.consent(s.tenant, s.group, s.user, toolkit),
         {:ok, accounts} <- Access.accounts(s.tenant, s.group, s.user) do
      {:ok,
       public(profile, accounts)
       |> Map.put("consent", public_consent(consent))
       |> Map.put("remote_accounts", Enum.map(remote, &Map.put(&1, "enabled", false)))}
    else
      {:ok, _} -> {:error, :composio_attempt_not_pending}
      error -> error
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
          {:ok, Map.take(grant, ~w(enabled toolkit))}

        {:error, :not_found} ->
          {:ok, %{"enabled" => false}}

        _ ->
          {:error, :composio_access_denied}
      end
    end
  end

  defp run(_, _, _), do: {:error, :invalid_composio_request}

  defp reconcile_accounts(s, profile, params) do
    with {:ok, consents} <- reconciliation_consents(s, params),
         {:ok, toolkits} <- reconciliation_toolkits(params, consents["items"]),
         {:ok, remote} <- reconciliation_read(s, toolkits, params),
         {:ok, fresh_page} <- Access.accounts(s.tenant, s.group, s.user),
         {:ok, {connected, registered}} <-
           connected_toolkits(
             s,
             fresh_page,
             toolkits,
             MapSet.new(Enum.map(remote, & &1["id"])),
             {%{}, MapSet.new()}
           ),
         candidates = Enum.reject(remote, &MapSet.member?(registered, &1["id"])),
         {:ok, adopted} <-
           adopt_remote_accounts(
             s,
             profile,
             Map.values(connected),
             remote,
             candidates,
             consents["items"],
             params
           ),
         {:ok, current} <- Access.accounts(s.tenant, s.group, s.user),
         {:ok, consent} <- current_consent(s, params["toolkit"]),
         {:ok, current_profile} <- Access.profile(s.tenant, s.group, s.user) do
      # Include exact records found by the remote read even when they are beyond
      # the first local page. Pagination stays on the existing local account API.
      scoped =
        if params["toolkit"],
          do: Enum.filter(Map.values(connected), &(&1["toolkit"] == params["toolkit"])),
          else: []

      accounts = Enum.uniq_by(adopted ++ scoped ++ current["items"], & &1["id"])

      {:ok,
       public(current_profile, Map.put(current, "items", accounts))
       |> Map.put("consent", consent)
       |> Map.put(
         "remote_accounts",
         if(params["toolkit"], do: Enum.map(candidates, &Map.put(&1, "enabled", false)), else: [])
       )}
    end
  end

  defp reconciliation_consents(s, %{"toolkit" => toolkit}) when is_binary(toolkit) do
    case Access.consent(s.tenant, s.group, s.user, toolkit) do
      {:ok, consent} -> {:ok, %{"items" => [consent]}}
      {:error, :not_found} -> {:ok, %{"items" => []}}
      error -> error
    end
  end

  defp reconciliation_consents(_, %{"toolkit" => _}),
    do: {:error, :invalid_composio_request}

  defp reconciliation_consents(s, _), do: Access.consents(s.tenant, s.group, s.user)

  defp reconciliation_toolkits(%{"toolkit" => toolkit}, _) do
    reconciliation_toolkits(%{"toolkits" => [toolkit], "scoped" => true}, [])
  end

  defp reconciliation_toolkits(params, consents) do
    requested = Map.get(params, "toolkits", [])

    if is_list(requested) and length(requested) <= 50 do
      # Connect lists accounts only for named toolkits. Unscoped reads also name
      # the product-recognized member sources, so accounts authorized outside a
      # Comma consent converge without a catalog visit; still one batched read.
      built_in =
        if params["scoped"],
          do: [],
          else: CommaWeb.RecommendationSourceCatalog.supported_composio_toolkits()

      toolkits = Enum.uniq(requested ++ Enum.map(consents, & &1["toolkit"]) ++ built_in)

      if length(toolkits) <= 100 and
           Enum.all?(toolkits, &(is_binary(&1) and String.match?(&1, ~r/^[a-z0-9_]{1,100}$/))),
         do: {:ok, toolkits},
         else: {:error, :invalid_composio_request}
    else
      {:error, :invalid_composio_request}
    end
  end

  defp reconciliation_read(s, [toolkit], %{"toolkit" => toolkit}),
    do: Connect.accounts(s.tenant, s.group, s.user, toolkit)

  defp reconciliation_read(_, [], _), do: {:ok, []}

  defp reconciliation_read(s, toolkits, _),
    do: Connect.accounts_many(s.tenant, s.group, s.user, toolkits)

  # Walk existing member-local pages serially in the bounded reconciliation
  # worker. Retain at most one connected record per requested toolkit, rather
  # than loading every member account into the response or issuing provider RPCs
  # per account. Absence must consider later local pages as well.
  defp connected_toolkits(s, page, toolkits, remote_ids, {connected, registered}) do
    {found, known} =
      Enum.reduce(page["items"], {connected, registered}, fn account, {acc, known} ->
        toolkit = account["toolkit"]

        acc =
          if toolkit in toolkits and connected_account?(account, toolkit),
            do: Map.put_new(acc, toolkit, account),
            else: acc

        known =
          if MapSet.member?(remote_ids, account["id"]),
            do: MapSet.put(known, account["id"]),
            else: known

        {acc, known}
      end)

    if is_nil(page["next_cursor"]) or Enum.all?(toolkits, &Map.has_key?(found, &1)) do
      {:ok, {found, known}}
    else
      with {:ok, next} <- Access.accounts(s.tenant, s.group, s.user, page["next_cursor"]),
           do: connected_toolkits(s, next, toolkits, remote_ids, {found, known})
    end
  end

  defp adopt_remote_accounts(s, profile, local, remote, candidates, consents, params) do
    remote
    |> Enum.group_by(& &1["toolkit"])
    |> Enum.reduce_while({:ok, []}, fn {toolkit, accounts}, {:ok, adopted} ->
      consent = Enum.find(consents, &(&1["toolkit"] == toolkit))
      connected = Enum.any?(local, &connected_account?(&1, toolkit))
      active = Enum.filter(accounts, &(&1["status"] == "ACTIVE"))
      selection = params["account_id"]

      chosen =
        if connected or ((consent || %{})["status"] == "cancelled" and is_nil(selection)),
          do: nil,
          else:
            adoption_candidate(
              Enum.filter(candidates, &(&1["toolkit"] == toolkit and &1["status"] == "ACTIVE")),
              consent,
              selection
            )

      if is_nil(chosen) do
        selected = (consent || %{})["selected_account_id"]

        if connected and Enum.any?(active, &(&1["id"] == selected)) do
          case settle_adopted_consent(s, toolkit, consent, selected) do
            :ok -> {:cont, {:ok, adopted}}
            error -> {:halt, error}
          end
        else
          {:cont, {:ok, adopted}}
        end
      else
        # Recheck member and credential authority after the external read.
        with {:ok, fresh} <- Access.profile(s.tenant, s.group, s.user),
             true <-
               fresh["connection_id"] == profile["connection_id"] and fresh["mode"] == "connect" and
                 fresh["status"] == "connected",
             {:ok, scope_now} <- scope(%{"id" => s.user}, %{}, s.workspace),
             true <- scope_now == s,
             :ok <- adoption_identity_available(s, chosen),
             {:ok, prepared} <- prepare_adopted_consent(s, toolkit, consent, chosen["id"]),
             {:ok, record} <- Access.adopt_account(s.tenant, s.group, s.user, chosen),
             :ok <- settle_adopted_consent(s, toolkit, prepared, record["id"]) do
          {:cont, {:ok, [record | adopted]}}
        else
          false -> {:halt, {:error, :composio_access_denied}}
          error -> {:halt, error}
        end
      end
    end)
  end

  defp adoption_identity_available(s, %{"id" => id, "toolkit" => toolkit}) do
    case Access.account(s.tenant, s.group, s.user, id) do
      {:error, :not_found} ->
        :ok

      {:ok,
       %{"mode" => "connect", "toolkit" => ^toolkit, "status" => "ACTIVE", "enabled" => true}} ->
        :ok

      {:ok, _} ->
        {:error, :composio_account_not_owned}

      error ->
        error
    end
  end

  defp connected_account?(account, toolkit),
    do:
      account["mode"] == "connect" and account["toolkit"] == toolkit and
        account["status"] == "ACTIVE" and account["enabled"] == true

  defp adoption_candidate(active, _consent, selection) when is_binary(selection),
    do: Enum.find(active, &(&1["id"] == selection))

  defp adoption_candidate(active, %{"status" => "selecting", "selected_account_id" => id}, _),
    do: Enum.find(active, &(&1["id"] == id))

  defp adoption_candidate(active, consent, _) do
    baseline = (consent || %{})["baseline_account_ids"] || []
    fresh = Enum.reject(active, &(&1["id"] in baseline))
    candidates = if fresh == [], do: active, else: fresh

    cond do
      length(candidates) == 1 ->
        hd(candidates)

      candidates != [] and no_distinct_account_identities?(candidates) ->
        Enum.min_by(candidates, & &1["id"])

      true ->
        nil
    end
  end

  # These Connect payloads expose alias/user_info, but no authorization/update
  # timestamp. Unknown metadata is not evidence of a different identity. The
  # opaque ID is only a deterministic tie-breaker, never an identity inference.
  defp no_distinct_account_identities?(accounts) do
    identities =
      Enum.flat_map(accounts, fn account ->
        value = if account["identity_available"], do: account["email"] || account["name"]

        if is_binary(value) and String.trim(value) != "",
          do: [String.downcase(String.trim(value))],
          else: []
      end)

    length(Enum.uniq(identities)) <= 1
  end

  defp prepare_adopted_consent(_, _, nil, _), do: {:ok, nil}

  defp prepare_adopted_consent(s, toolkit, %{"id" => id} = consent, account_id) do
    if consent["status"] in ["starting", "pending", "selecting"] do
      Access.prepare_adoption_consent(s.tenant, s.group, s.user, toolkit, id, account_id)
    else
      {:ok, consent}
    end
  end

  defp settle_adopted_consent(s, toolkit, %{"id" => id, "status" => "selecting"}, account_id) do
    with {:ok, _} <- Access.settle_consent(s.tenant, s.group, s.user, toolkit, id, account_id),
         do: :ok
  end

  defp settle_adopted_consent(_, _, _, _), do: :ok

  defp current_consent(_, nil), do: {:ok, nil}

  defp current_consent(s, toolkit) do
    case Access.consent(s.tenant, s.group, s.user, toolkit) do
      {:ok, consent} -> {:ok, public_consent(consent)}
      {:error, :not_found} -> {:ok, nil}
      error -> error
    end
  end

  defp remember_accounts(s, remote) do
    Enum.reduce_while(remote, :ok, fn account, :ok ->
      # Existing pending/cancelled attempts have their own confirmation path.
      result =
        case Access.account(s.tenant, s.group, s.user, account["id"]) do
          {:error, :not_found} ->
            {:ok, :unselected}

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
         {:ok, remote} <- Connect.accounts(s.tenant, s.group, s.user, toolkit),
         {:ok, consent} <-
           Access.begin_consent(
             s.tenant,
             s.group,
             s.user,
             toolkit,
             replaces,
             Enum.map(remote, & &1["id"])
           ),
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
    public = Map.take(consent, ~w(id toolkit status expires_at baseline_account_ids))

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
      with {:ok, _} <- disable_account(s, local["replaces"]),
           do: :ok
    else
      :ok
    end
  end

  defp disable_account(s, id) do
    with {:ok, account} <- Access.enable_account(s.tenant, s.group, s.user, id, false),
         {:ok, :ok} <- revoke_routine_sources(s, [id]),
         do: {:ok, account}
  end

  defp revoke_routine_sources(s, ids),
    do: Comma.Recommendations.revoke_composio_sources(%{"id" => s.user}, %{}, s.workspace, ids)

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
      public = Map.take(account, ~w(id toolkit name email status mode enabled))

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
