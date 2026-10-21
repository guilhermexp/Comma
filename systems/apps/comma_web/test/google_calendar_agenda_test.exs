defmodule CommaWeb.GoogleCalendarAgendaTest do
  use Comma.DataCase, async: false
  import ExUnit.CaptureLog
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
            %{
              "data" => %{
                "results" => %{
                  "googlecalendar" => %{"accounts" => [%{"id" => "cal", "status" => "ACTIVE"}]},
                  "googledrive" => %{"accounts" => [%{"id" => "drive", "status" => "ACTIVE"}]}
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
        "email" => "agenda-#{System.unique_integer([:positive])}@comma.test"
      })

    w = create_ready_workspace!(user)
    {tenant, group, uid} = {w["salix_tenant_id"], w["default_group_id"], user["id"]}

    :ok =
      SalixStore.OAuth.put("agenda-connect", %{
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
           "connection_id" => "agenda-connect",
           "mcp_session_headers" => %{"mcp-session-id" => "fixture-session"}
         })}
      end)

    for {id, toolkit} <- [{"cal", "googlecalendar"}, {"drive", "googledrive"}] do
      {:ok, _} =
        ComposioAccess.put_account(tenant, group, uid, id, %{
          "toolkit" => toolkit,
          "name" => "Member",
          "status" => "ACTIVE",
          "mode" => "connect"
        })
    end

    {:ok, session} = Comma.Accounts.create_session(uid)

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)

      Ecto.Adapters.SQL.Sandbox.stop_owner(billing_owner)
    end)

    %{w: w, provider: state, token: session["token"], tenant: tenant, group: group}
  end

  @series %{
    "id" => "weekly",
    "summary" => "Sync",
    "etag" => "\"s1\"",
    "status" => "confirmed",
    "organizer" => %{"email" => "me@example.test", "self" => true},
    "recurrence" => ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    "start" => %{"dateTime" => "2026-10-19T10:00:00-03:00", "timeZone" => "America/Sao_Paulo"},
    "end" => %{"dateTime" => "2026-10-19T11:00:00-03:00", "timeZone" => "America/Sao_Paulo"}
  }

  defp instance(day, extra \\ %{}) do
    Map.merge(
      %{
        "id" => "weekly_202610#{day}T130000Z",
        "recurringEventId" => "weekly",
        "summary" => "Sync",
        "etag" => "\"i#{day}\"",
        "status" => "confirmed",
        "organizer" => %{"email" => "me@example.test", "self" => true},
        "htmlLink" => "https://www.google.com/calendar/event?eid=abc",
        "colorId" => "11",
        "start" => %{
          "dateTime" => "2026-10-#{day}T10:00:00-03:00",
          "timeZone" => "America/Sao_Paulo"
        },
        "end" => %{
          "dateTime" => "2026-10-#{day}T11:00:00-03:00",
          "timeZone" => "America/Sao_Paulo"
        }
      },
      extra
    )
  end

  # Default Google data: two calendars and a weekly series.
  defp google("GOOGLECALENDAR_LIST_CALENDARS", _),
    do: %{
      "calendars" => [
        %{
          "id" => "me@example.test",
          "summary" => "Me",
          "primary" => true,
          "selected" => true,
          "accessRole" => "owner",
          "backgroundColor" => "#9fe1e7"
        },
        %{
          "id" => "pt.brazilian#holiday@group.v.calendar.google.com",
          "summary" => "Feriados no Brasil",
          "accessRole" => "reader",
          "backgroundColor" => "#16a765"
        }
      ],
      "next_page_token" => nil
    }

  defp google("GOOGLECALENDAR_EVENTS_LIST", _),
    do: %{"items" => [instance(19), instance(26)]}

  defp google("GOOGLECALENDAR_EVENTS_GET", %{"event_id" => "weekly"}), do: @series
  defp google("GOOGLECALENDAR_EVENTS_GET", %{"event_id" => id}), do: instance(day(id))
  defp google("GOOGLECALENDAR_EVENTS_MOVE", %{"event_id" => id}), do: instance(day(id))

  defp google("GOOGLECALENDAR_PATCH_EVENT", %{"event_id" => "weekly"} = a),
    do: Map.merge(@series, %{"summary" => a["summary"] || "Sync", "etag" => "\"s2\""})

  defp google("GOOGLECALENDAR_PATCH_EVENT", %{"event_id" => id} = a),
    do: instance(day(id), %{"summary" => a["summary"] || "Sync", "etag" => "\"i2\""})

  defp google("GOOGLECALENDAR_CREATE_EVENT", a),
    do: %{
      "response_data" => %{
        "id" => "created",
        "etag" => "\"c1\"",
        "status" => "confirmed",
        "summary" => a["summary"],
        "organizer" => %{"email" => "me@example.test", "self" => true},
        "start" =>
          if(a["start_date"],
            do: %{"date" => a["start_date"]},
            else: %{"dateTime" => a["start_datetime"], "timeZone" => a["timezone"]}
          ),
        "end" =>
          if(a["end_date"],
            do: %{"date" => a["end_date"]},
            else: %{"dateTime" => a["end_datetime"], "timeZone" => a["timezone"]}
          )
      }
    }

  defp google("GOOGLECALENDAR_DELETE_EVENT", _), do: %{}

  defp day("weekly_202610" <> rest), do: String.slice(rest, 0, 2)
  defp day(_), do: "19"

  defp respond(c, fun), do: Agent.update(c.provider, &%{&1 | respond: fun})
  defp tools(c), do: Agent.get(c.provider, & &1.tools)
  defp slugs(c), do: Enum.map(tools(c), & &1["tool_slug"])

  defp post(c, body, token \\ :member) do
    conn =
      Plug.Test.conn(
        :post,
        "/v1/comma/workspaces/#{c.w["id"]}/composio/google_calendar",
        Jason.encode!(body)
      )
      |> Plug.Conn.put_req_header("content-type", "application/json")

    conn =
      if token == :member,
        do:
          conn
          |> Plug.Conn.put_req_header("x-comma-session-transport", "bearer")
          |> Plug.Conn.put_req_header("authorization", "Bearer " <> c.token),
        else: conn

    conn = CommaWeb.Router.call(conn, CommaWeb.Router.init([]))
    {conn.status, Jason.decode!(conn.resp_body)}
  end

  defp agenda(c, operation, body \\ %{}),
    do: post(c, Map.merge(%{"account_id" => "cal", "operation" => operation}, body))

  defp week(ids),
    do: %{
      "calendar_ids" => ids,
      "time_min" => "2026-10-19T00:00:00-03:00",
      "time_max" => "2026-10-26T00:00:00-03:00",
      "time_zone" => "America/Sao_Paulo"
    }

  defp input(extra \\ %{}),
    do:
      Map.merge(
        %{
          "title" => "Revisão",
          "start" => "2026-10-22T15:00:00-03:00",
          "end" => "2026-10-22T16:30:00-03:00",
          "all_day" => false,
          "time_zone" => "America/Sao_Paulo",
          "recurrence" => "none"
        },
        extra
      )

  defp error(response), do: elem(response, 1)["error"]

  test "the route requires a member session", c do
    assert {401, _} = post(c, %{"account_id" => "cal", "operation" => "calendars"}, :none)
    assert tools(c) == []
  end

  test "invalid requests are refused without calling Composio", c do
    for body <- [
          %{"operation" => "acl_insert"},
          %{"operation" => "calendars", "tool_slug" => "GOOGLECALENDAR_ACL_INSERT"},
          Map.put(week(Enum.map(1..26, &"c#{&1}")), "operation", "events"),
          Map.put(
            %{week(["primary"]) | "time_max" => "2027-01-17T00:00:00-03:00"},
            "operation",
            "events"
          ),
          Map.put(
            %{week(["primary"]) | "time_max" => "2026-10-18T00:00:00-03:00"},
            "operation",
            "events"
          ),
          %{
            "operation" => "create",
            "calendar_id" => "primary",
            "event" => input(%{"end" => "2026-10-22T15:00:00-03:00"})
          },
          %{
            "operation" => "create",
            "calendar_id" => "primary",
            "event" => input(%{"recurrence" => "FREQ=HOURLY"})
          },
          %{
            "operation" => "update",
            "calendar_id" => "primary",
            "event_id" => "e",
            "patch" => %{}
          }
        ] do
      assert {422, %{"error" => "invalid_composio_request"}} =
               post(c, Map.put(body, "account_id", "cal"))
    end

    assert tools(c) == []
  end

  test "another member's account and a non-Calendar account are denied", c do
    assert "composio_access_denied" ==
             error(post(c, %{"account_id" => "foreign", "operation" => "calendars"}))

    assert "composio_access_denied" ==
             error(post(c, %{"account_id" => "drive", "operation" => "calendars"}))

    assert tools(c) == []
  end

  test "calendars report write access, selection and the account email", c do
    assert {200, body} = agenda(c, "calendars")
    assert body["account_email"] == "me@example.test"

    assert [
             %{
               "id" => "me@example.test",
               "name" => "Me",
               "color" => "#9fe1e7",
               "primary" => true,
               "selected" => true,
               "access_role" => "owner",
               "writable" => true
             },
             %{"name" => "Feriados no Brasil", "access_role" => "reader", "writable" => false}
           ] = body["calendars"]

    assert [%{"tool_slug" => "GOOGLECALENDAR_LIST_CALENDARS", "account" => "cal"}] = tools(c)
  end

  test "events expand a weekly series, drop cancelled occurrences and isolate a failed calendar",
       c do
    respond(c, fn
      "GOOGLECALENDAR_EVENTS_LIST", %{"calendarId" => "broken"} ->
        {:error, "500 backend error"}

      "GOOGLECALENDAR_EVENTS_LIST", _ ->
        %{"items" => [instance(19), instance(21, %{"status" => "cancelled"}), instance(26)]}
    end)

    assert {200, body} = agenda(c, "events", week(["primary", "broken"]))
    assert body["failed_calendar_ids"] == ["broken"]
    assert body["truncated"] == false

    assert [
             %{
               "id" => "weekly_20261019T130000Z",
               "calendar_id" => "primary",
               "series_id" => "weekly",
               "title" => "Sync",
               "start" => %{
                 "date_time" => "2026-10-19T10:00:00-03:00",
                 "time_zone" => "America/Sao_Paulo"
               },
               "all_day" => false,
               "url" => "https://www.google.com/calendar/event?eid=abc",
               "color" => "#d50000",
               "editable" => true,
               "etag" => "\"i19\""
             },
             %{"series_id" => "weekly"}
           ] = body["events"]

    [first | _] = tools(c)

    assert first["arguments"] == %{
             "calendarId" => "primary",
             "timeMin" => "2026-10-19T00:00:00-03:00",
             "timeMax" => "2026-10-26T00:00:00-03:00",
             "timeZone" => "America/Sao_Paulo",
             "singleEvents" => true,
             "orderBy" => "startTime",
             "showDeleted" => false,
             "maxResults" => 250
           }
  end

  test "an empty page that still carries a token continues to the next page", c do
    respond(c, fn "GOOGLECALENDAR_EVENTS_LIST", args ->
      case args["pageToken"] do
        nil -> %{"items" => [], "nextPageToken" => "b"}
        "b" -> %{"items" => [instance(19)]}
      end
    end)

    assert {200,
            %{"events" => [%{"id" => "weekly_20261019T130000Z"}], "failed_calendar_ids" => []}} =
             agenda(c, "events", week(["primary"]))

    assert [nil, "b"] == Enum.map(tools(c), & &1["arguments"]["pageToken"])
  end

  test "a repeated page token fails that calendar instead of looping", c do
    respond(c, fn "GOOGLECALENDAR_EVENTS_LIST", args ->
      case args["pageToken"] do
        nil -> %{"items" => [instance(19)], "nextPageToken" => "a"}
        "a" -> %{"items" => [], "nextPageToken" => "b"}
        "b" -> %{"items" => [], "nextPageToken" => "a"}
      end
    end)

    assert {200, %{"events" => [], "failed_calendar_ids" => ["primary"]}} =
             agenda(c, "events", week(["primary"]))

    assert length(tools(c)) == 3
  end

  test "a failure on a later page fails the whole calendar without partial events", c do
    respond(c, fn "GOOGLECALENDAR_EVENTS_LIST", args ->
      case {args["calendarId"], args["pageToken"]} do
        {"primary", nil} -> %{"items" => [instance(19)], "nextPageToken" => "next"}
        {"primary", "next"} -> {:error, "503 unavailable"}
        {"other", _} -> %{"items" => [instance(26)]}
      end
    end)

    assert {200, body} = agenda(c, "events", week(["primary", "other"]))
    assert body["failed_calendar_ids"] == ["primary"]
    assert [%{"calendar_id" => "other", "id" => "weekly_20261026T130000Z"}] = body["events"]
  end

  test "more than 2,500 events are cut and marked truncated", c do
    respond(c, fn "GOOGLECALENDAR_EVENTS_LIST", args ->
      items = for n <- 1..1300, do: instance(19, %{"id" => "e#{n}#{args["pageToken"]}"})

      if args["pageToken"],
        do: %{"items" => items},
        else: %{"items" => items, "nextPageToken" => "2"}
    end)

    assert {200, body} = agenda(c, "events", week(["primary", "second"]))
    assert body["truncated"] == true
    assert length(body["events"]) == 2500
    assert body["failed_calendar_ids"] == []
  end

  test "an event classifies simple and custom recurrence from its series", c do
    assert {200, %{"event" => %{"id" => "weekly", "recurrence" => "weekly", "series_id" => nil}}} =
             agenda(c, "event", %{"calendar_id" => "primary", "event_id" => "weekly"})

    assert {200, %{"event" => %{"series_id" => "weekly", "recurrence" => "weekly"}}} =
             agenda(c, "event", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z"
             })

    custom = Map.put(@series, "recurrence", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"])

    respond(c, fn "GOOGLECALENDAR_EVENTS_GET", _ -> custom end)

    assert {200, %{"event" => %{"recurrence" => "custom"}}} =
             agenda(c, "event", %{"calendar_id" => "primary", "event_id" => "weekly"})

    respond(c, fn "GOOGLECALENDAR_EVENTS_GET", _ -> Map.delete(@series, "recurrence") end)

    assert {200, %{"event" => %{"recurrence" => "none"}}} =
             agenda(c, "event", %{"calendar_id" => "primary", "event_id" => "weekly"})
  end

  test "create sends the time zone and no meeting room, all-day uses dates", c do
    assert {200, %{"event" => event}} =
             agenda(c, "create", %{"calendar_id" => "primary", "event" => input()})

    assert event["id"] == "created"

    assert event["start"] == %{
             "date_time" => "2026-10-22T15:00:00-03:00",
             "time_zone" => "America/Sao_Paulo"
           }

    assert [%{"tool_slug" => "GOOGLECALENDAR_CREATE_EVENT", "arguments" => args}] = tools(c)

    assert args == %{
             "calendar_id" => "primary",
             "summary" => "Revisão",
             "start_datetime" => "2026-10-22T15:00:00-03:00",
             "end_datetime" => "2026-10-22T16:30:00-03:00",
             "timezone" => "America/Sao_Paulo",
             "create_meeting_room" => false,
             "exclude_organizer" => true
           }

    assert {200, %{"event" => %{"all_day" => true, "start" => %{"date" => "2026-10-22"}}}} =
             agenda(c, "create", %{
               "calendar_id" => "primary",
               "event" =>
                 input(%{
                   "all_day" => true,
                   "start" => "2026-10-22",
                   "end" => "2026-10-24",
                   "recurrence" => "weekly",
                   "location" => "Sala 1"
                 })
             })

    assert %{
             "start_date" => "2026-10-22",
             "end_date" => "2026-10-24",
             "recurrence" => ["RRULE:FREQ=WEEKLY"],
             "location" => "Sala 1"
           } = List.last(tools(c))["arguments"]
  end

  test "update patches only the sent fields of one occurrence", c do
    assert {200, %{"event" => %{"title" => "Novo"}}} =
             agenda(c, "update", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z",
               "scope" => "instance",
               "etag" => "\"i19\"",
               "patch" => %{"title" => "Novo"}
             })

    assert ["GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_PATCH_EVENT"] = slugs(c)

    assert List.last(tools(c))["arguments"] == %{
             "calendar_id" => "primary",
             "event_id" => "weekly_20261019T130000Z",
             "summary" => "Novo"
           }
  end

  test "a changed etag is a conflict and nothing is written", c do
    assert {422, %{"error" => "calendar_event_conflict"}} =
             agenda(c, "update", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z",
               "scope" => "instance",
               "etag" => "\"stale\"",
               "patch" => %{"title" => "Novo"}
             })

    assert {422, %{"error" => "calendar_event_conflict"}} =
             agenda(c, "delete", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z",
               "scope" => "instance",
               "etag" => "\"stale\""
             })

    assert Enum.uniq(slugs(c)) == ["GOOGLECALENDAR_EVENTS_GET"]
  end

  test "series scope shifts the series by the occurrence move and moves calendars first", c do
    assert {200, %{"event" => %{"id" => "weekly"}}} =
             agenda(c, "update", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261026T130000Z",
               "scope" => "series",
               "target_calendar_id" => "team@group.calendar.google.com",
               "patch" => %{
                 "start" => "2026-10-27T14:00:00-03:00",
                 "end" => "2026-10-27T15:30:00-03:00",
                 "all_day" => false,
                 "time_zone" => "America/Sao_Paulo"
               }
             })

    assert [
             "GOOGLECALENDAR_EVENTS_GET",
             "GOOGLECALENDAR_EVENTS_GET",
             "GOOGLECALENDAR_EVENTS_MOVE",
             "GOOGLECALENDAR_PATCH_EVENT"
           ] = slugs(c)

    [_, _, move, patch] = tools(c)

    assert move["arguments"] == %{
             "calendar_id" => "primary",
             "event_id" => "weekly",
             "destination" => "team@group.calendar.google.com"
           }

    # One day and four hours later, now 90 minutes long, from the series start.
    assert patch["arguments"] == %{
             "calendar_id" => "team@group.calendar.google.com",
             "event_id" => "weekly",
             "start_time" => "2026-10-20T14:00:00-03:00",
             "end_time" => "2026-10-20T15:30:00-03:00",
             "timezone" => "America/Sao_Paulo"
           }
  end

  test "an occurrence cannot change calendars or recurrence alone", c do
    for patch <- [%{"recurrence" => "daily"}] do
      assert {422, %{"error" => "invalid_composio_request"}} =
               agenda(c, "update", %{
                 "calendar_id" => "primary",
                 "event_id" => "weekly_20261019T130000Z",
                 "scope" => "instance",
                 "patch" => patch
               })
    end

    assert {422, %{"error" => "invalid_composio_request"}} =
             agenda(c, "update", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z",
               "scope" => "instance",
               "target_calendar_id" => "other",
               "patch" => %{"title" => "x"}
             })

    refute "GOOGLECALENDAR_PATCH_EVENT" in slugs(c)
  end

  test "delete with series scope removes the series", c do
    assert {200, %{"deleted" => true}} =
             agenda(c, "delete", %{
               "calendar_id" => "primary",
               "event_id" => "weekly_20261019T130000Z",
               "scope" => "series"
             })

    assert %{"tool_slug" => "GOOGLECALENDAR_DELETE_EVENT", "arguments" => args} =
             List.last(tools(c))

    assert args == %{"calendar_id" => "primary", "event_id" => "weekly"}
  end

  test "Google 403 on a write asks for write permission, on a read denies access", c do
    respond(c, fn
      "GOOGLECALENDAR_CREATE_EVENT", _ -> {:error, "403 Forbidden: insufficientPermissions"}
      "GOOGLECALENDAR_LIST_CALENDARS", _ -> {:error, "403 Forbidden: insufficientPermissions"}
    end)

    assert {422, %{"error" => "calendar_write_permission_required"}} =
             agenda(c, "create", %{"calendar_id" => "primary", "event" => input()})

    assert {422, %{"error" => "composio_access_denied"}} = agenda(c, "calendars")
  end

  test "provider failures reach neither the response nor the log with secrets", c do
    secret = "Bearer ya29.private-google-token x-api-key: secret-key raw-provider-body"
    respond(c, fn _, _ -> {:error, "502 " <> secret} end)

    log =
      capture_log(fn ->
        response = agenda(c, "create", %{"calendar_id" => "primary", "event" => input()})
        assert {422, %{"error" => "provider_unavailable"} = body} = response
        refute Jason.encode!(body) =~ "private"
        send(self(), {:body, body})
      end)

    refute log =~ "ya29"
    refute log =~ "secret-key"
    refute log =~ "raw-provider-body"
    refute log =~ "private-connect-token"
  end
end
