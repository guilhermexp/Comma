defmodule CommaWeb.AgentCalendarSources.MacTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias CommaWeb.AgentCalendarSources.Mac

  @owner %{tenant: "tenant-1", group_id: "group-1", user_id: "user-1"}
  @secret_title "Dentist with Ana"
  @secret_location "Rua Secreta 42"
  @secret_notes "bring the exam results"

  defmodule Control do
    def page_group_environments(group_id, tenant_id, opts) do
      send(self(), {:listed, group_id, tenant_id, opts})
      Process.get(:devices, {:ok, %{records: [], next_cursor: nil}})
    end
  end

  defmodule Dispatch do
    def request(target, method, params, opts) do
      send(self(), {:dispatched, target, method, params, opts})
      Process.get(:reply, {:ok, %{}})
    end
  end

  setup do
    previous = Application.get_env(:comma_web, Mac)
    Application.put_env(:comma_web, Mac, control: Control, dispatch: Dispatch)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:comma_web, Mac, previous),
        else: Application.delete_env(:comma_web, Mac)
    end)
  end

  defp devices(records), do: Process.put(:devices, {:ok, %{records: records, next_cursor: nil}})
  defp reply(result), do: Process.put(:reply, result)

  defp device(id, attrs \\ %{}) do
    Map.merge(
      %{
        "device_id" => id,
        "connector_run_id" => "run-#{id}",
        "process_instance_id" => "proc-#{id}",
        "status" => "connected",
        "connected_at" => 100,
        "capabilities" => %{"calendar" => true}
      },
      attrs
    )
  end

  defp mac_event(attrs \\ %{}) do
    Map.merge(
      %{
        "allDay" => false,
        "calendarId" => "cal-1",
        "detached" => false,
        "editable" => true,
        "end" => "2026-10-21T11:00:00-03:00",
        "eventId" => "item-1",
        "externalId" => "uid-1@google.com",
        "location" => @secret_location,
        "notes" => @secret_notes,
        "occurrenceDate" => "2026-10-21T13:00:00Z",
        "occurrenceId" => "item-1/RID=1",
        "recurrence" => "weekly",
        "start" => "2026-10-21T10:00:00-03:00",
        "title" => @secret_title,
        "url" => nil
      },
      attrs
    )
  end

  test "an owner without a connected calendar device is offline" do
    devices([
      device("cloud-vm", %{"capabilities" => %{"exec" => true}}),
      device("old-mac", %{"status" => "disconnected"}),
      device("old-app", %{"capabilities" => %{"calendar" => false}})
    ])

    assert Mac.call(@owner, "calendars", %{}) == {:error, "desktop_offline"}
    assert_received {:listed, "group-1", "tenant-1", [limit: 100]}
    refute_received {:dispatched, _, _, _, _}
  end

  test "a lost connector or environment is offline" do
    devices([device("mac")])

    for reason <- [:disconnected, :no_environment] do
      reply({:error, reason})
      assert Mac.call(@owner, "calendars", %{}) == {:error, "desktop_offline"}
    end

    Process.put(:devices, {:error, :not_found})
    assert Mac.call(@owner, "calendars", %{}) == {:error, "desktop_offline"}
  end

  test "Mac Calendar error codes become public codes" do
    devices([device("mac")])

    for {code, public} <- [
          {"calendar_access_denied", "mac_access_not_granted"},
          {"calendar_unavailable", "mac_unavailable"},
          {"calendar_read_only", "read_only"},
          {"calendar_event_not_found", "not_found"}
        ] do
      reply({:ok, %{"error" => code}})
      assert Mac.call(@owner, "calendars", %{}) == {:error, public}
    end

    reply({:error, "Comma client API returned HTTP 400"})
    assert Mac.call(@owner, "calendars", %{}) == {:error, "mac_unavailable"}
    reply({:error, :timeout})
    assert Mac.call(@owner, "calendars", %{}) == {:error, "mac_unavailable"}
  end

  test "the most recently connected calendar device answers" do
    devices([
      device("mac-old", %{"connected_at" => 100}),
      device("mac-new", %{"connected_at" => 200}),
      device("mac-off", %{"connected_at" => 300, "status" => "disconnected"})
    ])

    reply(
      {:ok,
       %{
         "calendars" => [
           %{
             "color" => "#ff0000",
             "id" => "cal-1",
             "isDefault" => true,
             "sourceTitle" => "iCloud",
             "sourceType" => "calDAV",
             "title" => "Home",
             "writable" => false
           }
         ]
       }}
    )

    assert Mac.call(@owner, "calendars", %{}) ==
             {:ok,
              %{
                "calendars" => [
                  %{
                    "calendar_ref" => %{
                      "source" => "mac",
                      "account_id" => nil,
                      "calendar_id" => "cal-1"
                    },
                    "name" => "Home",
                    "writable" => false,
                    "color" => "#ff0000"
                  }
                ]
              }}

    assert_received {:dispatched, target, "calendar", %{"op" => "calendars", "input" => %{}},
                     _opts}

    assert target == %{
             connector_run_id: "run-mac-new",
             tenant_id: "tenant-1",
             group_id: "group-1",
             device_id: "mac-new",
             process_instance_id: "proc-mac-new"
           }
  end

  test "events are read in the Mac shape and returned in the normalized shape" do
    devices([device("mac")])
    reply({:ok, %{"events" => [mac_event()], "truncated" => true}})

    assert {:ok, %{"events" => [event], "truncated" => true}} =
             Mac.call(@owner, "events", %{
               "calendar_ids" => ["cal-1"],
               "time_min" => "2026-10-19T00:00:00-03:00",
               "time_max" => "2026-10-26T00:00:00-03:00",
               "time_zone" => "America/Sao_Paulo"
             })

    assert_received {:dispatched, _target, "calendar",
                     %{
                       "op" => "events",
                       "input" => %{
                         "calendarIds" => ["cal-1"],
                         "start" => "2026-10-19T00:00:00-03:00",
                         "end" => "2026-10-26T00:00:00-03:00"
                       }
                     }, _opts}

    assert event == %{
             "event_ref" => %{
               "source" => "mac",
               "account_id" => nil,
               "calendar_id" => "cal-1",
               "event_id" => "item-1",
               "occurrence" => "2026-10-21T13:00:00Z",
               "etag" => nil
             },
             "calendar_ref" => %{"source" => "mac", "account_id" => nil, "calendar_id" => "cal-1"},
             "title" => @secret_title,
             "start" => "2026-10-21T10:00:00-03:00",
             "end" => "2026-10-21T11:00:00-03:00",
             "all_day" => false,
             "time_zone" => nil,
             "location" => @secret_location,
             "description" => @secret_notes,
             "recurring" => true,
             "writable" => true,
             "ical_uid" => "uid-1@google.com"
           }
  end

  test "writes translate the normalized input to the Mac Calendar input" do
    devices([device("mac")])
    reply({:ok, mac_event(%{"occurrenceDate" => nil, "recurrence" => "none"})})

    assert {:ok, %{"event" => %{"recurring" => false, "event_ref" => %{"occurrence" => nil}}}} =
             Mac.call(@owner, "create-event", %{
               "calendar_id" => "cal-1",
               "event" => %{
                 "title" => "Meeting",
                 "start" => "2026-10-22T15:00:00-03:00",
                 "end" => "2026-10-22T16:00:00-03:00",
                 "all_day" => false,
                 "time_zone" => "America/Sao_Paulo",
                 "location" => nil
               }
             })

    assert_received {:dispatched, _, "calendar",
                     %{
                       "op" => "create-event",
                       "input" => %{
                         "calendarId" => "cal-1",
                         "event" => %{
                           "title" => "Meeting",
                           "start" => "2026-10-22T15:00:00-03:00",
                           "end" => "2026-10-22T16:00:00-03:00",
                           "allDay" => false,
                           "timeZone" => "America/Sao_Paulo",
                           "location" => nil,
                           "recurrence" => "none"
                         }
                       }
                     }, _}

    reply({:ok, mac_event(%{"calendarId" => "cal-2"})})

    assert {:ok, %{"event" => %{"calendar_ref" => %{"calendar_id" => "cal-2"}}}} =
             Mac.call(@owner, "update-event", %{
               "calendar_id" => "cal-1",
               "event_id" => "item-1",
               "occurrence" => "2026-10-21T13:00:00Z",
               "scope" => "series",
               "etag" => nil,
               "patch" => %{"title" => "Moved", "all_day" => false},
               "target_calendar_id" => "cal-2"
             })

    assert_received {:dispatched, _, "calendar",
                     %{
                       "op" => "update-event",
                       "input" => %{
                         "eventId" => "item-1",
                         "occurrenceDate" => "2026-10-21T13:00:00Z",
                         "scope" => "series",
                         "patch" => %{"title" => "Moved", "allDay" => false},
                         "targetCalendarId" => "cal-2"
                       }
                     }, _}

    reply({:ok, %{}})

    assert Mac.call(@owner, "delete-event", %{
             "calendar_id" => "cal-1",
             "event_id" => "item-1",
             "scope" => "instance"
           }) == {:ok, %{}}

    assert_received {:dispatched, _, "calendar",
                     %{
                       "op" => "delete-event",
                       "input" => %{
                         "eventId" => "item-1",
                         "occurrenceDate" => nil,
                         "scope" => "instance"
                       }
                     }, _}

    reply({:ok, mac_event()})

    assert {:ok, %{"event" => %{"title" => @secret_title}}} =
             Mac.call(@owner, "event", %{"calendar_id" => "cal-1", "event_id" => "item-1"})

    assert_received {:dispatched, _, "calendar",
                     %{
                       "op" => "event",
                       "input" => %{"eventId" => "item-1", "occurrenceDate" => nil}
                     }, _}
  end

  test "unknown operations never reach the device" do
    devices([device("mac")])
    assert Mac.call(@owner, "request-access", %{}) == {:error, "invalid_operation"}
    refute_received {:dispatched, _, _, _, _}
  end

  test "logs carry no event text" do
    devices([device("mac")])

    log =
      capture_log([level: :debug], fn ->
        reply({:ok, %{"events" => [mac_event()], "truncated" => false}})

        Mac.call(@owner, "events", %{
          "time_min" => "2026-10-19T00:00:00-03:00",
          "time_max" => "2026-10-26T00:00:00-03:00"
        })

        reply({:ok, %{"error" => "calendar_read_only"}})

        Mac.call(@owner, "create-event", %{
          "calendar_id" => "cal-1",
          "event" => %{"title" => @secret_title, "location" => @secret_location}
        })
      end)

    for secret <- [@secret_title, @secret_location, @secret_notes] do
      refute log =~ secret
    end
  end
end
