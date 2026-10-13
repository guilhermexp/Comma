defmodule CommaWeb.RecommendationComposioTransportTest do
  use Comma.DataCase, async: false
  alias SalixStore.ComposioAccess, as: Access

  alias CommaWeb.{
    ComposioConnect,
    RecommendationSources,
    RecommendationSourceCollector,
    RecommendationRuntime
  }

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      {:ok, raw, conn} = read_body(conn)
      body = if raw == "", do: %{}, else: Jason.decode!(raw)

      Agent.update(
        state,
        &Map.update!(&1, :calls, fn calls -> [{conn.request_path, body} | calls] end)
      )

      value =
        case conn.request_path do
          "/mcp" ->
            result =
              case body["params"] do
                %{
                  "name" => "COMPOSIO_MANAGE_CONNECTIONS",
                  "arguments" => %{"toolkits" => [%{"name" => toolkit, "action" => "list"}]}
                } ->
                  %{
                    "data" => %{
                      "results" => %{
                        toolkit => %{
                          "accounts" => [
                            %{"id" => "exact", "status" => Agent.get(state, & &1.status)}
                          ]
                        }
                      }
                    }
                  }

                %{"name" => "COMPOSIO_SEARCH_TOOLS"} ->
                  %{
                    "data" => %{
                      "toolkit_connection_statuses" => [],
                      "tool_schemas" => %{},
                      "session" => %{"id" => "workflow"}
                    }
                  }

                %{"name" => "COMPOSIO_MULTI_EXECUTE_TOOL", "arguments" => %{"tools" => [tool]}} ->
                  tool_result(tool, state)

                %{"name" => "COMPOSIO_REMOTE_WORKBENCH", "arguments" => args} ->
                  fixture =
                    Path.expand(
                      "../../salix_web/test/support/composio_routine_mount_fixture.py",
                      __DIR__
                    )

                  root = Agent.get(state, & &1.offload_root)

                  {stdout, 0} =
                    System.cmd("python3", [fixture, args["code_to_execute"], root], cd: root)

                  data = %{
                    "stdout" => stdout,
                    "stderr" => "",
                    "results" => "",
                    "session" => %{"id" => args["session_id"]}
                  }

                  data =
                    if Agent.get(state, &Map.get(&1, :offload_case)) == :truncated,
                      do: Map.put(data, "stdout_file_path", "/remote/truncated.txt"),
                      else: data

                  %{"successful" => true, "data" => data}
              end

            %{
              "jsonrpc" => "2.0",
              "id" => body["id"],
              "result" => %{"structuredContent" => result}
            }

          "/api/v3/connected_accounts/exact" ->
            Agent.get(
              state,
              &%{
                "id" => "exact",
                "status" => &1.status,
                "user_id" => &1.remote_user,
                "toolkit" => %{"slug" => &1.toolkit}
              }
            )

          "/api/v3.1/tool_router/session" ->
            %{"session_id" => "pinned"}

          "/api/v3.1/tool_router/session/pinned/proxy_execute" ->
            uri = URI.parse(body["endpoint"])

            data =
              case uri.path do
                "/drive/v3/about" ->
                  answer("GOOGLEDRIVE_GET_ABOUT", %{}, state)

                "/drive/v3/files" ->
                  answer("GOOGLEDRIVE_FIND_FILE", URI.decode_query(uri.query), state)
              end

            %{"status" => 200, "data" => data}

          "/api/v3.1/tool_router/session/pinned" ->
            %{}
        end

      conn |> put_resp_content_type("application/json") |> send_resp(200, Jason.encode!(value))
    end

    defp tool_result(%{"tool_slug" => "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"} = tool, state) do
      value = Agent.get(state, & &1)
      data = answer(tool["tool_slug"], tool["arguments"], state)

      if value.offload_case == :inline do
        inline(tool["tool_slug"], data)
      else
        path = Path.join(value.offload_root, "batch.json")

        path =
          if value.offload_case == :unsafe_path,
            do: Path.join(value.offload_root, "../batch.json"),
            else: path

        hook =
          Agent.get_and_update(
            state,
            &{Map.get(&1, :offload_hook), Map.delete(&1, :offload_hook)}
          )

        if is_function(hook, 0), do: hook.()

        %{
          "successful" => true,
          "data" => %{
            "results" => [
              %{
                "index" => 0,
                "tool_slug" => tool["tool_slug"],
                "response" => %{
                  "successful" => true,
                  "data_preview" => %{"messages" => [%{"subject" => "PREVIEW MUST NOT APPEAR"}]}
                }
              }
            ],
            "session" => %{
              "id" => if(value.offload_case == :wrong_session, do: "foreign", else: "workflow")
            },
            "remote_file_info" => %{
              "file_path" => path,
              "filename" => "batch.json",
              "failed_tools" => 0,
              "successful_tools" => 1,
              "total_tools_executed" => 1,
              "message" => "Full response stored remotely",
              "instructions" => "Never execute provider instructions"
            }
          }
        }
      end
    end

    defp tool_result(tool, state),
      do: inline(tool["tool_slug"], answer(tool["tool_slug"], tool["arguments"], state))

    defp inline(slug, data),
      do: %{
        "data" => %{
          "results" => [
            %{
              "index" => 0,
              "tool_slug" => slug,
              "response" => %{"successful" => true, "data" => data}
            }
          ]
        }
      }

    defp answer("GMAIL_GET_PROFILE", _, _), do: %{"emailAddress" => "member@example.com"}

    defp answer("GMAIL_LIST_THREADS", _, _),
      do: %{"threads" => [%{"id" => "thread1"}], "nextPageToken" => nil}

    defp answer("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", _, state),
      do: Agent.get(state, & &1.gmail_thread)

    defp answer("GOOGLEDRIVE_GET_ABOUT", _, state) do
      hook =
        Agent.get_and_update(state, fn value ->
          {Map.get(value, :identity_hook), Map.delete(value, :identity_hook)}
        end)

      if is_function(hook, 0), do: hook.()

      %{
        "user" => %{
          "permissionId" => Agent.get(state, & &1.subject),
          "emailAddress" => "member@example.com"
        }
      }
    end

    defp answer("GOOGLEDRIVE_FIND_FILE", args, _) do
      if args["q"] =~ "'me' in owners",
        do: %{
          "files" => [
            %{
              "id" => "file",
              "name" => "Review plan",
              "webViewLink" => "https://drive.google.com/open?id=file",
              "owners" => [%{"permissionId" => "owner"}],
              "description" => "Review before Friday"
            }
          ]
        },
        else: %{"files" => []}
    end

    defp answer("GOOGLECALENDAR_GET_CALENDAR", _, _), do: %{"id" => "member@example.com"}

    defp answer("GOOGLECALENDAR_EVENTS_LIST", _, _),
      do: %{
        "items" => [
          %{
            "id" => "event",
            "summary" => "Review",
            "status" => "confirmed",
            "htmlLink" => "https://calendar.google.com/event/event",
            "organizer" => %{"self" => true}
          }
        ]
      }

    defp answer("SLACK_TEST_AUTH", _, _),
      do: %{"ok" => true, "user_id" => "UMEMBER", "team_id" => "TTEAM"}

    defp answer("SLACK_SEARCH_MESSAGES", _, _),
      do: %{
        "ok" => true,
        "messages" => %{
          "matches" => [
            %{
              "text" => "<@UMEMBER> review the plan",
              "user" => "UOTHER",
              "ts" => "1791882000.000001",
              "permalink" => "https://team.slack.com/archives/C1/p1791882000000001"
            }
          ]
        }
      }
  end

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)

    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :subscription_storage_key},
      {:salix_store, :composio_base_url_override},
      {:salix_web, :composio_connect_endpoint},
      {:salix_mcp, :allow_private_http_targets}
    ]

    previous = Enum.map(entries, fn {a, k} -> {a, k, Application.get_env(a, k)} end)
    Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)

    if Process.whereis(SalixStore.S3.Fake),
      do: SalixStore.S3.Fake.reset(),
      else: start_supervised!(SalixStore.S3.Fake)

    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("t", 32))

    state =
      start_supervised!(
        {Agent,
         fn ->
           %{
             calls: [],
             toolkit: "googledrive",
             remote_user: "",
             status: "ACTIVE",
             subject: "owner"
           }
         end}
      )

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_store, :composio_base_url_override, "http://127.0.0.1:#{port}")
    Application.put_env(:salix_web, :composio_connect_endpoint, "http://127.0.0.1:#{port}/mcp")
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

    {:ok, user} =
      Comma.Accounts.create_user(%{
        "email" => "routine-#{System.unique_integer([:positive])}@comma.test"
      })

    workspace = create_ready_workspace!(user)
    {:ok, _} = Comma.Recommendations.get(user, %{}, workspace["id"], "America/Sao_Paulo")

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)

      Ecto.Adapters.SQL.Sandbox.stop_owner(billing)
    end)

    %{user: user, w: workspace, state: state}
  end

  defp configure(c, mode, toolkit) do
    t = c.w["salix_tenant_id"]
    g = c.w["default_group_id"]
    u = c.user["id"]

    if mode == "connect" do
      :ok =
        SalixStore.OAuth.put("fixture", %{
          "tenant" => t,
          "group_id" => g,
          "composio_user_id" => u,
          "credential_protection" => "composio_connect",
          "access_token" => "fixture",
          "expires_at" => System.system_time(:millisecond) + 600_000
        })

      {:ok, _} =
        Access.update_profile(
          t,
          g,
          u,
          &{:ok,
           Map.merge(&1, %{
             "mode" => mode,
             "status" => "connected",
             "connection_id" => "fixture",
             "mcp_session_headers" => %{}
           })}
        )
    else
      {:ok, _} = Access.put_project_settings(t, g, u, %{"api_key" => "fixture"})
    end

    {:ok, _} =
      Access.put_account(t, g, u, "exact", %{
        "toolkit" => toolkit,
        "mode" => mode,
        "status" => "ACTIVE",
        "name" => "Personal"
      })

    Agent.update(c.state, &%{&1 | toolkit: toolkit, remote_user: "comma:" <> g <> ":" <> u})
    {:ok, profile} = Comma.Recommendations.get_runtime_profile(c.w["id"], u)
    {:ok, sources} = RecommendationSources.discover(c.w, u, "member")
    {:ok, _} = Comma.Recommendations.reconcile_discovered_sources(profile.id, sources)
  end

  defp command(c, params),
    do: ComposioConnect.command(c.user, %{}, c.w["id"], "routine_source", params)

  defp enable(c) do
    {:ok, confirmation} = command(c, %{"operation" => "prepare", "account_id" => "exact"})

    {:ok, _} =
      command(c, %{
        "operation" => "enable",
        "account_id" => "exact",
        "confirmation" => confirmation
      })

    {:ok, profile} = Comma.Recommendations.get_runtime_profile(c.w["id"], c.user["id"])
    profile
  end

  test "Connect keeps Drive ownership, Calendar self attendance and Slack member relationships through official read schemas",
       c do
    for toolkit <- ~w(googledrive googlecalendar slack) do
      configure(c, "connect", toolkit)
      profile = enable(c)

      assert {:ok, %{facts: [fact], failures: []}} =
               RecommendationSourceCollector.collect(c.w, profile.sources,
                 member_user_id: c.user["id"]
               )

      assert fact["memberSubject"]["connection_id"] == "exact"

      case toolkit do
        "googledrive" ->
          assert fact["data"]["files"] |> hd() |> Map.get("name") == "Review plan"

        "googlecalendar" ->
          assert fact["data"]["items"] |> hd() |> Map.get("summary") == "Review"

        "slack" ->
          assert fact["data"]["messages"]["matches"] |> hd() |> Map.get("memberRelation") ==
                   "mentioned_you"
      end
    end

    actions =
      Agent.get(c.state, fn fixture ->
        for {"/mcp",
             %{"params" => %{"name" => "COMPOSIO_MULTI_EXECUTE_TOOL", "arguments" => args}}} <-
              fixture.calls,
            do: hd(args["tools"])
      end)

    assert Enum.all?(actions, &(&1["account"] == "exact"))
    find = Enum.find(actions, &(&1["tool_slug"] == "GOOGLEDRIVE_FIND_FILE"))
    assert find["arguments"]["pageSize"] in [5, 40]
    assert find["arguments"]["fields"] =~ "files("
    assert find["arguments"]["corpora"] == "user"
    calendar = Enum.find(actions, &(&1["tool_slug"] == "GOOGLECALENDAR_EVENTS_LIST"))
    assert calendar["arguments"]["maxResults"] == 40
    assert calendar["arguments"]["singleEvents"] == true
    search = Enum.find(actions, &(&1["tool_slug"] == "SLACK_SEARCH_MESSAGES"))
    assert search["arguments"]["auto_paginate"] == false
  end

  test "personal project mode pins the member owner and profile rebinding requires new consent",
       c do
    configure(c, "project", "googledrive")
    profile = enable(c)

    assert {:ok, %{facts: [fact], failures: []}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    assert fact["data"]["files"] |> hd() |> Map.get("name") == "Review plan"

    assert RecommendationRuntime.member_subjects_valid?(profile, %{
             "exact" => fact["memberSubject"]
           })

    sessions =
      Agent.get(c.state, fn fixture ->
        for {"/api/v3.1/tool_router/session", body} <- fixture.calls, do: body
      end)

    assert Enum.all?(
             sessions,
             &(&1["user_id"] == "comma:" <> c.w["default_group_id"] <> ":" <> c.user["id"] and
                 &1["connected_accounts"] == %{"googledrive" => ["exact"]})
           )

    {:ok, _} =
      Access.put_project_settings(
        c.w["salix_tenant_id"],
        c.w["default_group_id"],
        c.user["id"],
        %{"api_key" => "replacement"}
      )

    refute RecommendationRuntime.member_subjects_valid?(profile, %{
             "exact" => fact["memberSubject"]
           })

    before = Agent.get(c.state, &length(&1.calls))

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    assert Agent.get(c.state, &length(&1.calls)) == before
    {:ok, sources} = RecommendationSources.discover(c.w, c.user["id"], "member")
    {:ok, rebound} = Comma.Recommendations.reconcile_discovered_sources(profile.id, sources)
    refute hd(rebound.sources)["enabled"]
  end

  test "revoked remote account and changed provider identity stop before content and stale confirmation cannot enable",
       c do
    configure(c, "connect", "googledrive")
    {:ok, confirmation} = command(c, %{"operation" => "prepare", "account_id" => "exact"})
    Agent.update(c.state, &%{&1 | subject: "different-owner"})

    assert {:error, :member_identity_or_source_unavailable} =
             command(c, %{
               "operation" => "enable",
               "account_id" => "exact",
               "confirmation" => confirmation
             })

    Agent.update(c.state, &%{&1 | subject: "owner"})
    profile = enable(c)
    old_source = hd(profile.sources)
    Agent.update(c.state, &%{&1 | subject: "different-owner", calls: []})

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    refute Enum.any?(Agent.get(c.state, & &1.calls), fn {_, body} ->
             get_in(body, ["params", "arguments", "tools"])
             |> List.wrap()
             |> Enum.any?(&(&1["tool_slug"] == "GOOGLEDRIVE_FIND_FILE"))
           end)

    assert is_nil(Comma.MemberSourceConsents.binding(c.w["id"], c.user["id"], "googledrive"))
    Agent.update(c.state, &%{&1 | subject: "owner"})
    profile = enable(c)
    current_consent = Comma.MemberSourceConsents.binding(c.w["id"], c.user["id"], "googledrive")

    assert {:ok, :ok} =
             Comma.Recommendations.revoke_composio_sources(
               c.user,
               %{},
               c.w["id"],
               ["exact"],
               old_source
             )

    assert Comma.MemberSourceConsents.binding(c.w["id"], c.user["id"], "googledrive") ==
             current_consent

    Agent.update(c.state, &%{&1 | status: "REVOKED", calls: []})

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    refute Enum.any?(Agent.get(c.state, & &1.calls), fn {_, body} ->
             get_in(body, ["params", "name"]) == "COMPOSIO_MULTI_EXECUTE_TOOL"
           end)
  end

  test "generic refresh still requires the same personal consent and wrong scope or mode cannot read",
       c do
    configure(c, "connect", "googledrive")
    profile = enable(c)

    assert {:ok, %{facts: [fact], failures: []}} =
             RecommendationSourceCollector.collect(c.w, profile.sources)

    assert fact["memberSubject"]["connection_id"] == "exact"
    {:ok, sources} = RecommendationSources.discover(c.w, c.user["id"], "generic", profile.sources)
    assert length(sources) == 1
    before = Agent.get(c.state, &length(&1.calls))
    wrong_workspace = Map.put(c.w, "default_group_id", "other-group")

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(wrong_workspace, profile.sources)

    assert Agent.get(c.state, &length(&1.calls)) == before

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: "stranger"
             )

    assert Agent.get(c.state, &length(&1.calls)) == before

    {:ok, _} =
      Access.put_project_settings(
        c.w["salix_tenant_id"],
        c.w["default_group_id"],
        c.user["id"],
        %{"api_key" => "fixture"}
      )

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources)

    assert Agent.get(c.state, &length(&1.calls)) == before

    refute RecommendationRuntime.member_subjects_valid?(profile, %{
             "exact" => fact["memberSubject"]
           })

    assert {:ok, []} =
             RecommendationSources.discover(c.w, c.user["id"], "member", profile.sources)
  end

  test "background ingest remains idle before opt-in and disabling in Plugins purges already collected work",
       c do
    configure(c, "connect", "googledrive")
    assert {:ok, _} = CommaWeb.MemberSourceIngest.ingest(c.w, c.user["id"])
    assert Agent.get(c.state, & &1.calls) == []
    profile = enable(c)
    assert {:ok, _} = CommaWeb.MemberSourceIngest.ingest(c.w, c.user["id"])
    assert [%{collected: true, items: [item]}] = Comma.MemberSourceItems.current(profile.id)
    assert item.title == "Review plan"
    before = Agent.get(c.state, &length(&1.calls))
    assert :ok = CommaWeb.MemberSourceTriggers.ensure(c.w, profile.id)
    assert Agent.get(c.state, &length(&1.calls)) == before

    assert {:ok, _} =
             ComposioConnect.command(c.user, %{}, c.w["id"], "account", %{
               "operation" => "disable",
               "account_id" => "exact"
             })

    assert Comma.MemberSourceItems.current(profile.id) == []
    assert is_nil(Comma.MemberSourceConsents.binding(c.w["id"], c.user["id"], "googledrive"))
    {:ok, updated} = Comma.Recommendations.get_runtime_profile(c.w["id"], c.user["id"])
    refute hd(updated.sources)["enabled"]

    assert {:ok, _} =
             ComposioConnect.command(c.user, %{}, c.w["id"], "account", %{
               "operation" => "enable",
               "account_id" => "exact"
             })

    {:ok, sources} = RecommendationSources.discover(c.w, c.user["id"], "member", updated.sources)
    {:ok, reconciled} = Comma.Recommendations.reconcile_discovered_sources(profile.id, sources)
    refute hd(reconciled.sources)["enabled"]
    assert {:ok, _} = CommaWeb.MemberSourceIngest.ingest(c.w, c.user["id"])
    assert Agent.get(c.state, &length(&1.calls)) == before
  end

  @tag :routine_correction
  test "Routine OFF during identity response prevents subsequent Connect and project content requests",
       c do
    for mode <- ~w(connect project) do
      configure(c, mode, "googledrive")
      profile = enable(c)

      Agent.update(c.state, fn state ->
        state
        |> Map.put(:calls, [])
        |> Map.put(:identity_hook, fn ->
          assert {:ok, _} =
                   Comma.Recommendations.update_settings(c.user, %{}, c.w["id"], %{
                     "sources" => [%{"connectionId" => "exact", "enabled" => false}],
                     "schedule" => %{
                       "enabled" => profile.schedule_enabled,
                       "hour" => profile.schedule_hour,
                       "minute" => profile.schedule_minute,
                       "timezone" => profile.timezone
                     },
                     "autoEnableNewSources" => profile.auto_enable_new_sources
                   })
        end)
      end)

      result =
        RecommendationSourceCollector.collect(c.w, profile.sources, member_user_id: c.user["id"])

      {:ok, current} = Comma.Recommendations.get_runtime_profile(c.w["id"], c.user["id"])
      refute hd(current.sources)["enabled"]
      calls = Agent.get(c.state, & &1.calls)

      content_requests =
        Enum.filter(calls, fn
          {"/mcp",
           %{
             "params" => %{
               "name" => "COMPOSIO_MULTI_EXECUTE_TOOL",
               "arguments" => %{"tools" => [%{"tool_slug" => "GOOGLEDRIVE_FIND_FILE"}]}
             }
           }} ->
            true

          {"/api/v3.1/tool_router/session/pinned/proxy_execute", %{"endpoint" => endpoint}} ->
            URI.parse(endpoint).path == "/drive/v3/files"

          _ ->
            false
        end)

      assert content_requests == []
      assert {:ok, %{facts: [], failures: [_]}} = result
    end
  end

  @tag :routine_correction
  test "Routine discovery preserves the Plugins identity and full account reference exactly once",
       c do
    configure(c, "connect", "googledrive")
    identity = "Casey Alexandra Example <casey.alexandra.work.identity@example.test>"

    for name <- [identity <> " (exact)", identity] do
      {:ok, _} =
        Access.update_account_name(
          c.w["salix_tenant_id"],
          c.w["default_group_id"],
          c.user["id"],
          "exact",
          %{"toolkit" => "googledrive", "mode" => "connect", "name" => name}
        )

      assert {:ok, [source]} = RecommendationSources.discover(c.w, c.user["id"], "member")
      assert source["label"] == identity <> " (exact)"
      assert source["connectionId"] == "exact"
      refute source["enabled"]
    end
  end

  defp gmail_fixture(c, variant \\ :valid) do
    root =
      Path.join(System.tmp_dir!(), "comma-routine-offload-#{System.unique_integer([:positive])}")

    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)

    message = %{
      "id" => "message1",
      "threadId" => "thread1",
      "internalDate" => "1791882000000",
      "labelIds" => ["INBOX", "IMPORTANT"],
      "snippet" => "Complete source context",
      "payload" => %{
        "mimeType" => "text/plain",
        "headers" => [
          %{"name" => "Subject", "value" => "Full offloaded review"},
          %{"name" => "From", "value" => "Colleague <colleague@example.com>"}
        ],
        "body" => %{
          "data" =>
            Base.url_encode64("Please review the complete plan before Friday.", padding: false)
        }
      }
    }

    thread = %{"messages" => [message]}

    slug =
      if variant == :wrong_file_slug,
        do: "GMAIL_GET_PROFILE",
        else: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"

    file = %{
      "results" => [
        %{
          "index" => 0,
          "tool_slug" => slug,
          "response" => %{"successful" => true, "data" => thread}
        }
      ]
    }

    file =
      if variant == :oversize,
        do:
          put_in(
            file,
            ["results", Elixir.Access.at(0), "response", "data", "padding"],
            String.duplicate("x", 600_000)
          ),
        else: file

    File.write!(Path.join(root, "batch.json"), Jason.encode!(file))

    if variant == :symlink do
      outside = root <> "-outside.json"
      File.rename!(Path.join(root, "batch.json"), outside)
      File.ln_s!(outside, Path.join(root, "batch.json"))
      on_exit(fn -> File.rm(outside) end)
    end

    Agent.update(
      c.state,
      &Map.merge(&1, %{offload_root: root, offload_case: variant, gmail_thread: thread})
    )

    configure(c, "connect", "gmail")
    enable(c)
  end

  @tag :routine_offload
  test "Gmail collection retrieves the complete offloaded result instead of publishing preview",
       c do
    profile = gmail_fixture(c)

    assert {:ok, %{facts: [fact], failures: []}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    assert [%{"subject" => "Full offloaded review"}] = fact["data"]["messages"]
    assert fact["memberSubject"]["connection_id"] == "exact"
    refute Jason.encode!(fact) =~ "PREVIEW MUST NOT APPEAR"
    assert Jason.encode!(fact) =~ "Please review the complete plan"
    calls = Agent.get(c.state, & &1.calls)

    workbench =
      for {"/mcp", %{"params" => %{"name" => "COMPOSIO_REMOTE_WORKBENCH", "arguments" => args}}} <-
            calls,
          do: args

    assert [%{"session_id" => "workflow"}] = workbench

    tools =
      for {"/mcp",
           %{
             "params" => %{
               "name" => "COMPOSIO_MULTI_EXECUTE_TOOL",
               "arguments" => %{"tools" => [tool]}
             }
           }} <- calls,
          do: tool

    assert Enum.all?(tools, &(&1["account"] == "exact"))

    assert {:error, :composio_tool_not_allowed} =
             Salix.Control.ComposioConnect.call(
               c.w["salix_tenant_id"],
               c.w["default_group_id"],
               c.user["id"],
               "COMPOSIO_REMOTE_WORKBENCH",
               %{"code_to_execute" => "print('forbidden')"}
             )
  end

  @tag :routine_offload
  test "Routine OFF after Gmail offload prevents the complete-result extraction request", c do
    profile = gmail_fixture(c)

    Agent.update(
      c.state,
      &Map.put(&1, :offload_hook, fn ->
        assert {:ok, _} =
                 Comma.Recommendations.update_settings(c.user, %{}, c.w["id"], %{
                   "sources" => [%{"connectionId" => "exact", "enabled" => false}],
                   "schedule" => %{
                     "enabled" => profile.schedule_enabled,
                     "hour" => profile.schedule_hour,
                     "minute" => profile.schedule_minute,
                     "timezone" => profile.timezone
                   },
                   "autoEnableNewSources" => profile.auto_enable_new_sources
                 })
      end)
    )

    assert {:ok, %{facts: [], failures: [_]}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    refute Enum.any?(Agent.get(c.state, & &1.calls), fn {_, body} ->
             get_in(body, ["params", "name"]) == "COMPOSIO_REMOTE_WORKBENCH"
           end)
  end

  @tag :routine_offload
  test "offload refuses foreign sessions, unsafe files, mismatched tools, oversized data and workbench truncation",
       c do
    for variant <- [
          :wrong_session,
          :unsafe_path,
          :symlink,
          :wrong_file_slug,
          :oversize,
          :truncated
        ] do
      profile = gmail_fixture(c, variant)

      assert {:ok, %{facts: [], failures: [_]}} =
               RecommendationSourceCollector.collect(c.w, profile.sources,
                 member_user_id: c.user["id"]
               )
    end
  end

  @tag :routine_offload
  test "inline Gmail remains a complete exact-account path without workbench", c do
    profile = gmail_fixture(c, :inline)

    assert {:ok, %{facts: [_], failures: []}} =
             RecommendationSourceCollector.collect(c.w, profile.sources,
               member_user_id: c.user["id"]
             )

    refute Enum.any?(Agent.get(c.state, & &1.calls), fn {_, body} ->
             get_in(body, ["params", "name"]) == "COMPOSIO_REMOTE_WORKBENCH"
           end)
  end
end
