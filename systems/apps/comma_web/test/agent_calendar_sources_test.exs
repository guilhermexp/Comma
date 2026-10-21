defmodule CommaWeb.AgentCalendarSourcesTest do
  use Comma.DataCase, async: false
  alias CommaWeb.AgentCalendarSources, as: Sources
  alias SalixStore.{ComposioAccess, S3}

  # Connect-mode provider. Each executed tool is answered by the test's
  # `respond` function, so every case controls the Google data it sees.
  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      {:ok, raw, conn} = read_body(conn)
      request = Jason.decode!(raw)
      params = request["params"]

      result =
        case params["name"] do
          "COMPOSIO_MANAGE_CONNECTIONS" ->
            accounts = for id <- ~w(cal cal2), do: %{"id" => id, "status" => "ACTIVE"}
            %{"data" => %{"results" => %{"googlecalendar" => %{"accounts" => accounts}}}}

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
            Agent.update(state, &Map.update!(&1, :tools, fn t -> t ++ [tool] end))
            respond = Agent.get(state, & &1.respond)

            response =
              case respond.(tool["tool_slug"], tool["arguments"]) do
                {:error, text} -> %{"successful" => false, "error" => text}
                data -> %{"successful" => true, "data" => data}
              end

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
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing_owner = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)

    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :subscription_storage_key},
      {:salix_web, :composio_connect_endpoint},
      {:salix_mcp, :allow_private_http_targets}
    ]

    previous = Enum.map(entries, fn {a, k} -> {a, k, Application.get_env(a, k)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    if Process.whereis(S3.Fake), do: S3.Fake.reset(), else: start_supervised!(S3.Fake)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("g", 32))

    state = start_supervised!({Agent, fn -> %{tools: [], respond: &google/2} end})

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_web, :composio_connect_endpoint, "http://127.0.0.1:#{port}/mcp")
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

    {:ok, user} =
      Comma.Accounts.create_user(%{
        "email" => "agent-cal-#{System.unique_integer([:positive])}@comma.test"
      })

    w = create_ready_workspace!(user)
    {tenant, group, uid} = {w["salix_tenant_id"], w["default_group_id"], user["id"]}

    :ok =
      SalixStore.OAuth.put("agent-cal-connect", %{
        "tenant" => tenant,
        "group_id" => group,
        "composio_user_id" => uid,
        "credential_protection" => "composio_connect",
        "access_token" => "private-connect-token",
        "expires_at" => System.system_time(:millisecond) + 600_000
      })

    {:ok, _} =
      ComposioAccess.update_profile(tenant, group, uid, fn profile ->
        {:ok,
         Map.merge(profile, %{
           "mode" => "connect",
           "status" => "connected",
           "connection_id" => "agent-cal-connect",
           "mcp_session_headers" => %{"mcp-session-id" => "fixture-session"}
         })}
      end)

    for {id, toolkit, name} <- [
          {"cal", "googlecalendar", "Work"},
          {"cal2", "googlecalendar", "Personal"},
          {"drive", "googledrive", "Drive"}
        ] do
      {:ok, _} =
        ComposioAccess.put_account(tenant, group, uid, id, %{
          "toolkit" => toolkit,
          "name" => name,
          "status" => "ACTIVE",
          "mode" => "connect"
        })
    end

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)

      Ecto.Adapters.SQL.Sandbox.stop_owner(billing_owner)
    end)

    %{
      w: w,
      provider: state,
      owner: %{tenant: tenant, group_id: group, user_id: uid}
    }
  end

  defp google("GOOGLECALENDAR_LIST_CALENDARS", _),
    do: %{
      "calendars" => [
        %{
          "id" => "me@example.test",
          "summary" => "Me",
          "primary" => true,
          "selected" => true,
          "accessRole" => "owner",
          "backgroundColor" => "#9FE1E7"
        },
        %{
          "id" => "holidays@group.v.calendar.google.com",
          "summary" => "Feriados",
          "selected" => true,
          "accessRole" => "reader"
        },
        %{"id" => "hidden@group.calendar.google.com", "summary" => "Hidden"}
      ]
    }

  defp google("GOOGLECALENDAR_EVENTS_LIST", %{"calendarId" => "holidays" <> _}),
    do: %{
      "items" => [
        %{
          "id" => "holiday1",
          "iCalUID" => "holiday1@google.com",
          "summary" => "Finados",
          "etag" => "\"h1\"",
          "status" => "confirmed",
          "start" => %{"date" => "2026-11-02"},
          "end" => %{"date" => "2026-11-03"}
        }
      ]
    }

  defp google("GOOGLECALENDAR_EVENTS_LIST", _),
    do: %{
      "items" => [
        %{
          "id" => "weekly_20261019T130000Z",
          "recurringEventId" => "weekly",
          "iCalUID" => "weekly@google.com",
          "summary" => "Sync",
          "etag" => "\"i19\"",
          "status" => "confirmed",
          "location" => "Sala 1",
          "description" => "Pauta",
          "organizer" => %{"email" => "me@example.test", "self" => true},
          "start" => %{
            "dateTime" => "2026-10-19T10:00:00-03:00",
            "timeZone" => "America/Sao_Paulo"
          },
          "end" => %{
            "dateTime" => "2026-10-19T11:00:00-03:00",
            "timeZone" => "America/Sao_Paulo"
          }
        }
      ]
    }

  defp google("GOOGLECALENDAR_EVENTS_GET", %{"event_id" => "missing"}),
    do: {:error, "404 Not Found"}

  defp google("GOOGLECALENDAR_EVENTS_GET", %{"event_id" => id}),
    do: %{
      "id" => id,
      "iCalUID" => "#{id}@google.com",
      "summary" => "Sync",
      "etag" => "\"e1\"",
      "status" => "confirmed",
      "recurrence" => ["RRULE:FREQ=WEEKLY"],
      "organizer" => %{"email" => "me@example.test", "self" => true},
      "start" => %{"dateTime" => "2026-10-19T10:00:00-03:00", "timeZone" => "America/Sao_Paulo"},
      "end" => %{"dateTime" => "2026-10-19T11:00:00-03:00", "timeZone" => "America/Sao_Paulo"}
    }

  defp google("GOOGLECALENDAR_CREATE_EVENT", args),
    do: %{
      "response_data" => %{
        "id" => "created",
        "iCalUID" => "created@google.com",
        "etag" => "\"c1\"",
        "summary" => args["summary"],
        "organizer" => %{"email" => "me@example.test", "self" => true},
        "start" => %{"date" => args["start_date"]},
        "end" => %{"date" => args["end_date"]}
      }
    }

  defp google(_, _), do: %{}

  defp respond(c, fun), do: Agent.update(c.provider, &%{&1 | respond: fun})
  defp tools(c), do: Agent.get(c.provider, & &1.tools)

  defp week(extra \\ %{}),
    do:
      Map.merge(
        %{
          "time_min" => "2026-10-19T00:00:00-03:00",
          "time_max" => "2026-10-26T00:00:00-03:00",
          "time_zone" => "America/Sao_Paulo"
        },
        extra
      )

  test "owner resolves the agent's workspace owner", c do
    assert {:ok, owner} = Sources.owner(c.w["router_agent_id"])
    assert owner == c.owner
    assert {:error, _} = Sources.owner("agent-that-does-not-exist")
  end

  test "accounts are the owner's active enabled Calendar accounts, with no agent grant", c do
    assert {:ok, accounts} = Sources.google_accounts(c.owner)

    assert Enum.sort_by(accounts, & &1["account_id"]) == [
             %{"account_id" => "cal", "name" => "Work"},
             %{"account_id" => "cal2", "name" => "Personal"}
           ]

    {:ok, _} =
      ComposioAccess.enable_account(
        c.owner.tenant,
        c.owner.group_id,
        c.owner.user_id,
        "cal2",
        false
      )

    assert {:ok, [%{"account_id" => "cal"}]} = Sources.google_accounts(c.owner)
  end

  test "an active account with no agent grant reads events in the C4 shape", c do
    assert {:ok, %{"events" => [sync, holiday], "truncated" => false}} =
             Sources.google(c.owner, "cal", :events, week())

    assert sync == %{
             "event_ref" => %{
               "source" => "google",
               "account_id" => "cal",
               "calendar_id" => "me@example.test",
               "event_id" => "weekly_20261019T130000Z",
               "occurrence" => nil,
               "etag" => "\"i19\""
             },
             "calendar_ref" => %{
               "source" => "google",
               "account_id" => "cal",
               "calendar_id" => "me@example.test"
             },
             "title" => "Sync",
             "start" => "2026-10-19T10:00:00-03:00",
             "end" => "2026-10-19T11:00:00-03:00",
             "all_day" => false,
             "time_zone" => "America/Sao_Paulo",
             "location" => "Sala 1",
             "description" => "Pauta",
             "recurring" => true,
             "writable" => true,
             "ical_uid" => "weekly@google.com"
           }

    assert %{
             "start" => "2026-11-02",
             "end" => "2026-11-03",
             "all_day" => true,
             "time_zone" => nil,
             "recurring" => false,
             "writable" => false,
             "ical_uid" => "holiday1@google.com",
             "calendar_ref" => %{"calendar_id" => "holidays@group.v.calendar.google.com"}
           } = holiday

    # Without calendar_ids the selected calendars are read.
    assert ["me@example.test", "holidays@group.v.calendar.google.com"] ==
             for(
               %{"tool_slug" => "GOOGLECALENDAR_EVENTS_LIST", "arguments" => a} <- tools(c),
               do: a["calendarId"]
             )

    assert Enum.all?(tools(c), &(&1["account"] == "cal"))
  end

  test "calendars and a single event are normalized", c do
    assert {:ok, %{"calendars" => [me, holidays, _hidden]}} =
             Sources.google(c.owner, "cal", :calendars, %{})

    assert me == %{
             "calendar_ref" => %{
               "source" => "google",
               "account_id" => "cal",
               "calendar_id" => "me@example.test"
             },
             "name" => "Me",
             "writable" => true,
             "color" => "#9fe1e7",
             "primary" => true
           }

    assert %{"writable" => false, "color" => nil} = holidays

    assert {:ok, %{"event" => event}} =
             Sources.google(c.owner, "cal", :event, %{
               "calendar_id" => "primary",
               "event_id" => "weekly"
             })

    assert %{
             "recurring" => true,
             "recurrence" => "weekly",
             "ical_uid" => "weekly@google.com",
             "event_ref" => %{"event_id" => "weekly", "etag" => "\"e1\""}
           } = event
  end

  test "create on a writable calendar returns the normalized event", c do
    assert {:ok, %{"event" => event}} =
             Sources.google(c.owner, "cal", :create, %{
               "calendar_id" => "me@example.test",
               "event" => %{
                 "title" => "Folga",
                 "start" => "2026-10-22",
                 "end" => "2026-10-23",
                 "all_day" => true,
                 "time_zone" => "America/Sao_Paulo",
                 "recurrence" => "none"
               }
             })

    assert %{"title" => "Folga", "start" => "2026-10-22", "all_day" => true} = event
  end

  test "a disabled account is not read", c do
    {:ok, _} =
      ComposioAccess.enable_account(
        c.owner.tenant,
        c.owner.group_id,
        c.owner.user_id,
        "cal",
        false
      )

    assert {:error, "not_connected"} = Sources.google(c.owner, "cal", :calendars, %{})
    assert tools(c) == []
  end

  test "another user's account and a non-owner are refused", c do
    {:ok, other} =
      Comma.Accounts.create_user(%{
        "email" => "other-#{System.unique_integer([:positive])}@comma.test"
      })

    {:ok, _} =
      ComposioAccess.put_account(c.owner.tenant, c.owner.group_id, other["id"], "theirs", %{
        "toolkit" => "googlecalendar",
        "name" => "Theirs",
        "status" => "ACTIVE",
        "mode" => "connect"
      })

    assert {:error, "not_connected"} = Sources.google(c.owner, "theirs", :calendars, %{})
    assert {:error, "not_connected"} = Sources.google(c.owner, "drive", :calendars, %{})

    intruder = %{c.owner | user_id: other["id"]}

    assert {:error, "composio_access_denied"} =
             Sources.google(intruder, "theirs", :calendars, %{})

    assert {:error, "composio_access_denied"} = Sources.google_accounts(intruder)
    assert tools(c) == []
  end

  test "access is checked again after the provider call", c do
    owner = c.owner

    respond(c, fn slug, args ->
      {:ok, _} =
        ComposioAccess.enable_account(owner.tenant, owner.group_id, owner.user_id, "cal", false)

      google(slug, args)
    end)

    assert {:error, "composio_access_denied"} = Sources.google(owner, "cal", :calendars, %{})
    assert [_] = tools(c)
  end

  test "provider and request failures map to public codes", c do
    assert {:error, "invalid_request"} =
             Sources.google(
               c.owner,
               "cal",
               :events,
               week(%{"time_max" => "2027-02-01T00:00:00Z"})
             )

    assert {:error, "invalid_request"} = Sources.google(c.owner, "cal", :unknown, %{})

    assert {:error, "not_found"} =
             Sources.google(c.owner, "cal", :event, %{
               "calendar_id" => "primary",
               "event_id" => "missing"
             })

    assert {:error, "calendar_event_conflict"} =
             Sources.google(c.owner, "cal", :delete, %{
               "calendar_id" => "primary",
               "event_id" => "weekly",
               "scope" => "instance",
               "etag" => "\"stale\""
             })

    assert {:error, "read_only"} =
             Sources.google(c.owner, "cal", :delete, %{
               "calendar_id" => "holidays@group.v.calendar.google.com",
               "event_id" => "holiday1",
               "scope" => "instance"
             })

    refute "GOOGLECALENDAR_DELETE_EVENT" in Enum.map(tools(c), & &1["tool_slug"])

    respond(c, fn
      "GOOGLECALENDAR_CREATE_EVENT", _ -> {:error, "403 Forbidden: insufficientPermissions"}
      slug, args -> google(slug, args)
    end)

    assert {:error, "calendar_write_permission_required"} =
             Sources.google(c.owner, "cal", :create, %{
               "calendar_id" => "primary",
               "event" => %{
                 "title" => "x",
                 "start" => "2026-10-22",
                 "end" => "2026-10-23",
                 "all_day" => true,
                 "time_zone" => "UTC",
                 "recurrence" => "none"
               }
             })

    respond(c, fn _, _ -> {:error, "403 Forbidden: insufficientPermissions"} end)
    assert {:error, "composio_access_denied"} = Sources.google(c.owner, "cal", :calendars, %{})

    respond(c, fn _, _ -> {:error, "502 Bearer ya29.secret"} end)
    assert {:error, "provider_unavailable"} = Sources.google(c.owner, "cal", :calendars, %{})
  end

  test "logs carry no event text on reads, writes and provider failures", c do
    title = "Comma agent secret title 7f3a"
    location = "Secret location 7f3a"
    description = "Secret description 7f3a"

    respond(c, fn
      "GOOGLECALENDAR_EVENTS_LIST", _ ->
        %{
          "items" => [
            %{
              "id" => "secret1",
              "summary" => title,
              "location" => location,
              "description" => description,
              "status" => "confirmed",
              "start" => %{"dateTime" => "2026-10-20T15:00:00-03:00"},
              "end" => %{"dateTime" => "2026-10-20T16:00:00-03:00"}
            }
          ]
        }

      "GOOGLECALENDAR_CREATE_EVENT", _ ->
        {:error, "500 #{title} #{location} #{description}"}

      slug, args ->
        google(slug, args)
    end)

    log =
      ExUnit.CaptureLog.capture_log([level: :debug], fn ->
        assert {:ok, %{"events" => [_ | _]}} = Sources.google(c.owner, "cal", :events, week())

        assert {:error, _} =
                 Sources.google(c.owner, "cal", :create, %{
                   "calendar_id" => "primary",
                   "event" => %{
                     "title" => title,
                     "location" => location,
                     "description" => description,
                     "start" => "2026-10-22T15:00:00-03:00",
                     "end" => "2026-10-22T16:00:00-03:00",
                     "all_day" => false,
                     "time_zone" => "America/Sao_Paulo",
                     "recurrence" => "none"
                   }
                 })
      end)

    for secret <- [title, location, description], do: refute(log =~ secret)
  end
end
