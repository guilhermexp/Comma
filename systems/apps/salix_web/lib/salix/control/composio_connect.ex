defmodule Salix.Control.ComposioConnect do
  @moduledoc false
  @behaviour SalixAgent.ComposioBroker
  alias Salix.Control.RemoteMCPOAuth
  alias SalixStore.ComposioAccess, as: Access
  alias SalixMCP.RemoteClient

  @impl true
  def authorize_member(tenant, group, user) do
    case Application.get_env(:salix_web, :comma_oauth_commit_mod) do
      module when is_atom(module) and not is_nil(module) ->
        module.authorize_composio_member(tenant, group, user)

      _ ->
        {:error, :composio_access_denied}
    end
  end

  def discover(tenant, group, user, query) do
    with {:ok, response} <-
           call(tenant, group, user, "COMPOSIO_SEARCH_TOOLS", %{
             "queries" => [%{"use_case" => query}],
             "session" => %{"generate_id" => true}
           }),
         %{
           "data" =>
             %{"toolkit_connection_statuses" => statuses, "tool_schemas" => schemas} = data
         } <- response,
         true <-
           is_list(statuses) and is_map(schemas) and length(statuses) <= 50 and
             map_size(schemas) <= 50,
         true <- Enum.all?(statuses, &valid_toolkit?/1) and Enum.all?(schemas, &valid_tool?/1) do
      tools =
        Enum.map(schemas, fn {slug, tool} ->
          %{
            "slug" => slug,
            "name" => display_name(slug, tool["toolkit"]),
            "description" => String.slice(tool["description"] || "", 0, 600),
            "toolkit" => String.downcase(tool["toolkit"] || "")
          }
        end)

      items =
        Enum.map(statuses, fn item ->
          slug = item["toolkit"]

          %{
            "slug" => slug,
            "name" => display_name(slug),
            "description" => String.slice(item["description"] || "", 0, 600),
            "has_active_connection" => item["has_active_connection"] == true,
            "tools" => Enum.filter(tools, &(&1["toolkit"] == slug))
          }
        end)

      {:ok,
       %{
         "items" => items,
         "tools" => tools,
         "next_cursor" => nil,
         "session_id" => get_in(data, ["session", "id"]),
         "log_id" => response["log_id"]
       }}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  def accounts(tenant, group, user, toolkit) do
    with {:ok, response} <-
           call(tenant, group, user, "COMPOSIO_MANAGE_CONNECTIONS", %{
             "toolkits" => [%{"name" => toolkit, "action" => "list"}]
           }),
         %{"data" => %{"results" => results}} <- response,
         %{"accounts" => accounts} <- results[toolkit],
         true <- is_list(accounts) and length(accounts) <= 50 and Enum.all?(accounts, &is_map/1) do
      Enum.reduce_while(accounts, {:ok, []}, fn raw, {:ok, acc} ->
        id = raw["id"] || raw["account_id"]
        status = raw["status"]

        if is_binary(id) and byte_size(id) in 1..256 and is_binary(status) and
             (is_nil(raw["alias"]) or is_binary(raw["alias"])) do
          account = %{
            "id" => id,
            "toolkit" => toolkit,
            "name" => raw["alias"] || display_name(toolkit),
            "status" => String.upcase(status),
            "mode" => "connect"
          }

          {:cont, {:ok, [account | acc]}}
        else
          {:halt, {:error, :invalid_composio_response}}
        end
      end)
      |> case do
        {:ok, items} -> {:ok, Enum.reverse(items)}
        error -> error
      end
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  def account(tenant, group, user, toolkit, id) do
    with {:ok, accounts} <- accounts(tenant, group, user, toolkit) do
      case Enum.find(accounts, &(&1["id"] == id)) do
        nil -> {:error, :composio_account_not_owned}
        account -> {:ok, account}
      end
    end
  end

  def add_account(tenant, group, user, toolkit) do
    with {:ok, response} <-
           call(tenant, group, user, "COMPOSIO_MANAGE_CONNECTIONS", %{
             "toolkits" => [%{"name" => toolkit, "action" => "add"}]
           }),
         %{"data" => %{"results" => results}} <- response,
         result when is_map(result) <- results[toolkit],
         url when is_binary(url) <- result["redirect_url"],
         id when is_binary(id) <-
           result["connected_account_id"] || result["account_id"] || result["id"] do
      {:ok, %{"account_id" => id, "authorization_url" => url}}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  def remove_account(tenant, group, user, toolkit, id) do
    with {:ok, _} <- account(tenant, group, user, toolkit, id),
         {:ok, _} <-
           call(tenant, group, user, "COMPOSIO_MANAGE_CONNECTIONS", %{
             "toolkits" => [%{"name" => toolkit, "action" => "remove", "account_id" => id}]
           }),
         {:ok, remaining} <- accounts(tenant, group, user, toolkit) do
      if Enum.any?(
           remaining,
           &(&1["id"] == id and &1["status"] not in ["DISCONNECTED", "DELETED"])
         ),
         do: {:error, :composio_disconnect_unconfirmed},
         else: :ok
    end
  end

  defp valid_toolkit?(%{"toolkit" => slug} = item),
    do:
      is_binary(slug) and String.match?(slug, ~r/^[a-z0-9_]{1,100}$/) and
        (is_nil(item["description"]) or is_binary(item["description"]))

  defp valid_toolkit?(_), do: false

  defp valid_tool?({slug, %{"toolkit" => toolkit} = tool}),
    do:
      is_binary(slug) and String.match?(slug, ~r/^[A-Z0-9_]{1,180}$/) and
        is_binary(toolkit) and String.match?(toolkit, ~r/^[A-Za-z0-9_]{1,100}$/) and
        (is_nil(tool["description"]) or is_binary(tool["description"]))

  defp valid_tool?(_), do: false

  defp display_name(slug, toolkit \\ nil) do
    slug
    |> String.replace_prefix(if(toolkit, do: String.upcase(toolkit) <> "_", else: ""), "")
    |> String.split("_")
    |> Enum.map_join(" ", &String.capitalize/1)
  end

  @impl true
  def schema(tenant, group, user, account, tools) do
    with {:ok, profile} <- Access.profile(tenant, group, user),
         true <- profile["mode"] == account["mode"] do
      case account["mode"] do
        "project" ->
          with {:ok, settings} <- Access.project_settings(tenant, group, user),
               {:ok, items} <-
                 SalixStore.Composio.list_tools(settings,
                   tool_slugs: Enum.join(tools, ","),
                   limit: 50
                 ),
               true <- MapSet.new(Enum.map(items, & &1["slug"])) == MapSet.new(tools),
               do: {:ok, %{"tools" => items}}

        "connect" ->
          call(tenant, group, user, "COMPOSIO_GET_TOOL_SCHEMAS", %{"tool_slugs" => tools})
      end
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  @impl true
  def execute(tenant, group, user, %{"mode" => "project"} = account, tools, authorize_effect) do
    with {:ok, %{"mode" => "project", "status" => "connected"}} <-
           Access.profile(tenant, group, user),
         {:ok, settings} <- Access.project_settings(tenant, group, user),
         {:ok, remote} <- SalixStore.Composio.get_connected_account(settings, account["id"]),
         true <-
           remote["user_id"] == "comma:" <> group <> ":" <> user and remote["status"] == "ACTIVE",
         {:ok, session} <-
           SalixStore.Composio.create_action_session(
             settings,
             remote["user_id"],
             account["id"],
             account["toolkit"],
             Enum.map(tools, & &1["tool_slug"])
           ) do
      # One finite provider request. Every inner action was checked by the
      # broker before creating this account/tool-restricted session.
      try do
        with :ok <- authorize_effect.() do
          case tools do
            [tool] ->
              SalixStore.Composio.execute_action_session(
                settings,
                session,
                account["id"],
                tool["tool_slug"],
                tool["arguments"]
              )

            _ ->
              SalixStore.Composio.execute_action_batch(settings, session, account["id"], tools)
          end
        end
      after
        _ = SalixStore.Composio.delete_proxy_session(settings, session)
      end
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  def execute(tenant, group, user, %{"mode" => "connect"} = local, tools, authorize_effect) do
    with {:ok, %{"mode" => "connect", "status" => "connected"}} <-
           Access.profile(tenant, group, user),
         {:ok, %{"status" => "ACTIVE"}} <-
           account(tenant, group, user, local["toolkit"], local["id"]),
         {:ok, workflow} <-
           discover(tenant, group, user, "Use " <> Enum.map_join(tools, ", ", & &1["tool_slug"])),
         session when is_binary(session) <- workflow["session_id"] do
      call(
        tenant,
        group,
        user,
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        %{
          "tools" => Enum.map(tools, &Map.put(&1, "account", local["id"])),
          "sync_response_to_workbench" => false,
          "session_id" => session,
          "current_step" => "EXECUTING_APPROVED_ACTION"
        },
        authorize_effect
      )
    else
      {:error, _} = error -> error
      _ -> {:error, :composio_access_denied}
    end
  end

  def execute(_, _, _, _, _, _), do: {:error, :composio_access_denied}

  # Bounded MCP exchanges per UI action. No background per-account poller.
  # Session headers are private transport state, never a credential-mode fallback.
  def schemas(tenant, group, user) do
    with {:ok, result} <- request(tenant, group, user, "tools/list", %{}),
         %{"tools" => tools} when is_list(tools) <- result,
         true <- length(tools) <= 50 do
      {:ok, tools}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  def call(tenant, group, user, name, arguments)
      when name in ~w(COMPOSIO_SEARCH_TOOLS COMPOSIO_GET_TOOL_SCHEMAS COMPOSIO_MANAGE_CONNECTIONS COMPOSIO_WAIT_FOR_CONNECTIONS),
      do: call(tenant, group, user, name, arguments, fn -> :ok end)

  def call(_, _, _, _, _), do: {:error, :composio_tool_not_allowed}

  defp call(tenant, group, user, name, arguments, authorize_effect)
       when name in ~w(COMPOSIO_SEARCH_TOOLS COMPOSIO_GET_TOOL_SCHEMAS COMPOSIO_MANAGE_CONNECTIONS COMPOSIO_WAIT_FOR_CONNECTIONS COMPOSIO_MULTI_EXECUTE_TOOL) do
    with {:ok, result} <-
           request(
             tenant,
             group,
             user,
             "tools/call",
             %{"name" => name, "arguments" => arguments},
             authorize_effect
           ),
         false <- result["isError"] == true do
      with {:ok, decoded} <- decode_result(result),
           false <-
             decoded["successful"] == false or match?(%{"data" => %{"success" => false}}, decoded) do
        {:ok, decoded}
      else
        true -> {:error, :composio_operation_failed}
        error -> error
      end
    else
      true -> {:error, :composio_operation_failed}
      error -> error
    end
  end

  defp call(_, _, _, _, _, _), do: {:error, :composio_tool_not_allowed}

  defp request(tenant, group, user, method, params, authorize_effect \\ fn -> :ok end) do
    with {:ok, headers} <- RemoteMCPOAuth.composio_headers(tenant, group, user),
         {:ok, profile} <- Access.profile(tenant, group, user),
         config = %{"url" => endpoint(), "headers" => headers},
         {:ok, result} <-
           request_session(
             {tenant, group, user},
             config,
             profile,
             method,
             params,
             authorize_effect,
             true
           ) do
      {:ok, result}
    else
      {:error, {:http_error, status, _, _}} when status in [401, 403] ->
        {:error, :composio_reauthorization_required}

      {:error, {:http_error, 429, _, _}} ->
        {:error, :composio_rate_limited}

      {:error, {:http_error, _, _, _}} ->
        {:error, :composio_unavailable}

      {:error, {:request_failed, _}} ->
        {:error, :composio_unavailable}

      {:error, _} = error ->
        error

      _ ->
        {:error, :invalid_composio_response}
    end
  end

  defp request_session(scope, config, profile, method, params, authorize_effect, retry?) do
    with {:ok, headers} <- session(config, profile),
         :ok <- authorize_effect.() do
      case client().request(config, method, params, headers, 15_000) do
        {:ok, result, _} ->
          with {:ok, _} <-
                 update_session(scope, profile, fn current ->
                   # Do not overwrite a session recovered by another request.
                   if current["mcp_session_headers"] == profile["mcp_session_headers"],
                     do: Map.put(current, "mcp_session_headers", headers),
                     else: current
                 end),
               do: {:ok, result}

        {:error, {:http_error, 404, _, _}} = error ->
          if is_binary(headers["mcp-session-id"]) do
            with {:ok, current} <-
                   update_session(scope, profile, fn current ->
                     if current["mcp_session_headers"] == headers,
                       do: Map.delete(current, "mcp_session_headers"),
                       else: current
                   end) do
              # Expired transport sessions are not expired OAuth credentials.
              # Only an explicitly read-only request with a cached session may
              # be repeated once. Effects always return the uncertain failure.
              if retry? and is_map(profile["mcp_session_headers"]) and
                   safe_session_read?(method, params),
                 do:
                   request_session(
                     scope,
                     config,
                     current,
                     method,
                     params,
                     authorize_effect,
                     false
                   ),
                 else: error
            end
          else
            error
          end

        error ->
          error
      end
    end
  end

  defp update_session({tenant, group, user}, profile, change) do
    Access.update_profile(tenant, group, user, fn current ->
      if current["connection_id"] == profile["connection_id"],
        do: {:ok, change.(current)},
        else: {:error, :composio_sign_in_required}
    end)
  end

  defp safe_session_read?("tools/list", _), do: true

  defp safe_session_read?("tools/call", %{"name" => name})
       when name in ~w(COMPOSIO_SEARCH_TOOLS COMPOSIO_GET_TOOL_SCHEMAS), do: true

  defp safe_session_read?("tools/call", %{
         "name" => "COMPOSIO_MANAGE_CONNECTIONS",
         "arguments" => %{"toolkits" => [_ | _] = toolkits}
       }),
       do: Enum.all?(toolkits, &match?(%{"action" => "list"}, &1))

  defp safe_session_read?(_, _), do: false

  defp session(config, profile) do
    case profile["mcp_session_headers"] do
      headers when is_map(headers) ->
        {:ok, headers}

      _ ->
        with {:ok, _, headers} <- client().initialize(config),
             :ok <- client().notify(config, "notifications/initialized", %{}, headers),
             do: {:ok, headers}
    end
  end

  defp decode_result(%{"structuredContent" => content}) when is_map(content), do: {:ok, content}

  defp decode_result(%{"content" => content}) when is_list(content) do
    case Enum.find(content, &(&1["type"] == "text" and is_binary(&1["text"]))) do
      %{"text" => text} ->
        case Jason.decode(text) do
          {:ok, value} when is_map(value) -> {:ok, value}
          _ -> {:error, :invalid_composio_response}
        end

      _ ->
        {:error, :invalid_composio_response}
    end
  end

  defp decode_result(_), do: {:error, :invalid_composio_response}
  defp client, do: Application.get_env(:salix_web, :composio_connect_client, RemoteClient)

  defp endpoint,
    do:
      Application.get_env(
        :salix_web,
        :composio_connect_endpoint,
        "https://connect.composio.dev/mcp"
      )
end
