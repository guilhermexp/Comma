defmodule CommaWeb.AgentCalendarSources.Mac do
  @moduledoc """
  The owner's Mac Calendar for the agent calendar tools (D4, C1, C4).

  The owner's desktop app answers through its Connector: the `calendar`
  method forwards to Electron Main's client-control `calendar` module over
  `CalendarService`. The device is the owner's group device that is
  `connected` and advertises the `calendar` capability; with several, the most
  recently connected one answers.

  The call goes to `SalixWeb.ConnectorRecovery`, not `SalixWeb.EnvDispatch`.
  The caller holds an owner, not an Agent id, and the Connector serves this
  method before its "Allow operations" gate, which `EnvDispatch` would apply
  as `permission_required`.

  Inputs and results use the C4 shapes; the Mac shapes stay here. Logs carry
  the operation, duration and error code only, never event text.
  """

  require Logger

  @ops ~w(state calendars events event create-event update-event delete-event)
  @device_page_limit 100
  # Main allows 30 s per EventKit call; the Connector hop gets a margin.
  @timeout_ms 35_000
  @event_fields %{
    "title" => "title",
    "start" => "start",
    "end" => "end",
    "all_day" => "allDay",
    "time_zone" => "timeZone",
    "location" => "location",
    "description" => "description",
    "recurrence" => "recurrence"
  }
  @error_codes %{
    "calendar_access_denied" => "mac_access_not_granted",
    "calendar_unavailable" => "mac_unavailable",
    "calendar_read_only" => "read_only",
    "calendar_event_not_found" => "not_found"
  }

  @type owner :: %{tenant: String.t(), group_id: String.t(), user_id: String.t()}

  @spec call(owner(), String.t(), map()) :: {:ok, map()} | {:error, String.t()}
  def call(owner, op, input) when op in @ops and is_map(input) do
    started_at = System.monotonic_time()

    result =
      with {:ok, target} <- device(owner),
           {:ok, response} <-
             dispatch().request(
               target,
               "calendar",
               %{"op" => op, "input" => request(op, input)},
               timeout: @timeout_ms
             ) do
        response(op, response)
      else
        {:error, reason} -> {:error, public_error(reason)}
      end

    log(op, result, started_at)
    result
  end

  def call(_owner, _op, _input), do: {:error, "invalid_operation"}

  defp device(%{tenant: tenant_id, group_id: group_id}) do
    case control().page_group_environments(group_id, tenant_id, limit: @device_page_limit) do
      {:ok, %{records: records}} ->
        records
        |> Enum.filter(&(&1["status"] == "connected" and calendar?(&1)))
        |> Enum.max_by(&(&1["connected_at"] || 0), fn -> nil end)
        |> target(tenant_id, group_id)

      {:error, _} ->
        {:error, :no_environment}
    end
  end

  defp calendar?(device), do: get_in(device, ["capabilities", "calendar"]) == true

  defp target(%{"connector_run_id" => run_id} = device, tenant_id, group_id)
       when is_binary(run_id) and run_id != "" do
    {:ok,
     %{
       connector_run_id: run_id,
       tenant_id: tenant_id,
       group_id: group_id,
       device_id: device["device_id"],
       process_instance_id: device["process_instance_id"]
     }}
  end

  defp target(_device, _tenant_id, _group_id), do: {:error, :no_environment}

  defp request(op, _input) when op in ~w(state calendars), do: %{}

  defp request("events", input) do
    %{
      "calendarIds" => input["calendar_ids"] || [],
      "start" => input["time_min"],
      "end" => input["time_max"]
    }
  end

  defp request("event", input), do: occurrence(input)

  defp request("create-event", input) do
    %{
      "calendarId" => input["calendar_id"],
      "event" => Map.put_new(event_input(input["event"]), "recurrence", "none")
    }
  end

  defp request("update-event", input) do
    input
    |> occurrence()
    |> Map.merge(%{"patch" => event_input(input["patch"]), "scope" => scope(input)})
    |> put_target_calendar(input)
  end

  defp request("delete-event", input),
    do: input |> occurrence() |> Map.put("scope", scope(input))

  defp occurrence(input),
    do: %{"eventId" => input["event_id"], "occurrenceDate" => input["occurrence"]}

  defp scope(input), do: input["scope"] || "instance"

  defp put_target_calendar(request, %{"target_calendar_id" => target} = input)
       when is_binary(target) and target != "" do
    if target == input["calendar_id"],
      do: request,
      else: Map.put(request, "targetCalendarId", target)
  end

  defp put_target_calendar(request, _input), do: request

  defp event_input(event) when is_map(event) do
    for {field, mac_field} <- @event_fields, Map.has_key?(event, field), into: %{} do
      {mac_field, event[field]}
    end
  end

  defp event_input(_event), do: %{}

  defp response(_op, %{"error" => code}), do: {:error, public_error(code)}
  defp response("state", state), do: {:ok, Map.take(state, ~w(access available))}

  defp response("calendars", %{"calendars" => calendars}) when is_list(calendars),
    do: {:ok, %{"calendars" => Enum.map(calendars, &calendar/1)}}

  defp response("events", %{"events" => events} = result) when is_list(events),
    do:
      {:ok, %{"events" => Enum.map(events, &event/1), "truncated" => result["truncated"] == true}}

  defp response("delete-event", _result), do: {:ok, %{}}

  defp response(op, %{"eventId" => _} = event) when op in ~w(event create-event update-event),
    do: {:ok, %{"event" => event(event)}}

  defp response(_op, _result), do: {:error, "mac_unavailable"}

  defp calendar(summary) do
    %{
      "calendar_ref" => calendar_ref(summary["id"]),
      "name" => summary["title"],
      "writable" => summary["writable"] == true,
      "color" => summary["color"]
    }
  end

  defp event(event) do
    %{
      "event_ref" => %{
        "source" => "mac",
        "account_id" => nil,
        "calendar_id" => event["calendarId"],
        "event_id" => event["eventId"],
        "occurrence" => event["occurrenceDate"],
        "etag" => nil
      },
      "calendar_ref" => calendar_ref(event["calendarId"]),
      "title" => event["title"],
      "start" => event["start"],
      "end" => event["end"],
      "all_day" => event["allDay"] == true,
      "time_zone" => nil,
      "location" => event["location"],
      "description" => event["notes"],
      "recurring" => event["recurrence"] not in [nil, "none"] or event["occurrenceDate"] != nil,
      "writable" => event["editable"] == true,
      "ical_uid" => event["externalId"]
    }
  end

  defp calendar_ref(calendar_id),
    do: %{"source" => "mac", "account_id" => nil, "calendar_id" => calendar_id}

  defp public_error(reason) when reason in [:no_environment, :disconnected],
    do: "desktop_offline"

  defp public_error(code) when is_map_key(@error_codes, code), do: @error_codes[code]
  defp public_error(_reason), do: "mac_unavailable"

  defp log(op, result, started_at) do
    duration_ms =
      System.convert_time_unit(System.monotonic_time() - started_at, :native, :millisecond)

    case result do
      {:ok, _} ->
        Logger.debug("agent calendar mac #{op} ok", duration_ms: duration_ms)

      {:error, code} ->
        Logger.info("agent calendar mac #{op} failed: #{code}", duration_ms: duration_ms)
    end
  end

  defp config, do: Application.get_env(:comma_web, __MODULE__, [])
  defp control, do: Keyword.get(config(), :control, SalixEnv.Control)
  defp dispatch, do: Keyword.get(config(), :dispatch, SalixWeb.ConnectorRecovery)
end
