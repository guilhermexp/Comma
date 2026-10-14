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
    accounts_many(tenant, group, user, [toolkit])
  end

  # A single read for an explicit, bounded batch; never one RPC per account.
  def accounts_many(tenant, group, user, toolkits)
      when is_list(toolkits) and length(toolkits) in 1..100 do
    with {:ok, response} <-
           call(tenant, group, user, "COMPOSIO_MANAGE_CONNECTIONS", %{
             "toolkits" => Enum.map(toolkits, &%{"name" => &1, "action" => "list"})
           }),
         %{"data" => %{"results" => results}} when is_map(results) <- response do
      Enum.reduce_while(toolkits, {:ok, []}, fn toolkit, {:ok, accumulated} ->
        case normalize_accounts(results[toolkit], toolkit) do
          {:ok, accounts} -> {:cont, {:ok, accumulated ++ accounts}}
          error -> {:halt, error}
        end
      end)
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_response}
    end
  end

  defp normalize_accounts(%{"accounts" => accounts}, toolkit)
       when is_list(accounts) and length(accounts) <= 50 do
    Enum.reduce_while(accounts, {:ok, []}, fn
      raw, {:ok, acc} when is_map(raw) ->
        id = raw["id"] || raw["account_id"]
        status = raw["status"]

        if is_binary(id) and byte_size(id) in 1..256 and is_binary(status) and
             (is_nil(raw["alias"]) or is_binary(raw["alias"])) do
          account = %{
            "id" => id,
            "toolkit" => toolkit,
            "name" => account_display_name(raw, toolkit),
            "email" => account_email(raw, toolkit),
            "identity_available" =>
              not is_nil(
                account_label(raw["alias"]) ||
                  account_identity_name(raw, toolkit) || account_email(raw, toolkit)
              ),
            "status" => String.upcase(status),
            "mode" => "connect"
          }

          {:cont, {:ok, [account | acc]}}
        else
          {:halt, {:error, :invalid_composio_response}}
        end

      _, _ ->
        {:halt, {:error, :invalid_composio_response}}
    end)
    |> case do
      {:ok, items} -> {:ok, Enum.reverse(items)}
      error -> error
    end
  end

  defp normalize_accounts(_, _), do: {:error, :invalid_composio_response}

  def account(tenant, group, user, toolkit, id) do
    with {:ok, accounts} <- accounts(tenant, group, user, toolkit) do
      case Enum.find(accounts, &(&1["id"] == id)) do
        nil -> {:error, :composio_account_not_owned}
        account -> {:ok, account}
      end
    end
  end

  defp account_email(%{"user_info" => %{"user" => %{"emailAddress" => email}}}, "googledrive"),
    do: account_label(email)

  defp account_email(%{"user_info" => %{"emailAddress" => email}}, "gmail"),
    do: account_label(email)

  defp account_email(_, _), do: nil

  defp account_identity_name(
         %{"user_info" => %{"user" => %{"displayName" => name}}},
         "googledrive"
       ),
       do: account_label(name)

  defp account_identity_name(_, _), do: nil

  defp account_display_name(raw, toolkit) do
    account_label(raw["alias"]) || account_identity_name(raw, toolkit) ||
      account_email(raw, toolkit) || display_name(toolkit)
  end

  defp account_label(value) when is_binary(value) and byte_size(value) <= 512 do
    case String.trim(value) do
      "" -> nil
      label -> label
    end
  end

  defp account_label(_), do: nil

  def add_account(tenant, group, user, toolkit) do
    with {:ok, response} <-
           call(tenant, group, user, "COMPOSIO_MANAGE_CONNECTIONS", %{
             "toolkits" => [%{"name" => toolkit, "action" => "add"}]
           }),
         %{"data" => %{"results" => results}} <- response,
         result when is_map(result) <- results[toolkit],
         true <- result["status"] in [nil, "initiated"],
         url when is_binary(url) and byte_size(url) > 0 <- result["redirect_url"] do
      # Connect returns account summaries beside a consent link, not an
      # authoritative link-to-account binding. Account selection happens only
      # after the member explicitly chooses an account and we verify that ID.
      {:ok, %{"authorization_url" => url}}
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
  def search(tenant, group, user, account, query, cursor)
      when is_binary(query) and byte_size(query) in 1..500 and
             (is_nil(cursor) or (is_binary(cursor) and byte_size(cursor) <= 4096)) do
    with {:ok, profile} <- Access.profile(tenant, group, user),
         true <- profile["mode"] == account["mode"] and profile["status"] == "connected" do
      case account["mode"] do
        "project" ->
          with {:ok, settings} <- Access.project_settings(tenant, group, user),
               {:ok, page} <-
                 SalixStore.Composio.list_tools_page(settings,
                   toolkit: account["toolkit"],
                   query: query,
                   cursor: cursor,
                   limit: 20
                 ),
               true <- length(page["items"]) <= 20 do
            {:ok,
             %{
               "tools" =>
                 page["items"]
                 |> Enum.filter(&(toolkit_slug(&1) == account["toolkit"] and action?(&1["slug"])))
                 |> Enum.map(&summary/1),
               "next_cursor" => page["next_cursor"]
             }}
          else
            _ -> {:error, :invalid_composio_response}
          end

        "connect" ->
          # Connect search is a bounded task query, not a pageable full catalog.
          with true <- is_nil(cursor),
               {:ok, result} <- discover(tenant, group, user, account["toolkit"] <> ": " <> query) do
            {:ok,
             %{
               "tools" =>
                 result["tools"]
                 |> Enum.filter(&(&1["toolkit"] == account["toolkit"] and action?(&1["slug"])))
                 |> Enum.take(20),
               "next_cursor" => nil
             }}
          else
            _ -> {:error, :invalid_composio_response}
          end
      end
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  def search(_, _, _, _, _, _), do: {:error, :invalid_composio_request}

  @impl true
  def schema(tenant, group, user, account, tools)
      when is_list(tools) and length(tools) in 1..50 do
    with true <- Enum.all?(tools, &action?/1),
         {:ok, profile} <- Access.profile(tenant, group, user),
         true <- profile["mode"] == account["mode"] and profile["status"] == "connected",
         {:ok, items} <- fetch_schemas(tenant, group, user, account, tools),
         true <- length(items) <= 50,
         true <- MapSet.new(Enum.map(items, & &1["slug"])) == MapSet.new(tools),
         true <- Enum.all?(items, &(toolkit_slug(&1) == account["toolkit"])),
         true <- byte_size(Jason.encode!(items)) <= 512_000 do
      {:ok, %{"tools" => items}}
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  def schema(_, _, _, _, _), do: {:error, :composio_access_denied}

  defp fetch_schemas(tenant, group, user, %{"mode" => "project"}, tools) do
    with {:ok, settings} <- Access.project_settings(tenant, group, user),
         do:
           SalixStore.Composio.list_tools(settings, tool_slugs: Enum.join(tools, ","), limit: 50)
  end

  defp fetch_schemas(tenant, group, user, %{"mode" => "connect"}, tools) do
    with {:ok, %{"data" => %{"tool_schemas" => schemas}}} <-
           call(tenant, group, user, "COMPOSIO_GET_TOOL_SCHEMAS", %{"tool_slugs" => tools}),
         true <- is_map(schemas) and map_size(schemas) <= 50,
         true <-
           Enum.all?(schemas, fn {slug, tool} ->
             valid_tool?({slug, tool}) and tool["tool_slug"] == slug
           end) do
      {:ok, Enum.map(schemas, fn {slug, tool} -> Map.put(tool, "slug", slug) end)}
    else
      _ -> {:error, :invalid_composio_response}
    end
  end

  defp toolkit_slug(%{"toolkit" => %{"slug" => slug}}) when is_binary(slug),
    do: String.downcase(slug)

  defp toolkit_slug(%{"toolkit" => slug}) when is_binary(slug), do: String.downcase(slug)
  defp toolkit_slug(_), do: nil

  defp action?(slug) when is_binary(slug),
    do: String.match?(slug, ~r/^[A-Z0-9_]{1,180}$/) and not String.starts_with?(slug, "COMPOSIO_")

  defp action?(_), do: false

  defp summary(tool),
    do: %{
      "slug" => tool["slug"],
      "toolkit" => toolkit_slug(tool),
      "name" => String.slice(tool["name"] || tool["slug"], 0, 180),
      "description" => String.slice(tool["description"] || "", 0, 600)
    }

  @impl true
  def execute(tenant, group, user, %{"mode" => "project"} = account, tools, authorize_effect) do
    execute_project(tenant, group, user, account, tools, authorize_effect, [])
  end

  def execute(tenant, group, user, %{"mode" => "connect"} = local, tools, authorize_effect) do
    with {:ok, _} <- schema(tenant, group, user, local, Enum.map(tools, & &1["tool_slug"])) do
      execute_connect(tenant, group, user, local, tools, authorize_effect, fn result, _session ->
        {:ok, result}
      end)
    end
  end

  def execute(_, _, _, _, _, _), do: {:error, :composio_access_denied}

  defp execute_project(tenant, group, user, account, tools, authorize_effect, opts) do
    with {:ok, _} <- schema(tenant, group, user, account, Enum.map(tools, & &1["tool_slug"])),
         {:ok, %{"mode" => "project", "status" => "connected"}} <-
           Access.profile(tenant, group, user),
         {:ok, settings} <- Access.project_settings(tenant, group, user),
         {:ok, remote} <- SalixStore.Composio.get_connected_account(settings, account["id"]),
         true <-
           remote["user_id"] == "comma:" <> group <> ":" <> user and remote["status"] == "ACTIVE" and
             toolkit_slug(remote) == account["toolkit"],
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
                tool["arguments"],
                opts
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

  # Product-owned online Drive recipe; callers supply no slug, code, URL or session.
  def execute_drive_read(tenant, group, user, account, arguments, authorize_effect, max_bytes) do
    tool = %{"tool_slug" => "GOOGLEDRIVE_FIND_FILE", "arguments" => arguments}

    case account["mode"] do
      "connect" ->
        execute_routine_read(tenant, group, user, account, tool, authorize_effect, max_bytes)

      "project" ->
        execute_project(tenant, group, user, account, [tool], authorize_effect,
          max_response_bytes: max_bytes
        )

      _ ->
        {:error, :composio_access_denied}
    end
  end

  # A complete-result read for incumbent member recipes. Unlike the
  # agent broker this entry accepts no workbench code, file or session input.
  def execute_routine_read(
        tenant,
        group,
        user,
        %{"mode" => "connect"} = local,
        tool,
        authorize_effect,
        max_bytes
      ) do
    execute_connect(tenant, group, user, local, [tool], authorize_effect, fn result, session ->
      alias Salix.Control.ComposioRoutineResult

      case ComposioRoutineResult.prepare(result, session, tool["tool_slug"], max_bytes) do
        {:ok, :inline} ->
          {:ok, result}

        {:ok, arguments} ->
          with {:ok, complete} <-
                 call(
                   tenant,
                   group,
                   user,
                   "COMPOSIO_REMOTE_WORKBENCH",
                   arguments,
                   authorize_effect
                 ) do
            ComposioRoutineResult.complete(complete, session, tool["tool_slug"], max_bytes)
          end

        {:error, _} = error ->
          error
      end
    end)
  end

  defp execute_connect(tenant, group, user, local, tools, authorize_effect, complete) do
    with {:ok, %{"mode" => "connect", "status" => "connected"}} <-
           Access.profile(tenant, group, user),
         {:ok, %{"status" => "ACTIVE"}} <-
           account(tenant, group, user, local["toolkit"], local["id"]),
         {:ok, workflow} <-
           discover(tenant, group, user, "Use " <> Enum.map_join(tools, ", ", & &1["tool_slug"])),
         session when is_binary(session) <- workflow["session_id"],
         {:ok, result} <-
           call(
             tenant,
             group,
             user,
             "COMPOSIO_MULTI_EXECUTE_TOOL",
             %{
               "tools" => Enum.map(tools, &Map.put(&1, "account", local["id"])),
               "sync_response_to_workbench" => false,
               "session_id" => session,
               "current_step" => "EXECUTING_AUTHORIZED_ACTION"
             },
             authorize_effect
           ) do
      complete.(result, session)
    else
      {:error, _} = error -> error
      _ -> {:error, :composio_access_denied}
    end
  end

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
       when name in ~w(COMPOSIO_SEARCH_TOOLS COMPOSIO_GET_TOOL_SCHEMAS COMPOSIO_MANAGE_CONNECTIONS COMPOSIO_WAIT_FOR_CONNECTIONS COMPOSIO_MULTI_EXECUTE_TOOL COMPOSIO_REMOTE_WORKBENCH) do
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
