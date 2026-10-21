defmodule Salix.Control.ComposioCalendarTest do
  use ExUnit.Case, async: false
  alias Salix.Control.ComposioConnect
  alias SalixStore.{ComposioAccess, OAuth, S3}

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(%{request_path: "/api/" <> _} = conn, state) do
      {:ok, raw, conn} = read_body(conn)
      body = if raw == "", do: %{}, else: Jason.decode!(raw)

      Agent.update(
        state,
        &Map.update!(&1, :requests, fn r -> [{conn.request_path, body} | r] end)
      )

      result =
        case conn.request_path do
          "/api/v3/tools" ->
            %{
              "items" =>
                Enum.map(
                  String.split(URI.decode_query(conn.query_string)["tool_slugs"], ","),
                  &%{"slug" => &1, "toolkit" => %{"slug" => "googlecalendar"}}
                ),
              "next_cursor" => nil
            }

          "/api/v3/connected_accounts/cal" ->
            %{
              "id" => "cal",
              "status" => "ACTIVE",
              "user_id" => "comma:group:member",
              "toolkit" => %{"slug" => "googlecalendar"}
            }

          "/api/v3.1/tool_router/session" ->
            %{"session_id" => "project-session"}

          "/api/v3.1/tool_router/session/project-session/execute" ->
            Agent.get(state, & &1.response)

          "/api/v3.1/tool_router/session/project-session" ->
            %{}
        end

      conn |> put_resp_content_type("application/json") |> send_resp(200, Jason.encode!(result))
    end

    def call(conn, state) do
      {:ok, raw, conn} = read_body(conn)
      request = Jason.decode!(raw)
      Agent.update(state, &Map.update!(&1, :requests, fn r -> [{"/mcp", request} | r] end))
      params = request["params"]

      result =
        case params["name"] do
          "COMPOSIO_MANAGE_CONNECTIONS" ->
            %{
              "data" => %{
                "results" => %{
                  "googlecalendar" => %{"accounts" => [%{"id" => "cal", "status" => "ACTIVE"}]}
                }
              }
            }

          "COMPOSIO_SEARCH_TOOLS" ->
            %{
              "data" => %{
                "toolkit_connection_statuses" => [],
                "tool_schemas" => %{},
                "session" => %{"id" => "read-session"}
              }
            }

          "COMPOSIO_MULTI_EXECUTE_TOOL" ->
            [tool] = params["arguments"]["tools"]
            response = Agent.get(state, & &1.response)

            %{
              "successful" => response["successful"],
              "data" => %{
                "results" => [
                  %{"tool_slug" => tool["tool_slug"], "index" => 0, "response" => response}
                ]
              }
            }
        end

      conn
      |> put_resp_content_type("application/json")
      |> send_resp(
        200,
        Jason.encode!(%{
          "jsonrpc" => "2.0",
          "id" => request["id"],
          "result" => %{"structuredContent" => result}
        })
      )
    end
  end

  setup do
    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :subscription_storage_key},
      {:salix_store, :composio_base_url_override},
      {:salix_web, :composio_connect_endpoint},
      {:salix_mcp, :allow_private_http_targets}
    ]

    previous = Enum.map(entries, fn {a, k} -> {a, k, Application.get_env(a, k)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    if Process.whereis(S3.Fake), do: S3.Fake.reset(), else: start_supervised!(S3.Fake)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("c", 32))

    state =
      start_supervised!(
        {Agent,
         fn ->
           %{
             requests: [],
             response: %{"successful" => true, "data" => %{"id" => "e1", "etag" => "\"1\""}}
           }
         end}
      )

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_store, :composio_base_url_override, "http://127.0.0.1:#{port}")
    Application.put_env(:salix_web, :composio_connect_endpoint, "http://127.0.0.1:#{port}/mcp")
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

    :ok =
      OAuth.put("calendar-connect", %{
        "tenant" => "tenant",
        "group_id" => "group",
        "composio_user_id" => "member",
        "credential_protection" => "composio_connect",
        "access_token" => "private-connect-token",
        "expires_at" => System.system_time(:millisecond) + 600_000
      })

    {:ok, _} =
      ComposioAccess.update_profile("tenant", "group", "member", fn profile ->
        {:ok,
         Map.merge(profile, %{
           "mode" => "connect",
           "status" => "connected",
           "connection_id" => "calendar-connect",
           "mcp_session_headers" => %{"mcp-session-id" => "fixture-session"}
         })}
      end)

    {:ok, account} = put_account("connect")

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)
    end)

    %{provider: state, account: account}
  end

  defp put_account(mode) do
    ComposioAccess.put_account("tenant", "group", "member", "cal", %{
      "toolkit" => "googlecalendar",
      "name" => "Member",
      "status" => "ACTIVE",
      "mode" => mode
    })
  end

  defp read(account, operation, arguments),
    do:
      ComposioConnect.execute_calendar_read(
        "tenant",
        "group",
        "member",
        account,
        operation,
        arguments,
        fn -> :ok end
      )

  defp write(account, operation, arguments),
    do:
      ComposioConnect.execute_calendar_write(
        "tenant",
        "group",
        "member",
        account,
        operation,
        arguments,
        fn -> :ok end
      )

  defp dispatched(c),
    do:
      Agent.get(c.provider, & &1.requests)
      |> Enum.flat_map(fn
        {"/mcp", %{"params" => %{"name" => "COMPOSIO_MULTI_EXECUTE_TOOL"} = p}} ->
          p["arguments"]["tools"]

        {"/api/v3.1/tool_router/session/project-session/execute", body} ->
          [body]

        _ ->
          []
      end)

  test "operations outside the fixed recipe and slugs from callers never dispatch", c do
    assert {:error, :invalid_composio_request} = read(c.account, "acl_insert", %{})
    assert {:error, :invalid_composio_request} = write(c.account, "events", %{})
    assert {:error, :invalid_composio_request} = read(c.account, "GOOGLECALENDAR_ACL_INSERT", %{})
    assert {:error, :invalid_composio_request} = write(c.account, "create", "raw")
    assert dispatched(c) == []
  end

  test "connect mode pins the fixed slug to the member account and returns tool data", c do
    assert {:ok, %{"id" => "e1"}} =
             read(c.account, "event", %{"calendar_id" => "primary", "event_id" => "e1"})

    assert [
             %{
               "tool_slug" => "GOOGLECALENDAR_EVENTS_GET",
               "account" => "cal",
               "arguments" => %{"calendar_id" => "primary", "event_id" => "e1"}
             }
           ] = dispatched(c)
  end

  test "project mode uses a session restricted to the fixed write slug", c do
    {:ok, _} =
      ComposioAccess.put_project_settings("tenant", "group", "member", %{"api_key" => "key"})

    {:ok, _} =
      ComposioAccess.update_profile("tenant", "group", "member", fn p ->
        {:ok, Map.put(p, "mode", "project")}
      end)

    {:ok, account} = put_account("project")

    assert {:ok, _} =
             write(account, "delete", %{"calendar_id" => "primary", "event_id" => "e1"})

    requests = Agent.get(c.provider, & &1.requests)
    {_, session} = Enum.find(requests, &(elem(&1, 0) == "/api/v3.1/tool_router/session"))

    assert session["tools"] == %{
             "googlecalendar" => %{"enable" => ["GOOGLECALENDAR_DELETE_EVENT"]}
           }

    assert [%{"tool_slug" => "GOOGLECALENDAR_DELETE_EVENT", "account" => "cal"}] = dispatched(c)
    refute Enum.any?(requests, &(elem(&1, 0) == "/mcp"))
  end

  test "unknown modes and other toolkits are denied before dispatch", c do
    for account <- [
          Map.put(c.account, "mode", "legacy"),
          Map.delete(c.account, "mode"),
          Map.put(c.account, "toolkit", "googledrive")
        ] do
      assert {:error, :composio_access_denied} =
               read(account, "event", %{"calendar_id" => "primary", "event_id" => "e1"})
    end

    assert dispatched(c) == []
  end

  test "Google permission refusals are classified without exposing provider text", c do
    Agent.update(c.provider, fn s ->
      %{
        s
        | response: %{
            "successful" => false,
            "error" => "403 insufficientPermissions: Bearer private-connect-token"
          }
      }
    end)

    assert {:error, :provider_forbidden} =
             write(c.account, "delete", %{"calendar_id" => "primary", "event_id" => "e1"})

    Agent.update(c.provider, fn s ->
      %{s | response: %{"successful" => false, "error" => "404 Not Found"}}
    end)

    assert {:error, :provider_not_found} =
             read(c.account, "event", %{"calendar_id" => "primary", "event_id" => "e1"})

    Agent.update(c.provider, fn s ->
      %{s | response: %{"successful" => false, "error" => "backend exploded"}}
    end)

    assert {:error, :provider_failed} =
             read(c.account, "event", %{"calendar_id" => "primary", "event_id" => "e1"})
  end
end
