defmodule CommaWeb.GoogleCalendarAgenda do
  @moduledoc """
  Member-facing closed Agenda action over a connected `googlecalendar` account.

  The client names an `operation`; `Salix.Control.ComposioConnect` owns the
  slug. Arguments follow the Composio tool schemas (version `20261010_00`,
  read with `composio execute <slug> --get-schema`), not the Google API.

  | C1 operation | Composio slug and arguments |
  |---|---|
  | `calendars` | `GOOGLECALENDAR_LIST_CALENDARS` `max_results: 250`. Rows come in `data.calendars` (or `items`): `id`, `summary`/`summaryOverride` -> `name`, `backgroundColor` -> `color`, `primary`, `selected`, `accessRole` -> `access_role`. `writable` is `owner` or `writer`; `account_email` is the primary calendar id. |
  | `events` | `GOOGLECALENDAR_LIST_CALENDARS` once for access roles, then `GOOGLECALENDAR_EVENTS_LIST` once per page and calendar: `calendarId`, `timeMin`, `timeMax`, `timeZone`, `singleEvents: true`, `orderBy: "startTime"`, `showDeleted: false`, `maxResults: 250`, `pageToken`. |
  | `event` | `GOOGLECALENDAR_EVENTS_GET` `calendar_id`, `event_id`; for an occurrence, again with its `recurringEventId` to classify the series `recurrence`. |
  | `create` | `GOOGLECALENDAR_CREATE_EVENT` `calendar_id`, `summary` (title), `start_datetime`/`end_datetime` + `timezone`, or `start_date`/`end_date` (all day, exclusive end), `location`, `description`, `recurrence: ["RRULE:FREQ=…"]`, `create_meeting_room: false`, `exclude_organizer: true`. |
  | `update` | `GOOGLECALENDAR_EVENTS_GET` (etag and series), then `GOOGLECALENDAR_EVENTS_MOVE` `calendar_id`, `event_id`, `destination` when `target_calendar_id` differs, then `GOOGLECALENDAR_PATCH_EVENT` `calendar_id`, `event_id`, `summary`, `start_time`/`end_time` (RFC3339, or dates when all day), `timezone`, `location`, `description`, `recurrence` (`[]` for none). |
  | `delete` | `GOOGLECALENDAR_EVENTS_GET`, then `GOOGLECALENDAR_DELETE_EVENT` `calendar_id`, `event_id`. |

  `scope: "series"` acts on the occurrence's `recurringEventId`; a time
  change moves the series by the occurrence's day shift and keeps the new
  time of day and duration. `scope: "instance"` acts on the occurrence id.
  The deployed design named `GOOGLECALENDAR_CALENDAR_LIST_LIST`; Composio
  answers that slug with `Tool_ToolNotFound`, so `LIST_CALENDARS` replaces it.
  In `events`, `editable` needs an `owner` or `writer` calendar and an event
  that is not locked, a birthday or from Gmail. When the role is unknown (the
  calendar list failed, or `event`, `create` and `update` answers) the event
  decides: own or calendar organizer, or guests may modify.
  """
  alias Comma.Workspaces
  alias SalixStore.ComposioAccess, as: Access
  alias Salix.Control.ComposioConnect, as: Connect
  alias CommaWeb.RecommendationComposioTransport, as: Transport
  alias CommaWeb.RecommendationMemberRead, as: Read

  @max_calendar_ids 25
  @max_days 62
  @max_events 2_500
  @max_bytes 1_000_000
  @max_pages 25
  @recurrences ~w(none daily weekly monthly yearly)
  @input_keys ~w(title start end all_day time_zone location description recurrence)
  # Google Calendar event palette, colorId 1..11.
  @event_colors %{
    "1" => "#7986cb",
    "2" => "#33b679",
    "3" => "#8e24aa",
    "4" => "#e67c73",
    "5" => "#f6bf26",
    "6" => "#f4511e",
    "7" => "#039be5",
    "8" => "#616161",
    "9" => "#3f51b5",
    "10" => "#0b8043",
    "11" => "#d50000"
  }
  @public_errors ~w(invalid_composio_request composio_access_denied calendar_write_permission_required calendar_event_conflict provider_unavailable provider_timeout read_only)a

  # Member-facing closed action: neither Agent consent nor Routine enrollment.
  def run(user, session, workspace_id, params) do
    with {:ok, request} <- request(params),
         {:ok, workspace} <- Workspaces.authorize(user, session, workspace_id),
         scope = scope(workspace, user["id"]),
         {:ok, account, binding} <- account(scope, params["account_id"]) do
      authorize = fn ->
        with {:ok, fresh} <- Workspaces.authorize(user, session, workspace_id),
             true <-
               Map.take(fresh, ~w(salix_tenant_id default_group_id)) ==
                 Map.take(workspace, ~w(salix_tenant_id default_group_id)),
             {:ok, ^account, ^binding} <- account(scope(fresh, user["id"]), params["account_id"]) do
          :ok
        else
          _ -> {:error, :composio_access_denied}
        end
      end

      call(scope, account, request, authorize)
    else
      error -> public(error)
    end
  end

  defp scope(w, user),
    do: %{tenant: w["salix_tenant_id"], group_id: w["default_group_id"], user_id: user}

  @doc """
  Runs a validated `request/1` against `account` of `scope` within 30 seconds.

  `authorize` returns `:ok` while the caller may still use the account. It runs
  before and after each provider call, and inside the executor before the effect.
  With `agent: true`, events carry `ical_uid`, a missing event is `:not_found`,
  and a write to a calendar with a known read-only role is `:read_only`.
  """
  def call(scope, account, request, authorize, opts \\ []) do
    request = if opts[:agent], do: Map.put(request, :agent, true), else: request

    execute = fn kind, operation, arguments ->
      executor =
        if kind == :write,
          do: &Connect.execute_calendar_write/7,
          else: &Connect.execute_calendar_read/7

      with :ok <- authorize.(),
           result =
             executor.(
               scope.tenant,
               scope.group_id,
               scope.user_id,
               account,
               operation,
               arguments,
               authorize
             ),
           :ok <- authorize.() do
        case result do
          {:error, :provider_forbidden} when kind == :write ->
            {:error, :calendar_write_permission_required}

          {:error, :provider_forbidden} ->
            {:error, :composio_access_denied}

          other ->
            other
        end
      end
    end

    Read.deadline(30_000)
    |> Read.within(fn ->
      with :ok <- writable(request, execute), do: perform(request, execute)
    end)
    |> public()
  end

  defp public({:ok, _} = ok), do: ok
  defp public({:error, :member_read_deadline}), do: {:error, :provider_timeout}
  defp public({:error, reason}) when reason in @public_errors, do: {:error, reason}

  defp public({:error, reason})
       when reason in [:forbidden, :not_found, :workspace_provisioning, :workspace_unavailable],
       do: {:error, reason}

  defp public(_), do: {:error, :provider_unavailable}

  @doc """
  The enabled ACTIVE `googlecalendar` account `id` of the scope's member, in
  the mode of a connected profile, with the profile's transport authorization.
  """
  def account(scope, id) do
    with true <- is_binary(id) and byte_size(id) in 1..256,
         {:ok, %{"status" => "connected", "mode" => mode} = profile} <-
           Access.profile(scope.tenant, scope.group_id, scope.user_id),
         true <- mode in ~w(connect project),
         {:ok, account} <- Access.account(scope.tenant, scope.group_id, scope.user_id, id),
         true <- calendar_account?(account, mode) do
      {:ok, account, Transport.authorization(profile)}
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  @doc "Whether a stored account is a usable Calendar account in profile `mode`."
  def calendar_account?(account, mode) do
    match?(
      %{"toolkit" => "googlecalendar", "enabled" => true, "status" => "ACTIVE", "mode" => ^mode},
      account
    )
  end

  ## Validation (C1)

  @doc "Validates C1 params (`account_id`, `operation` and its arguments) into a request."
  def request(%{"account_id" => id, "operation" => op} = p) when is_binary(id) do
    keys = Map.keys(p) -- ~w(account_id operation)

    result =
      case op do
        "calendars" ->
          if keys == [], do: {:ok, %{op: :calendars}}

        "events" ->
          with true <- only?(keys, ~w(calendar_ids time_min time_max time_zone)),
               ids when is_list(ids) and length(ids) in 1..@max_calendar_ids <- p["calendar_ids"],
               true <- Enum.all?(ids, &calendar_id?/1) and Enum.uniq(ids) == ids,
               {:ok, min} <- instant(p["time_min"]),
               {:ok, max} <- instant(p["time_max"]),
               diff = DateTime.diff(max, min),
               true <- diff > 0 and diff <= @max_days * 86_400,
               true <- time_zone?(p["time_zone"]) do
            {:ok,
             %{
               op: :events,
               ids: ids,
               time_min: p["time_min"],
               time_max: p["time_max"],
               time_zone: p["time_zone"]
             }}
          end

        "event" ->
          with true <- only?(keys, ~w(calendar_id event_id)) and length(keys) == 2,
               true <- calendar_id?(p["calendar_id"]) and event_id?(p["event_id"]) do
            {:ok, %{op: :event, calendar_id: p["calendar_id"], event_id: p["event_id"]}}
          end

        "create" ->
          with true <- only?(keys, ~w(calendar_id event)) and length(keys) == 2,
               true <- calendar_id?(p["calendar_id"]),
               %{} = input <- p["event"],
               true <- only?(Map.keys(input), @input_keys),
               true <-
                 Enum.all?(
                   ~w(title start end all_day time_zone recurrence),
                   &Map.has_key?(input, &1)
                 ),
               {:ok, input} <- fields(input) do
            {:ok, %{op: :create, calendar_id: p["calendar_id"], input: input}}
          end

        "update" ->
          with true <-
                 only?(keys, ~w(calendar_id event_id scope etag patch target_calendar_id)),
               {:ok, base} <- target(p),
               %{} = patch <- p["patch"],
               true <- only?(Map.keys(patch), @input_keys),
               {:ok, patch} <- fields(patch),
               target = p["target_calendar_id"],
               true <- is_nil(target) or calendar_id?(target),
               target = if(target == p["calendar_id"], do: nil, else: target),
               true <- patch != %{} or not is_nil(target) do
            {:ok, Map.merge(base, %{op: :update, patch: patch, target: target})}
          end

        "delete" ->
          with true <- only?(keys, ~w(calendar_id event_id scope etag)),
               {:ok, base} <- target(p) do
            {:ok, Map.put(base, :op, :delete)}
          end

        _ ->
          nil
      end

    case result do
      {:ok, _} = ok when byte_size(id) in 1..256 -> ok
      _ -> {:error, :invalid_composio_request}
    end
  end

  def request(_), do: {:error, :invalid_composio_request}

  defp target(p) do
    etag = p["etag"]

    if calendar_id?(p["calendar_id"]) and event_id?(p["event_id"]) and
         p["scope"] in ~w(instance series) and
         (is_nil(etag) or (is_binary(etag) and byte_size(etag) in 1..256)) do
      {:ok,
       %{calendar_id: p["calendar_id"], event_id: p["event_id"], scope: p["scope"], etag: etag}}
    end
  end

  # Checks each sent Input field; start, end and all_day travel together.
  defp fields(input) do
    times = Map.take(input, ~w(start end all_day))

    with true <- map_size(times) in [0, 3],
         true <- text?(input, "title", 1024, false),
         true <- text?(input, "location", 1024, true),
         true <- text?(input, "description", 8192, true),
         true <- not Map.has_key?(input, "recurrence") or input["recurrence"] in @recurrences,
         true <- not Map.has_key?(input, "time_zone") or time_zone?(input["time_zone"]),
         true <- map_size(times) == 0 or range?(times) do
      {:ok, input}
    else
      _ -> nil
    end
  end

  defp range?(%{"all_day" => true, "start" => s, "end" => e}) do
    with {:ok, s} <- date(s), {:ok, e} <- date(e), do: Date.compare(e, s) == :gt
  end

  defp range?(%{"all_day" => false, "start" => s, "end" => e}) do
    with {:ok, s} <- instant(s), {:ok, e} <- instant(e), do: DateTime.compare(e, s) == :gt
  end

  defp range?(_), do: false

  defp text?(input, key, max, nullable) do
    case Map.fetch(input, key) do
      :error -> true
      {:ok, nil} -> nullable
      {:ok, v} when is_binary(v) -> String.length(v) <= max and not String.contains?(v, <<0>>)
      _ -> false
    end
  end

  defp only?(keys, allowed), do: Enum.all?(keys, &(&1 in allowed))

  defp calendar_id?(id),
    do: is_binary(id) and byte_size(id) in 1..512 and Regex.match?(~r/^[^\s\/?\x00-\x1f]+$/u, id)

  defp event_id?(id),
    do: is_binary(id) and byte_size(id) in 1..1024 and Regex.match?(~r/^[A-Za-z0-9_\-]+$/, id)

  defp time_zone?(tz),
    do:
      is_binary(tz) and byte_size(tz) <= 64 and
        Regex.match?(~r/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){1,2})$/, tz)

  defp instant(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> {:ok, dt}
      _ -> :error
    end
  end

  defp instant(_), do: :error

  defp date(value) when is_binary(value) and byte_size(value) == 10, do: Date.from_iso8601(value)
  defp date(_), do: :error

  ## Operations

  # An Agent write first reads the calendar roles; a known read-only role
  # refuses it before any provider write.
  defp writable(%{agent: true, op: op} = r, execute) when op in [:create, :update, :delete] do
    with {:ok, roles} <- roles(execute) do
      if Enum.all?(
           [r.calendar_id, r[:target]],
           &(is_nil(roles[&1]) or roles[&1] in ~w(owner writer))
         ),
         do: :ok,
         else: {:error, :read_only}
    end
  end

  defp writable(_, _), do: :ok

  defp perform(%{op: :calendars}, execute) do
    with {:ok, data} <- execute.(:read, "calendars", %{"max_results" => 250}),
         rows when is_list(rows) <- data["calendars"] || data["items"] do
      calendars = rows |> Enum.take(250) |> Enum.flat_map(&calendar/1)
      primary = Enum.find(calendars, & &1["primary"])
      {:ok, %{"account_email" => primary && primary["id"], "calendars" => calendars}}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_provider_response}
    end
  end

  # An Agent read without calendar ids reads the account's selected calendars.
  defp perform(%{op: :events, ids: :selected} = r, execute) do
    with {:ok, %{"calendars" => rows}} <- perform(%{op: :calendars}, execute) do
      ids = for(%{"selected" => true, "id" => id} <- rows, do: id) |> Enum.take(@max_calendar_ids)
      events(%{r | ids: ids}, role_map(rows), execute)
    end
  end

  defp perform(%{op: :events} = r, execute) do
    with {:ok, roles} <- roles(execute) do
      events(r, roles, execute)
    end
  end

  defp perform(%{op: :event} = r, execute) do
    with {:ok, event} <- get(execute, r.calendar_id, r.event_id),
         {:ok, rules} <- rules(execute, r.calendar_id, event),
         %{} = row <- event(event, r.calendar_id, nil, r) do
      {:ok, %{"event" => Map.put(row, "recurrence", classify(rules, event["start"]))}}
    else
      {:error, :provider_not_found} -> missing(r, :invalid_composio_request)
      {:error, _} = error -> error
      _ -> {:error, :invalid_provider_response}
    end
  end

  defp perform(%{op: :create} = r, execute) do
    input = r.input

    args =
      %{
        "calendar_id" => r.calendar_id,
        "summary" => input["title"],
        "create_meeting_room" => false,
        "exclude_organizer" => true
      }
      |> Map.merge(create_times(input))
      |> put_text("location", input["location"])
      |> put_text("description", input["description"])
      |> put_rule(input["recurrence"])

    with {:ok, data} <- execute.(:write, "create", args),
         %{} = row <- data |> created() |> event(r.calendar_id, nil, r) do
      {:ok, %{"event" => row}}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_provider_response}
    end
  end

  defp perform(%{op: :update} = r, execute) do
    with {:ok, current} <- current_event(execute, r),
         recurring = is_binary(current["recurringEventId"]),
         true <- not recurring or r.scope == "series" or not instance_only_change?(r),
         id =
           if(r.scope == "series" and recurring,
             do: current["recurringEventId"],
             else: r.event_id
           ),
         {:ok, times} <- series_times(execute, r, current, id),
         calendar = r.target || r.calendar_id,
         {:ok, moved} <- move(execute, r, id),
         {:ok, data} <- patch(execute, calendar, id, Map.merge(r.patch, times), moved),
         %{} = row <- data |> created() |> event(calendar, nil, r) do
      {:ok, %{"event" => row}}
    else
      false -> {:error, :invalid_composio_request}
      {:error, _} = error -> error
      _ -> {:error, :invalid_provider_response}
    end
  end

  defp perform(%{op: :delete} = r, execute) do
    with {:ok, current} <- current_event(execute, r),
         id =
           if(r.scope == "series" and is_binary(current["recurringEventId"]),
             do: current["recurringEventId"],
             else: r.event_id
           ),
         {:ok, _} <-
           execute.(:write, "delete", %{"calendar_id" => r.calendar_id, "event_id" => id}) do
      {:ok, %{"deleted" => true}}
    else
      {:error, :provider_not_found} -> missing(r, :calendar_event_conflict)
      {:error, _} = error -> error
    end
  end

  # One calendar list read gives each calendar's access role, so an event on
  # a read-only calendar is never editable. Without it, the event alone decides.
  defp roles(execute) do
    case execute.(:read, "calendars", %{"max_results" => 250}) do
      {:ok, data} ->
        rows = data["calendars"] || data["items"]
        rows = if is_list(rows), do: Enum.flat_map(rows, &calendar/1), else: []
        {:ok, role_map(rows)}

      {:error, reason} when reason in [:composio_access_denied, :member_read_deadline] ->
        {:error, reason}

      _ ->
        {:ok, %{}}
    end
  end

  defp role_map(rows) do
    roles = Map.new(rows, &{&1["id"], &1["access_role"]})
    primary = Enum.find(rows, & &1["primary"])
    if primary, do: Map.put(roles, "primary", primary["access_role"]), else: roles
  end

  defp events(r, roles, execute) do
    initial =
      {:ok, %{events: [], bytes: 0, truncated: false, failed: [], roles: roles, request: r}}

    r.ids
    |> Enum.reduce_while(initial, fn id, {:ok, acc} ->
      if acc.truncated do
        {:halt, {:ok, acc}}
      else
        case calendar_events(r, id, acc, execute) do
          {:ok, acc} -> {:cont, {:ok, acc}}
          :failed -> {:cont, {:ok, %{acc | failed: acc.failed ++ [id]}}}
          {:error, _} = error -> {:halt, error}
        end
      end
    end)
    |> case do
      {:ok, acc} ->
        {:ok,
         %{
           "events" => Enum.reverse(acc.events),
           "truncated" => acc.truncated,
           "failed_calendar_ids" => acc.failed
         }}

      error ->
        error
    end
  end

  # Pages of one calendar. A cycle or any failed page fails the whole
  # calendar: the caller never receives part of it as if it were complete.
  defp calendar_events(r, id, acc, execute) do
    base = %{
      "calendarId" => id,
      "timeMin" => r.time_min,
      "timeMax" => r.time_max,
      "timeZone" => r.time_zone,
      "singleEvents" => true,
      "orderBy" => "startTime",
      "showDeleted" => false,
      "maxResults" => 250
    }

    page(base, id, nil, MapSet.new(), 1, acc, execute)
  end

  defp page(base, id, token, seen, number, acc, execute) do
    args = if token, do: Map.put(base, "pageToken", token), else: base

    case execute.(:read, "events", args) do
      {:ok, %{"items" => items} = data} when is_list(items) ->
        acc = Enum.reduce_while(items, acc, &add_event(&1, id, &2))
        next = data["nextPageToken"] || data["next_page_token"]

        cond do
          acc.truncated or next in [nil, ""] -> {:ok, acc}
          not is_binary(next) or MapSet.member?(seen, next) -> :failed
          number >= @max_pages -> {:ok, %{acc | truncated: true}}
          true -> page(base, id, next, MapSet.put(seen, next), number + 1, acc, execute)
        end

      {:error, reason} when reason in [:composio_access_denied, :member_read_deadline] ->
        {:error, reason}

      _ ->
        :failed
    end
  end

  defp add_event(%{"status" => "cancelled"}, _, acc), do: {:cont, acc}

  defp add_event(item, id, acc) do
    case event(item, id, acc.roles[id], acc.request) do
      nil ->
        {:cont, acc}

      row ->
        bytes = acc.bytes + byte_size(Jason.encode!(row))

        if length(acc.events) >= @max_events or bytes > @max_bytes,
          do: {:halt, %{acc | truncated: true}},
          else: {:cont, %{acc | events: [row | acc.events], bytes: bytes}}
    end
  end

  defp get(execute, calendar, id),
    do: execute.(:read, "event", %{"calendar_id" => calendar, "event_id" => id})

  defp current_event(execute, r) do
    case get(execute, r.calendar_id, r.event_id) do
      {:ok, %{"status" => "cancelled"}} ->
        {:error, :calendar_event_conflict}

      {:ok, %{"etag" => etag}} when not is_nil(r.etag) and etag != r.etag ->
        {:error, :calendar_event_conflict}

      {:ok, %{"id" => _} = event} when is_nil(r.etag) or is_map_key(event, "etag") ->
        {:ok, event}

      {:ok, _} ->
        {:error, :calendar_event_conflict}

      {:error, :provider_not_found} ->
        missing(r, :calendar_event_conflict)

      error ->
        error
    end
  end

  defp missing(%{agent: true}, _agenda), do: {:error, :not_found}
  defp missing(_, agenda), do: {:error, agenda}

  defp instance_only_change?(r), do: Map.has_key?(r.patch, "recurrence") or not is_nil(r.target)

  defp rules(_execute, _calendar, %{"recurrence" => rules}) when is_list(rules), do: {:ok, rules}

  defp rules(execute, calendar, %{"recurringEventId" => series}) when is_binary(series) do
    with {:ok, master} <- get(execute, calendar, series), do: {:ok, master["recurrence"] || []}
  end

  defp rules(_, _, _), do: {:ok, []}

  # The series keeps its first date, moved by the occurrence's day shift.
  defp series_times(execute, r, current, id) do
    if id != r.event_id and Map.has_key?(r.patch, "start") do
      with {:ok, master} <- get(execute, r.calendar_id, id),
           {:ok, from} <- day(current["start"]),
           {:ok, to} <- day(%{"value" => r.patch["start"]}),
           {:ok, first} <- day(master["start"]) do
        anchor = Date.add(first, Date.diff(to, from))
        {:ok, anchored(r.patch, anchor)}
      else
        {:error, _} = error -> error
        _ -> {:error, :invalid_provider_response}
      end
    else
      {:ok, %{}}
    end
  end

  defp anchored(%{"all_day" => true} = p, anchor) do
    {:ok, s} = Date.from_iso8601(p["start"])
    {:ok, e} = Date.from_iso8601(p["end"])

    %{
      "start" => Date.to_iso8601(anchor),
      "end" => Date.to_iso8601(Date.add(anchor, Date.diff(e, s)))
    }
  end

  defp anchored(p, anchor) do
    {:ok, s, offset} = DateTime.from_iso8601(p["start"])
    {:ok, e, _} = DateTime.from_iso8601(p["end"])
    start = Date.to_iso8601(anchor) <> String.slice(p["start"], 10..-1//1)
    {:ok, anchored, _} = DateTime.from_iso8601(start)
    finish = DateTime.add(anchored, DateTime.diff(e, s))
    %{"start" => start, "end" => local(finish, offset)}
  end

  defp local(dt, offset) do
    naive = dt |> DateTime.add(offset) |> DateTime.to_naive() |> NaiveDateTime.truncate(:second)
    sign = if offset < 0, do: "-", else: "+"
    abs = abs(offset)

    NaiveDateTime.to_iso8601(naive) <>
      sign <>
      String.pad_leading("#{div(abs, 3600)}", 2, "0") <>
      ":" <> String.pad_leading("#{rem(div(abs, 60), 60)}", 2, "0")
  end

  defp day(%{"date" => d}), do: Date.from_iso8601(d)
  defp day(%{"dateTime" => dt}) when is_binary(dt), do: Date.from_iso8601(String.slice(dt, 0, 10))
  defp day(%{"value" => v}) when is_binary(v), do: Date.from_iso8601(String.slice(v, 0, 10))
  defp day(_), do: :error

  defp move(_execute, %{target: nil}, _id), do: {:ok, nil}

  defp move(execute, r, id),
    do:
      execute.(:write, "move", %{
        "calendar_id" => r.calendar_id,
        "event_id" => id,
        "destination" => r.target
      })

  defp patch(_execute, _calendar, _id, patch, moved) when map_size(patch) == 0, do: {:ok, moved}

  defp patch(execute, calendar, id, patch, _moved) do
    args =
      %{"calendar_id" => calendar, "event_id" => id}
      |> put_if(patch, "title", "summary", & &1)
      |> put_if(patch, "start", "start_time", & &1)
      |> put_if(patch, "end", "end_time", & &1)
      |> put_if(patch, "location", "location", &(&1 || ""))
      |> put_if(patch, "description", "description", &(&1 || ""))
      |> put_if(patch, "recurrence", "recurrence", &rule/1)

    args =
      if Map.has_key?(patch, "time_zone") and patch["all_day"] != true,
        do: Map.put(args, "timezone", patch["time_zone"]),
        else: args

    execute.(:write, "update", args)
  end

  defp put_if(args, patch, key, target, fun) do
    case Map.fetch(patch, key) do
      {:ok, value} -> Map.put(args, target, fun.(value))
      :error -> args
    end
  end

  defp create_times(%{"all_day" => true} = i),
    do: %{"start_date" => i["start"], "end_date" => i["end"]}

  defp create_times(i),
    do: %{
      "start_datetime" => i["start"],
      "end_datetime" => i["end"],
      "timezone" => i["time_zone"]
    }

  defp put_text(args, _key, value) when value in [nil, ""], do: args
  defp put_text(args, key, value), do: Map.put(args, key, value)
  defp put_rule(args, "none"), do: args
  defp put_rule(args, freq), do: Map.put(args, "recurrence", rule(freq))
  defp rule("none"), do: []
  defp rule(freq), do: ["RRULE:FREQ=" <> String.upcase(freq)]

  # Composio returns the created or patched event directly or wrapped.
  defp created(%{"response_data" => %{"id" => _} = event}), do: event
  defp created(%{"event" => %{"id" => _} = event}), do: event
  defp created(event), do: event

  ## Projections

  # The Agent projection also carries the iCalendar UID, to match one event
  # seen through two sources.
  defp event(e, calendar_id, role, %{agent: true}) do
    with %{} = row <- event(e, calendar_id, role) do
      uid = e["iCalUID"]
      Map.put(row, "ical_uid", if(is_binary(uid) and byte_size(uid) <= 1024, do: uid))
    end
  end

  defp event(e, calendar_id, role, _request), do: event(e, calendar_id, role)

  defp calendar(%{"id" => id} = row) do
    if calendar_id?(id) do
      role = row["accessRole"]

      [
        %{
          "id" => id,
          "name" => text(row["summaryOverride"] || row["summary"], 1024) || id,
          "color" => color(row["backgroundColor"]),
          "primary" => row["primary"] == true,
          "selected" => row["selected"] == true,
          "access_role" => if(is_binary(role) and byte_size(role) <= 64, do: role),
          "writable" => role in ~w(owner writer)
        }
      ]
    else
      []
    end
  end

  defp calendar(_), do: []

  defp event(%{"id" => id} = e, calendar_id, role) do
    with true <- event_id?(id),
         {:ok, start, all_day} <- time(e["start"]),
         {:ok, finish, ^all_day} <- time(e["end"]) do
      series = e["recurringEventId"]
      organizer = e["organizer"] || %{}

      %{
        "id" => id,
        "calendar_id" => calendar_id,
        "series_id" => if(event_id?(series), do: series),
        "title" => text(e["summary"], 1024) || "",
        "start" => start,
        "end" => finish,
        "all_day" => all_day,
        "location" => text(e["location"], 1024),
        "description" => text(e["description"], 8192),
        "url" => safe_url(e["htmlLink"]),
        "color" => @event_colors[e["colorId"]],
        "editable" =>
          e["locked"] != true and e["eventType"] not in ~w(birthday fromGmail) and
            if(is_binary(role),
              do: role in ~w(owner writer),
              else:
                organizer["self"] == true or e["guestsCanModify"] == true or
                  organizer["email"] == calendar_id
            ),
        "etag" => if(is_binary(e["etag"]) and byte_size(e["etag"]) <= 256, do: e["etag"])
      }
    else
      _ -> nil
    end
  end

  defp event(_, _, _), do: nil

  defp time(%{"date" => d}) when is_binary(d) do
    case date(d) do
      {:ok, _} -> {:ok, %{"date" => d}, true}
      _ -> :error
    end
  end

  defp time(%{"dateTime" => dt} = t) do
    case instant(dt) do
      {:ok, _} ->
        tz = if time_zone?(t["timeZone"]), do: t["timeZone"]
        {:ok, %{"date_time" => dt, "time_zone" => tz}, false}

      _ ->
        :error
    end
  end

  defp time(_), do: :error

  # Simple repetition: one RRULE with FREQ only, INTERVAL=1 or WKST, and for
  # weekly a single BYDAY on the start's weekday (Google's own weekly form).
  defp classify([], _start), do: "none"

  defp classify(["RRULE:" <> rule], start) do
    parts =
      rule
      |> String.split(";", trim: true)
      |> Map.new(fn part ->
        case String.split(part, "=", parts: 2) do
          [k, v] -> {String.upcase(k), v}
          [k] -> {String.upcase(k), ""}
        end
      end)

    freq = parts["FREQ"]
    rest = Map.drop(parts, ~w(FREQ WKST))
    rest = if rest["INTERVAL"] == "1", do: Map.delete(rest, "INTERVAL"), else: rest

    rest =
      if freq == "WEEKLY" and Map.keys(rest) == ["BYDAY"] and rest["BYDAY"] == weekday(start),
        do: %{},
        else: rest

    if freq in ~w(DAILY WEEKLY MONTHLY YEARLY) and rest == %{},
      do: String.downcase(freq),
      else: "custom"
  end

  defp classify(_, _), do: "custom"

  defp weekday(start) do
    case day(start || %{}) do
      {:ok, d} -> Enum.at(~w(MO TU WE TH FR SA SU), Date.day_of_week(d) - 1)
      _ -> nil
    end
  end

  defp text(v, max) when is_binary(v), do: String.slice(v, 0, max)
  defp text(_, _), do: nil

  defp color(v) when is_binary(v),
    do: if(Regex.match?(~r/^#[0-9a-fA-F]{6}$/, v), do: String.downcase(v))

  defp color(_), do: nil

  defp safe_url(value) when is_binary(value) and byte_size(value) <= 2083 do
    uri = URI.parse(value)

    if uri.scheme == "https" and uri.host in ~w(www.google.com calendar.google.com) and
         is_nil(uri.userinfo) and uri.port == 443 and is_binary(uri.path) and
         String.starts_with?(uri.path, "/calendar/"),
       do: value,
       else: nil
  end

  defp safe_url(_), do: nil
end
