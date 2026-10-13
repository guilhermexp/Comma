defmodule Salix.Control.ComposioConnectTest do
  use ExUnit.Case, async: false
  alias Salix.Control.{RemoteMCPOAuth, ComposioConnect}
  alias SalixStore.{ComposioAccess, OAuth, S3}

  defmodule Scope do
    def agent_oauth_context(agent) do
      with {:ok, a} <- SalixAgent.Control.get(agent),
           do: {:ok, %{tenant: a["tenant_id"], group_id: a["group_id"]}}
    end
  end

  defmodule Guard do
    def authorize_composio_member(_, _, "member"), do: :ok
    def authorize_composio_member(_, _, _), do: {:error, :denied}

    def run(
          %{"comma_operation" => %{"workspace_id" => "workspace", "user_id" => "member"}},
          write
        ),
        do: write.()

    def run(_, _), do: {:error, "workspace access changed"}
  end

  defmodule Provider do
    @behaviour Plug
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      base = "http://127.0.0.1:#{conn.port}"

      case conn.request_path do
        "/.well-known/oauth-protected-resource" ->
          json(conn, %{"resource" => base <> "/mcp", "authorization_servers" => [base]})

        "/.well-known/oauth-authorization-server" ->
          json(conn, %{
            "issuer" => base,
            "authorization_endpoint" => base <> "/authorize",
            "token_endpoint" => base <> "/token",
            "registration_endpoint" => base <> "/register",
            "token_endpoint_auth_methods_supported" => ["none"],
            "code_challenge_methods_supported" => ["S256"]
          })

        "/register" ->
          {:ok, raw, conn} = read_body(conn)
          body = Jason.decode!(raw)
          Agent.update(state, &Map.update!(&1, :registrations, fn n -> n + 1 end))

          json(conn, %{
            "client_id" => "public-client",
            "redirect_uris" => body["redirect_uris"],
            "token_endpoint_auth_method" => "none"
          })

        "/token" ->
          {:ok, raw, conn} = read_body(conn)
          body = URI.decode_query(raw)
          Agent.update(state, &Map.update!(&1, :exchanges, fn n -> n + 1 end))

          if body["grant_type"] == "refresh_token" && Agent.get(state, & &1.reject_refresh) do
            conn
            |> put_resp_content_type("application/json")
            |> send_resp(400, Jason.encode!(%{"error" => "invalid_grant"}))
          else
            json(conn, %{
              "access_token" => "private-test-access",
              "refresh_token" => "private-test-refresh",
              "expires_in" => 3600,
              "token_type" => "Bearer"
            })
          end

        "/api/" <> _ ->
          Agent.update(
            state,
            &Map.update!(&1, :calls, fn calls -> [{conn.method, conn.request_path} | calls] end)
          )

          case {conn.method, conn.request_path} do
            {"GET", "/api/v3/tools"} ->
              json(conn, %{
                "items" => [
                  %{
                    "slug" => "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
                    "name" => "List repositories",
                    "toolkit" => %{"slug" => "github"}
                  }
                ]
              })

            {"GET", "/api/v3/connected_accounts/selected"} ->
              json(conn, %{
                "id" => "selected",
                "user_id" => "comma:group:member",
                "toolkit" => %{"slug" => "github"},
                "status" => "ACTIVE"
              })

            {"POST", "/api/v3.1/tool_router/session"} ->
              json(conn, %{"session_id" => "prepared"})

            {"DELETE", "/api/v3.1/tool_router/session/prepared"} ->
              json(conn, %{})

            _ ->
              send_resp(conn, 500, "unexpected effect")
          end

        "/mcp" ->
          if get_req_header(conn, "authorization") == ["Bearer private-test-access"] do
            {:ok, raw, conn} = read_body(conn)
            rpc = Jason.decode!(raw)
            session_id = List.first(get_req_header(conn, "mcp-session-id"))

            Agent.update(
              state,
              &Map.update!(&1, :rpc_requests, fn requests ->
                [{rpc["method"], rpc["params"], session_id} | requests]
              end)
            )

            reject = Agent.get(state, & &1.reject_session)

            expired =
              rpc["method"] not in ["initialize", "notifications/initialized"] and
                (reject == :all or (reject == :expired and session_id == "expired") or
                   reject == {:tool, rpc["params"]["name"]})

            if expired do
              send_resp(conn, 404, "expired session")
            else
              case rpc["method"] do
                "notifications/initialized" ->
                  send_resp(conn, 202, "")

                "initialize" ->
                  generation =
                    Agent.get_and_update(state, fn s ->
                      {s.initializations + 1, %{s | initializations: s.initializations + 1}}
                    end)

                  conn = put_resp_header(conn, "mcp-session-id", "session-#{generation}")

                  rpc(conn, rpc, %{
                    "protocolVersion" => "2025-06-18",
                    "capabilities" => %{"tools" => %{}},
                    "serverInfo" => %{"name" => "fixture", "version" => "1"}
                  })

                "tools/list" ->
                  rpc(conn, rpc, %{
                    "tools" => [
                      %{"name" => "COMPOSIO_SEARCH_TOOLS", "inputSchema" => %{"type" => "object"}}
                    ]
                  })

                "tools/call" ->
                  mode = Agent.get(state, & &1.failure)

                  case mode do
                    :none ->
                      params = rpc["params"]

                      Agent.update(
                        state,
                        &Map.update!(&1, :calls, fn calls -> [params | calls] end)
                      )

                      result =
                        Agent.get(
                          state,
                          &Map.get(&1.responses, params["name"], %{"tool" => "GMAIL_FETCH_EMAILS"})
                        )

                      rpc(conn, rpc, %{"structuredContent" => result})

                    :malformed ->
                      rpc(conn, rpc, %{"content" => [%{"type" => "text", "text" => "not json"}]})

                    code ->
                      send_resp(conn, code, "private upstream diagnostic")
                  end
              end
            end
          else
            conn
            |> put_resp_header(
              "www-authenticate",
              "Bearer resource_metadata=\"#{base}/.well-known/oauth-protected-resource\""
            )
            |> send_resp(401, "")
          end

        _ ->
          send_resp(conn, 404, "")
      end
    end

    defp rpc(conn, req, result),
      do: json(conn, %{"jsonrpc" => "2.0", "id" => req["id"], "result" => result})

    defp json(conn, body),
      do: conn |> put_resp_content_type("application/json") |> send_resp(200, Jason.encode!(body))
  end

  setup do
    entries = [
      {:salix_agent, :oauth_store_mod},
      {:salix_agent, :personal_composio_transport},
      {:salix_store, :s3_backend},
      {:salix_store, :composio_base_url_override},
      {:salix_agent, :subscription_storage_key},
      {:salix_web, :composio_connect_endpoint},
      {:salix_web, :comma_oauth_commit_mod},
      {:salix_mcp, :allow_private_http_targets}
    ]

    previous = Enum.map(entries, fn {app, key} -> {app, key, Application.get_env(app, key)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    if Process.whereis(S3.Fake), do: S3.Fake.reset(), else: start_supervised!(S3.Fake)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("s", 32))
    Application.put_env(:salix_web, :comma_oauth_commit_mod, Guard)
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

    state =
      start_supervised!(
        {Agent,
         fn ->
           %{
             initializations: 0,
             rpc_requests: [],
             reject_session: :none,
             registrations: 0,
             exchanges: 0,
             reject_refresh: false,
             failure: :none,
             calls: [],
             responses: %{}
           }
         end}
      )

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_web, :composio_connect_endpoint, "http://127.0.0.1:#{port}/mcp")

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)
    end)

    %{state: state, base: "http://127.0.0.1:#{port}"}
  end

  defp start,
    do: RemoteMCPOAuth.start_composio_authorization("tenant", "group", "member", "workspace")

  defp callback(auth),
    do: RemoteMCPOAuth.handle_callback(%{"state" => auth["state"], "code" => "one-use-code"})

  test "public PKCE login persists encrypted credentials and calls real MCP transport", c do
    assert {:ok, auth} = start()
    query = auth["authorization_url"] |> URI.parse() |> Map.fetch!(:query) |> URI.decode_query()
    assert query["code_challenge_method"] == "S256"
    assert {:page, 200, _} = callback(auth)
    assert {:ok, [_]} = ComposioConnect.schemas("tenant", "group", "member")

    assert {:ok, %{"tool" => "GMAIL_FETCH_EMAILS"}} =
             ComposioConnect.call("tenant", "group", "member", "COMPOSIO_SEARCH_TOOLS", %{})

    refute inspect(S3.Fake.dump()) =~ "private-test-access"
    refute inspect(S3.Fake.dump()) =~ "private-test-refresh"
    assert {:ok, _} = start()
    assert Agent.get(c.state, & &1.registrations) == 1
  end

  defp stale_session(c, rejection) do
    {:ok, _} =
      ComposioAccess.update_profile("tenant", "group", "member", fn profile ->
        {:ok, Map.put(profile, "mcp_session_headers", %{"mcp-session-id" => "expired"})}
      end)

    Agent.update(
      c.state,
      &%{&1 | rpc_requests: [], initializations: 0, reject_session: rejection}
    )
  end

  test "expired MCP sessions recover once for discovery reads without another OAuth exchange",
       c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    reads = [
      fn -> ComposioConnect.schemas("tenant", "group", "member") end,
      fn ->
        ComposioConnect.call("tenant", "group", "member", "COMPOSIO_SEARCH_TOOLS", %{
          "queries" => [%{"use_case" => "list"}]
        })
      end,
      fn ->
        ComposioConnect.call("tenant", "group", "member", "COMPOSIO_GET_TOOL_SCHEMAS", %{
          "tool_slugs" => ["GMAIL_FETCH_EMAILS"]
        })
      end,
      fn ->
        ComposioConnect.call("tenant", "group", "member", "COMPOSIO_MANAGE_CONNECTIONS", %{
          "toolkits" => [%{"name" => "gmail", "action" => "list"}]
        })
      end
    ]

    for read <- reads do
      stale_session(c, :expired)
      assert {:ok, _} = read.()
      assert Agent.get(c.state, & &1.initializations) == 1

      requests =
        Agent.get(c.state, & &1.rpc_requests)
        |> Enum.filter(fn {method, _, _} -> method in ["tools/list", "tools/call"] end)

      assert length(requests) == 2

      assert {:ok, %{"mcp_session_headers" => %{"mcp-session-id" => "session-1"}}} =
               ComposioAccess.profile("tenant", "group", "member")
    end

    assert Agent.get(c.state, & &1.exchanges) == 1
  end

  test "a fresh session returning 404 stops after one recovery and clears only transport state",
       c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)
    stale_session(c, :all)
    assert {:error, :composio_unavailable} = ComposioConnect.schemas("tenant", "group", "member")
    assert Agent.get(c.state, & &1.initializations) == 1
    assert Enum.count(Agent.get(c.state, & &1.rpc_requests), &(elem(&1, 0) == "tools/list")) == 2
    assert {:ok, profile} = ComposioAccess.profile("tenant", "group", "member")
    refute profile["mcp_session_headers"]
    assert profile["status"] == "connected"
  end

  test "session 404 never replays connection mutations, including mixed list/add requests", c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    for actions <- [["add"], ["remove"], ["reinitiate"], ["rename"], ["list", "add"]] do
      stale_session(c, :expired)
      args = %{"toolkits" => Enum.map(actions, &%{"name" => "gmail", "action" => &1})}

      assert {:error, :composio_unavailable} =
               ComposioConnect.call(
                 "tenant",
                 "group",
                 "member",
                 "COMPOSIO_MANAGE_CONNECTIONS",
                 args
               )

      assert [{"tools/call", _, "expired"}] = Agent.get(c.state, & &1.rpc_requests)
      assert Agent.get(c.state, & &1.initializations) == 0
      assert {:ok, profile} = ComposioAccess.profile("tenant", "group", "member")
      refute profile["mcp_session_headers"]
    end
  end

  test "project authorization revoked after session preparation submits no effect and cleans up",
       c do
    Application.put_env(:salix_store, :composio_base_url_override, c.base)

    {:ok, _} =
      ComposioAccess.put_project_settings("tenant", "group", "member", %{"api_key" => "test-key"})

    local = %{"id" => "selected", "toolkit" => "github", "mode" => "project"}

    tools = [
      %{"tool_slug" => "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "arguments" => %{}}
    ]

    assert {:error, :revoked} =
             ComposioConnect.execute("tenant", "group", "member", local, tools, fn ->
               assert {"POST", "/api/v3.1/tool_router/session"} in Agent.get(c.state, & &1.calls)
               {:error, :revoked}
             end)

    assert Enum.reverse(Agent.get(c.state, & &1.calls)) == [
             {"GET", "/api/v3/tools"},
             {"GET", "/api/v3/connected_accounts/selected"},
             {"POST", "/api/v3.1/tool_router/session"},
             {"DELETE", "/api/v3.1/tool_router/session/prepared"}
           ]
  end

  test "an ambiguous profile commit preserves the selected encrypted credential" do
    {:ok, auth} = start()

    profile_key =
      S3.Fake.dump() |> Map.keys() |> Enum.find(&String.ends_with?(&1, "/settings.json"))

    :ok = S3.Fake.set_fault({:ambiguous_after, :put, profile_key})
    assert {:page, 400, _} = callback(auth)

    assert {:ok, %{"status" => "connected", "connection_id" => id}} =
             ComposioAccess.profile("tenant", "group", "member")

    assert {:ok, %{"credential_protection" => "composio_connect"}} = OAuth.get(id)
    assert {:ok, _} = RemoteMCPOAuth.composio_headers("tenant", "group", "member")
  end

  test "cancelled and superseded callbacks never exchange a token", c do
    {:ok, old} = start()
    {:ok, current} = start()
    assert {:page, 400, _} = callback(old)
    {:ok, _} = ComposioAccess.cancel("tenant", "group", "member")
    assert {:page, 400, _} = callback(current)
    assert Agent.get(c.state, & &1.exchanges) == 0

    assert {:ok, %{"status" => "signed_out"}} =
             ComposioAccess.profile("tenant", "group", "member")
  end

  test "expired attempts and wrong state do not bind an identity", c do
    {:ok, auth} = start()

    assert {:page, 400, _} =
             RemoteMCPOAuth.handle_callback(%{"state" => "wrong", "code" => "code"})

    {:ok, _} =
      ComposioAccess.begin_authorization(
        "tenant",
        "group",
        "member",
        auth["state"],
        System.system_time(:millisecond) - 1
      )

    assert {:page, 400, _} = callback(auth)
    assert Agent.get(c.state, & &1.exchanges) == 0
  end

  test "a generic MCP binding cannot use the private consumer credential" do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)
    {:ok, profile} = ComposioAccess.profile("tenant", "group", "member")
    {:ok, record} = OAuth.get(profile["connection_id"])

    {:ok, binding, _} =
      Salix.Control.OAuthBindings.put_remote_mcp(
        "tenant",
        "group",
        record["provider_key"],
        "borrowed",
        profile["connection_id"],
        %{}
      )

    assert {:error, :personal_composio_requires_broker} =
             RemoteMCPOAuth.resolve_headers(%{
               "tenant_id" => "tenant",
               "group_id" => "group",
               "remote_oauth_binding_id" => binding["binding_id"]
             })
  end

  test "rejected refresh changes the private profile to actionable reauthorization", c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)
    {:ok, profile} = ComposioAccess.profile("tenant", "group", "member")
    {:ok, _} = OAuth.update(profile["connection_id"], &{:ok, Map.put(&1, "expires_at", 1)})
    Agent.update(c.state, &Map.put(&1, :reject_refresh, true))

    assert {:error, :composio_reauthorization_required} =
             ComposioConnect.schemas("tenant", "group", "member")

    assert {:ok, %{"status" => "reauthorization_required"}} =
             ComposioAccess.profile("tenant", "group", "member")
  end

  test "discovery returns selectable apps and actions; execution pins every action to one owned account",
       c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    discovery = %{
      "successful" => true,
      "data" => %{
        "toolkit_connection_statuses" => [
          %{"toolkit" => "github", "has_active_connection" => true}
        ],
        "tool_schemas" => %{
          "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER" => %{
            "toolkit" => "GITHUB",
            "description" => "List repositories"
          }
        },
        "session" => %{"id" => "workflow"}
      }
    }

    account_list = %{
      "successful" => true,
      "data" => %{
        "results" => %{
          "github" => %{
            "accounts" => [
              %{"id" => "selected", "alias" => "Work GitHub", "status" => "ACTIVE"},
              %{"id" => "sibling", "status" => "ACTIVE"}
            ]
          }
        }
      }
    }

    Agent.update(
      c.state,
      &%{
        &1
        | responses: %{
            "COMPOSIO_SEARCH_TOOLS" => discovery,
            "COMPOSIO_GET_TOOL_SCHEMAS" => %{
              "successful" => true,
              "data" => %{
                "success" => true,
                "tool_schemas" => %{
                  "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER" => %{
                    "toolkit" => "github",
                    "tool_slug" => "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
                    "input_schema" => %{"type" => "object"}
                  }
                }
              }
            },
            "COMPOSIO_MANAGE_CONNECTIONS" => account_list,
            "COMPOSIO_MULTI_EXECUTE_TOOL" => %{"successful" => true, "data" => %{"results" => []}}
          }
      }
    )

    assert {:ok, %{"items" => [%{"name" => "Github", "tools" => [tool]}]}} =
             ComposioConnect.discover("tenant", "group", "member", "List GitHub repositories")

    assert tool["slug"] == "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER"

    refute Enum.any?(
             Agent.get(c.state, & &1.calls),
             &(&1["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL")
           )

    actions = [%{"tool_slug" => tool["slug"], "arguments" => %{"per_page" => 1}}]
    local = %{"id" => "selected", "toolkit" => "github", "mode" => "connect"}

    assert {:ok, _} =
             ComposioConnect.execute("tenant", "group", "member", local, actions, fn -> :ok end)

    executions =
      Agent.get(
        c.state,
        &Enum.filter(&1.calls, fn call -> call["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL" end)
      )

    assert [execution] = executions
    assert execution["arguments"]["tools"] == [Map.put(hd(actions), "account", "selected")]
    assert execution["arguments"]["sync_response_to_workbench"] == false

    # Authorization is checked after provider preparation, before the effect.
    calls_before = length(Agent.get(c.state, & &1.calls))

    assert {:error, :revoked} =
             ComposioConnect.execute("tenant", "group", "member", local, actions, fn ->
               assert length(Agent.get(c.state, & &1.calls)) > calls_before
               {:error, :revoked}
             end)

    stale_session(c, {:tool, "COMPOSIO_MULTI_EXECUTE_TOOL"})

    assert {:error, :composio_unavailable} =
             ComposioConnect.execute("tenant", "group", "member", local, actions, fn -> :ok end)

    assert Enum.count(Agent.get(c.state, & &1.rpc_requests), fn {_, params, _} ->
             params["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL"
           end) == 1

    assert Agent.get(c.state, & &1.initializations) == 0
    Agent.update(c.state, &%{&1 | reject_session: :none})

    assert {:error, :composio_account_not_owned} =
             ComposioConnect.execute(
               "tenant",
               "group",
               "member",
               Map.put(local, "id", "foreign"),
               actions,
               fn -> :ok end
             )

    assert length(
             Agent.get(
               c.state,
               &Enum.filter(&1.calls, fn call -> call["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL" end)
             )
           ) == 1
  end

  test "authorized account search, schema, exact confirmation and HTTP dispatch preserve isolation and revocation",
       c do
    alias SalixAgent.{ComposioBroker, CapabilityRequests}
    alias SalixStore.Ids
    tenant = SalixAgent.TestSupport.new_tenant_id()
    group = Ids.new_group_id(tenant)

    agent =
      SalixAgent.TestSupport.create_control_agent_in_group!(tenant, group, %{
        "role" => "router",
        "runtime_config" => %{"kind" => "internal"}
      })

    Application.put_env(:salix_agent, :oauth_store_mod, Scope)
    Application.put_env(:salix_agent, :personal_composio_transport, ComposioConnect)

    {:ok, auth} =
      RemoteMCPOAuth.start_composio_authorization(tenant, group, "member", "workspace")

    assert {:page, 200, _} = callback(auth)

    ctx = %{
      agent_id: agent["agent_id"],
      session_id: Ids.new_session_id(),
      tool_call_id: "new-action"
    }

    account = %{
      "id" => "selected",
      "toolkit" => "gmail",
      "mode" => "connect",
      "status" => "ACTIVE",
      "name" => "Work"
    }

    {:ok, _} = ComposioAccess.put_account(tenant, group, "member", "selected", account)
    {:ok, _} = ComposioAccess.grant(tenant, group, "member", "selected", ctx.agent_id, true)

    definition = %{
      "toolkit" => "gmail",
      "tool_slug" => "GMAIL_LIST_LABELS",
      "input_schema" => %{"type" => "object"}
    }

    schemas = %{"GMAIL_LIST_LABELS" => definition}

    search_schemas =
      Map.merge(schemas, %{
        "GMAIL_SPOOFED" => %{"toolkit" => "github", "tool_slug" => "GMAIL_SPOOFED"},
        "COMPOSIO_REMOTE_BASH_TOOL" => %{
          "toolkit" => "gmail",
          "tool_slug" => "COMPOSIO_REMOTE_BASH_TOOL"
        }
      })

    Agent.update(
      c.state,
      &%{
        &1
        | responses: %{
            "COMPOSIO_SEARCH_TOOLS" => %{
              "successful" => true,
              "data" => %{
                "toolkit_connection_statuses" => [%{"toolkit" => "gmail"}],
                "tool_schemas" => search_schemas,
                "session" => %{"id" => "workflow"}
              }
            },
            "COMPOSIO_GET_TOOL_SCHEMAS" => %{
              "successful" => true,
              "data" => %{"success" => true, "tool_schemas" => schemas}
            },
            "COMPOSIO_MANAGE_CONNECTIONS" => %{
              "successful" => true,
              "data" => %{
                "results" => %{
                  "gmail" => %{"accounts" => [%{"id" => "selected", "status" => "ACTIVE"}]}
                }
              }
            },
            "COMPOSIO_MULTI_EXECUTE_TOOL" => %{
              "successful" => true,
              "data" => %{"results" => [%{"successful" => true}]}
            }
          }
      }
    )

    assert %{"tools" => [%{"slug" => "GMAIL_LIST_LABELS"}], "next_cursor" => nil} =
             ComposioBroker.search(%{"account_id" => "selected", "query" => "list labels"}, ctx)
             |> Jason.decode!()

    assert %{"tools" => [%{"input_schema" => _}]} =
             ComposioBroker.schema(
               %{"account_id" => "selected", "tool_slugs" => ["GMAIL_LIST_LABELS"]},
               ctx
             )
             |> Jason.decode!()

    action = %{
      "account_id" => "selected",
      "tools" => [%{"tool_slug" => "GMAIL_LIST_LABELS", "arguments" => %{"limit" => 1}}]
    }

    {pending, _} = ComposioBroker.execute(action, ctx)
    id = Jason.decode!(pending)["request_id"]

    assert Enum.all?(
             Agent.get(c.state, & &1.calls),
             &(&1["name"] != "COMPOSIO_MULTI_EXECUTE_TOOL")
           )

    assert {:error, :not_found} =
             CapabilityRequests.decide_composio(group, id, tenant, "other-member", true)

    assert {:ok, done} = CapabilityRequests.decide_composio(group, id, tenant, "member", true)
    refute done["result"]["error"]

    [execution] =
      Agent.get(
        c.state,
        &Enum.filter(&1.calls, fn call -> call["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL" end)
      )

    assert execution["arguments"]["tools"] == [
             Map.put(hd(action["tools"]), "account", "selected")
           ]

    assert {:error, {:conflict, :already_settled}} =
             CapabilityRequests.decide_composio(group, id, tenant, "member", true)

    {pending, _} = ComposioBroker.execute(action, %{ctx | tool_call_id: "revoked-action"})
    {:ok, _} = ComposioAccess.grant(tenant, group, "member", "selected", ctx.agent_id, false)

    assert {:ok, denied} =
             CapabilityRequests.decide_composio(
               group,
               Jason.decode!(pending)["request_id"],
               tenant,
               "member",
               true
             )

    assert denied["result"]["error"]

    assert_raise RuntimeError, fn ->
      ComposioBroker.search(%{"account_id" => "selected", "query" => "list"}, ctx)
    end

    {:ok, _} = ComposioAccess.grant(tenant, group, "member", "selected", ctx.agent_id, true)
    {mode_pending, _} = ComposioBroker.execute(action, %{ctx | tool_call_id: "mode-change"})

    {:ok, _} =
      ComposioAccess.put_project_settings(tenant, group, "member", %{
        "api_key" => "fixture-project-key"
      })

    assert {:ok, mode_denied} =
             CapabilityRequests.decide_composio(
               group,
               Jason.decode!(mode_pending)["request_id"],
               tenant,
               "member",
               true
             )

    assert mode_denied["result"]["error"]

    {:ok, _} =
      ComposioAccess.update_profile(
        tenant,
        group,
        "member",
        &{:ok, Map.put(&1, "mode", "connect")}
      )

    # A Gmail-looking slug authoritatively owned by GitHub cannot cross toolkits.
    foreign = %{"toolkit" => "github", "tool_slug" => "GMAIL_SPOOFED", "input_schema" => %{}}

    Agent.update(c.state, fn state ->
      put_in(
        state,
        [:responses, "COMPOSIO_GET_TOOL_SCHEMAS", "data", "tool_schemas"],
        Map.put(schemas, "GMAIL_SPOOFED", foreign)
      )
    end)

    mixed =
      Map.update!(
        action,
        "tools",
        &(&1 ++ [%{"tool_slug" => "GMAIL_SPOOFED", "arguments" => %{}}])
      )

    assert_raise RuntimeError, fn -> ComposioBroker.execute(mixed, ctx) end

    assert_raise RuntimeError, fn ->
      ComposioBroker.schema(%{"account_id" => "selected", "tool_slugs" => ["GMAIL_SPOOFED"]}, ctx)
    end

    assert_raise RuntimeError, fn ->
      ComposioBroker.execute(%{action | "account_id" => "sibling"}, ctx)
    end

    assert_raise RuntimeError, fn ->
      ComposioBroker.execute(
        %{
          action
          | "tools" => [%{"tool_slug" => "COMPOSIO_REMOTE_WORKBENCH", "arguments" => %{}}]
        },
        ctx
      )
    end

    assert Enum.count(
             Agent.get(c.state, & &1.calls),
             &(&1["name"] == "COMPOSIO_MULTI_EXECUTE_TOOL")
           ) == 1
  end

  test "a successful remove envelope does not claim remote revocation while the exact account remains",
       c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    Agent.update(
      c.state,
      &%{
        &1
        | responses: %{
            "COMPOSIO_MANAGE_CONNECTIONS" => %{
              "successful" => true,
              "data" => %{
                "results" => %{
                  "github" => %{
                    "accounts" => [%{"id" => "selected", "status" => "ACTIVE"}]
                  }
                }
              }
            }
          }
      }
    )

    assert {:error, :composio_disconnect_unconfirmed} =
             ComposioConnect.remove_account("tenant", "group", "member", "github", "selected")

    removals =
      Agent.get(
        c.state,
        &Enum.filter(&1.calls, fn call ->
          get_in(call, ["arguments", "toolkits"]) == [
            %{"name" => "github", "action" => "remove", "account_id" => "selected"}
          ]
        end)
      )

    assert length(removals) == 1
  end

  test "provider-level failures and malformed discovery do not become successful selections", c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    Agent.update(
      c.state,
      &%{
        &1
        | responses: %{
            "COMPOSIO_SEARCH_TOOLS" => %{
              "successful" => false,
              "error" => "private diagnostic"
            }
          }
      }
    )

    assert {:error, :composio_operation_failed} =
             ComposioConnect.discover("tenant", "group", "member", "tasks")

    Agent.update(
      c.state,
      &%{
        &1
        | responses: %{
            "COMPOSIO_SEARCH_TOOLS" => %{
              "data" => %{
                "toolkit_connection_statuses" => [42],
                "tool_schemas" => %{}
              }
            }
          }
      }
    )

    assert {:error, :invalid_composio_response} =
             ComposioConnect.discover("tenant", "group", "member", "tasks")
  end

  test "rate limits, scope denial, outages and malformed MCP responses are errors", c do
    {:ok, auth} = start()
    assert {:page, 200, _} = callback(auth)

    for {mode, error} <- [
          {429, :composio_rate_limited},
          {403, :composio_reauthorization_required},
          {503, :composio_unavailable},
          {:malformed, :invalid_composio_response}
        ] do
      Agent.update(c.state, &Map.put(&1, :failure, mode))

      assert {:error, ^error} =
               ComposioConnect.call("tenant", "group", "member", "COMPOSIO_SEARCH_TOOLS", %{})
    end

    for tool <-
          ~w(COMPOSIO_REMOTE_BASH_TOOL COMPOSIO_REMOTE_WORKBENCH COMPOSIO_MULTI_EXECUTE_TOOL) do
      assert {:error, :composio_tool_not_allowed} =
               ComposioConnect.call("tenant", "group", "member", tool, %{})
    end
  end

  test "Routine complete-result decoding rejects compressed expansion, corruption and partial output" do
    alias Salix.Control.ComposioRoutineResult, as: Result
    slug = "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"
    raw = Jason.encode!(%{"messages" => [%{"snippet" => "完整内容"}]})

    packet = %{
      "complete" => true,
      "tool_slug" => slug,
      "encoding" => "zlib-base64",
      "raw_bytes" => byte_size(raw),
      "payload" => Base.encode64(:zlib.compress(raw))
    }

    envelope = fn packet ->
      %{
        "successful" => true,
        "data" => %{
          "session" => %{"id" => "workflow"},
          "stdout" => Jason.encode!(packet),
          "stderr" => "",
          "results" => ""
        }
      }
    end

    assert {:ok, _} = Result.complete(envelope.(packet), "workflow", slug, 512_000)
    huge = Base.encode64(:zlib.compress(String.duplicate("x", 1_000_000)))

    for invalid <- [
          Map.put(packet, "payload", huge),
          Map.put(packet, "payload", "!"),
          Map.put(packet, "payload", nil),
          Map.put(packet, "payload", Base.encode64(<<120, 156>>)),
          Map.put(packet, "raw_bytes", 1),
          Map.put(packet, "complete", false),
          Map.put(packet, "tool_slug", "OTHER")
        ] do
      assert {:error, _} = Result.complete(envelope.(invalid), "workflow", slug, 512_000)
    end

    for field <- ~w(stdout_file_path stderr_file_path results_file_path error stderr) do
      partial = put_in(envelope.(packet), ["data", field], "untrusted")
      assert {:error, _} = Result.complete(partial, "workflow", slug, 512_000)
    end

    assert {:error, _} = Result.complete(envelope.(packet), "foreign", slug, 512_000)
  end
end
