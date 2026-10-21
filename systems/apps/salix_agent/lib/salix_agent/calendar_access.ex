defmodule SalixAgent.CalendarAccess do
  @moduledoc """
  The owner's calendars behind the agent calendar tools: the Comma calendar
  (`SalixAgent.Calendar`), every connected Google account and the Mac
  (`SalixAgent.CalendarSources`).

  Reads work in any run of the owner's agents, scheduled ones included. Sources
  are read in parallel, each under its own deadline; a source that fails or is
  late is reported in `sources` and never removes the others.

  Writes go to the event's own source and need the owner's own request: the
  sealed person of the current source message must be a Comma user, in this
  Group, without a schedule (`SalixAgent.AgentManagement.OwnerAuthority`), and
  must be the owner the port resolves. Routines, schedules, other people,
  Slack or Feishu senders and text read from events cannot write.
  """

  alias SalixAgent.AgentManagement.OwnerAuthority
  alias SalixAgent.{Calendar, CalendarSources}

  @max_days 62
  @max_events 2_500
  @max_description 2_000
  @google_calendar_batch 25
  @default_deadline_ms 35_000
  @scopes ~w(instance series)
  @event_fields ~w(title start end all_day time_zone location description recurrence)
  # C3 names these as atoms; the Mac implementation answers with strings.
  @mac_unavailable ~w(desktop_offline mac_access_not_granted mac_unavailable)
  # Which copy of the same event is primary: Google before Comma before the Mac.
  @precedence %{"google" => 0, "comma" => 1, "mac" => 2}

  # ---------------------------------------------------------------------------
  # Reads
  # ---------------------------------------------------------------------------

  @doc "Every calendar of the owner, with the status of each source."
  def calendars(agent_id) do
    owner = owner(agent_id)

    jobs =
      [{source_key("comma"), fn -> comma_calendars(agent_id, owner) end}] ++
        google_jobs(owner, &google_calendars/2) ++
        [{source_key("mac"), mac_job(owner, &mac_calendars/1)}]

    {results, statuses} = gather(owner, jobs)

    {:ok,
     %{
       "calendars" => Enum.flat_map(results, fn {_key, {calendars, _cut}} -> calendars end),
       "sources" => statuses
     }}
  end

  @doc "The owner's events in one period of at most 62 days, earliest first."
  def events(agent_id, args) do
    with {:ok, period} <- period(args),
         {:ok, selection} <- selection(args["calendar_refs"]) do
      owner = owner(agent_id)

      jobs =
        [{source_key("comma"), fn -> comma_events(agent_id, owner, period, selection) end}] ++
          google_jobs(owner, &google_events(&1, &2, period, selection)) ++
          [{source_key("mac"), mac_job(owner, &mac_events(&1, period, selection))}]

      jobs = Enum.filter(jobs, fn {key, _job} -> selected_source?(key, selection) end)
      {results, statuses} = gather(owner, jobs)

      events =
        results
        |> Enum.flat_map(fn {_key, {events, _cut}} -> events end)
        |> mark_duplicates()
        |> Enum.sort_by(&{start_key(&1), @precedence[source(&1)], event_id(&1)})

      {:ok,
       %{
         "events" => events,
         "truncated" => Enum.any?(statuses, &(&1["truncated"] == true)),
         "time_min" => args["time_min"],
         "time_max" => args["time_max"],
         "sources" => statuses
       }}
    end
  end

  @doc "One event, read from its own source."
  def event(agent_id, %{"event_ref" => ref}) when is_map(ref) do
    owner = owner(agent_id)

    with {:ok, result} <- one_source(ref, fn -> read_event(agent_id, owner, ref) end) do
      {:ok, %{"event" => normalize(result["event"])}}
    end
  end

  def event(_agent_id, _args), do: {:error, :invalid_event_ref}

  # ---------------------------------------------------------------------------
  # Writes
  # ---------------------------------------------------------------------------

  @doc "Create one event in the chosen calendar, on the owner's own request."
  def create(ctx, %{"calendar_ref" => calendar_ref, "event" => event})
      when is_map(calendar_ref) and is_map(event) do
    event = event |> Map.take(@event_fields) |> with_all_day()

    with {:ok, owner} <- write_owner(ctx),
         {:ok, request_id} <- creation_request_id(ctx),
         {:ok, source} <- source_of(calendar_ref) do
      args = %{"calendar_id" => calendar_ref["calendar_id"], "event" => event}

      write(source, calendar_ref, fn
        "comma" -> Calendar.create(ctx.agent_id, args, owner_ref(owner), request_id)
        "google" -> CalendarSources.google(owner, calendar_ref["account_id"], :create, args)
        "mac" -> CalendarSources.mac(owner, "create-event", args)
      end)
    end
  end

  def create(_ctx, _args), do: {:error, :invalid_event}

  @doc "Change one event (or its whole series) in its own calendar."
  def update(ctx, %{"event_ref" => ref, "patch" => patch} = args)
      when is_map(ref) and is_map(patch) do
    with {:ok, owner} <- write_owner(ctx),
         {:ok, source} <- source_of(ref),
         {:ok, scope} <- scope(args["scope"]),
         {:ok, target} <- target_calendar(ref, args["target_calendar_ref"]) do
      base = %{
        "calendar_id" => ref["calendar_id"],
        "event_id" => ref["event_id"],
        "scope" => scope,
        "patch" => patch |> Map.take(@event_fields) |> with_all_day()
      }

      write(source, ref, fn
        "comma" ->
          params =
            base
            |> Map.put("etag", ref["etag"])
            |> Map.put("target_calendar_id", target)

          Calendar.update(ctx.agent_id, params, owner_ref(owner))

        "google" ->
          args =
            compact(Map.merge(base, %{"etag" => ref["etag"], "target_calendar_id" => target}))

          CalendarSources.google(owner, ref["account_id"], :update, args)

        "mac" ->
          input =
            compact(
              Map.merge(base, %{"occurrence" => ref["occurrence"], "target_calendar_id" => target})
            )

          CalendarSources.mac(owner, "update-event", input)
      end)
    end
  end

  def update(_ctx, _args), do: {:error, :invalid_event_ref}

  @doc "Delete one event (or its whole series) from its own calendar."
  def delete(ctx, %{"event_ref" => ref} = args) when is_map(ref) do
    with {:ok, owner} <- write_owner(ctx),
         {:ok, source} <- source_of(ref),
         {:ok, scope} <- scope(args["scope"]) do
      base = %{
        "calendar_id" => ref["calendar_id"],
        "event_id" => ref["event_id"],
        "scope" => scope
      }

      write(source, ref, fn
        "comma" ->
          Calendar.delete(ctx.agent_id, Map.put(base, "etag", ref["etag"]), owner_ref(owner))

        "google" ->
          args = compact(Map.put(base, "etag", ref["etag"]))
          CalendarSources.google(owner, ref["account_id"], :delete, args)

        "mac" ->
          CalendarSources.mac(
            owner,
            "delete-event",
            compact(Map.put(base, "occurrence", ref["occurrence"]))
          )
      end)
    end
  end

  def delete(_ctx, _args), do: {:error, :invalid_event_ref}

  # ---------------------------------------------------------------------------
  # Owner and the write rule
  # ---------------------------------------------------------------------------

  defp owner(agent_id) do
    case CalendarSources.owner(agent_id) do
      {:ok, %{tenant: tenant, group_id: group_id, user_id: user_id} = owner}
      when is_binary(tenant) and is_binary(group_id) and is_binary(user_id) ->
        {:ok, owner}

      {:ok, _invalid} ->
        {:error, :owner_unavailable}

      {:error, _} = error ->
        error
    end
  end

  defp owner_ref({:ok, owner}), do: owner_ref(owner)
  defp owner_ref({:error, _}), do: nil

  defp owner_ref(%{tenant: tenant, user_id: user_id}),
    do: %{"namespace" => "comma_user", "tenant_id" => tenant, "subject_id" => user_id}

  defp write_owner(ctx) do
    with {:ok, owner} <- owner(ctx.agent_id),
         scope = %{group_id: owner.group_id, tenant_id: owner.tenant},
         {:ok, user_id} <- OwnerAuthority.sealed_person(scope, ctx),
         true <- user_id == owner.user_id do
      {:ok, owner}
    else
      _ -> {:error, :owner_request_required}
    end
  end

  # One source message may ask for several events: key idempotency by the
  # trusted source message plus the exact tool call; fail closed without both.
  defp creation_request_id(ctx) do
    source = Map.get(ctx, :source_message_id)
    tool_call = Map.get(ctx, :tool_call_id)

    if is_binary(source) and source != "" and is_binary(tool_call) and tool_call != "",
      do: {:ok, source <> ":" <> tool_call},
      else: {:error, :missing_creation_request}
  end

  # ---------------------------------------------------------------------------
  # Sources
  # ---------------------------------------------------------------------------

  defp source_key(source, account_id \\ nil), do: {source, account_id}

  defp google_jobs({:ok, owner}, read) do
    case CalendarSources.google_accounts(owner) do
      {:ok, []} ->
        [{source_key("google"), fn -> {:error, :not_connected} end}]

      {:ok, accounts} when is_list(accounts) ->
        Enum.map(accounts, fn %{"account_id" => id} ->
          {source_key("google", id), fn -> read.(owner, id) end}
        end)

      {:error, reason} ->
        [{source_key("google"), fn -> {:error, reason} end}]
    end
  end

  defp google_jobs({:error, reason}, _read),
    do: [{source_key("google"), fn -> {:error, owner_reason(reason)} end}]

  defp mac_job({:ok, owner}, read), do: fn -> read.(owner) end
  defp mac_job({:error, reason}, _read), do: fn -> {:error, owner_reason(reason)} end

  # No owner composition means the external sources are simply not connected.
  defp owner_reason(:not_configured), do: :not_connected
  defp owner_reason(_reason), do: :owner_unavailable

  defp comma_calendars(agent_id, owner) do
    with {:ok, %{"calendars" => calendars}} <- Calendar.calendars(agent_id, owner_ref(owner)),
         do: {:ok, calendars, false}
  end

  defp google_calendars(owner, account_id) do
    with {:ok, %{"calendars" => calendars}} <-
           CalendarSources.google(owner, account_id, :calendars, %{}),
         do: {:ok, calendars, false}
  end

  defp mac_calendars(owner) do
    with {:ok, %{"calendars" => calendars}} <- CalendarSources.mac(owner, "calendars", %{}),
         do: {:ok, calendars, false}
  end

  defp comma_events(agent_id, owner, period, selection) do
    params = %{
      "calendar_ids" => selected_ids(selection, source_key("comma")),
      "range_start_ms" => DateTime.to_unix(period.from, :millisecond),
      "range_end_ms" => DateTime.to_unix(period.to, :millisecond),
      "limit" => @max_events
    }

    with {:ok, %{"events" => events} = result} <-
           Calendar.events(agent_id, params, owner_ref(owner)),
         do: cap(events, result["truncated"] == true)
  end

  defp google_events(owner, account_id, period, selection) do
    with {:ok, ids} <-
           calendar_ids(selection, source_key("google", account_id), fn ->
             google_calendars(owner, account_id)
           end) do
      ids
      |> Enum.chunk_every(@google_calendar_batch)
      |> Enum.reduce_while({:ok, [], false}, fn batch, {:ok, acc, cut} ->
        case CalendarSources.google(owner, account_id, :events, events_args(batch, period)) do
          {:ok, %{"events" => events} = result} ->
            {:cont, {:ok, acc ++ events, cut or result["truncated"] == true}}

          {:error, _} = error ->
            {:halt, error}
        end
      end)
      |> case do
        {:ok, events, cut} -> cap(events, cut)
        error -> error
      end
    end
  end

  defp mac_events(owner, period, selection) do
    with {:ok, ids} <- calendar_ids(selection, source_key("mac"), fn -> mac_calendars(owner) end),
         {:ok, %{"events" => events} = result} <-
           CalendarSources.mac(owner, "events", events_args(ids, period)),
         do: cap(events, result["truncated"] == true)
  end

  defp events_args(ids, period),
    do:
      compact(%{
        "calendar_ids" => ids,
        "time_min" => period.time_min,
        "time_max" => period.time_max,
        "time_zone" => period.time_zone
      })

  defp calendar_ids(selection, key, list_calendars) do
    case selected_ids(selection, key) do
      nil ->
        with {:ok, calendars, _cut} <- list_calendars.(),
             do: {:ok, Enum.map(calendars, &get_in(&1, ["calendar_ref", "calendar_id"]))}

      ids ->
        {:ok, ids}
    end
  end

  # At most 2,500 events per source, the earliest ones.
  defp cap(events, truncated) when is_list(events) do
    sorted = Enum.sort_by(events, &start_key/1)
    {:ok, Enum.take(sorted, @max_events), truncated or length(sorted) > @max_events}
  end

  defp read_event(agent_id, owner, ref) do
    case ref["source"] do
      "comma" ->
        Calendar.event(
          agent_id,
          %{
            "calendar_id" => ref["calendar_id"],
            "event_id" => ref["event_id"],
            "occurrence" => ref["occurrence"]
          },
          owner_ref(owner)
        )

      external ->
        with {:ok, owner} <- external_owner(owner) do
          case external do
            "google" ->
              CalendarSources.google(owner, ref["account_id"], :event, %{
                "calendar_id" => ref["calendar_id"],
                "event_id" => ref["event_id"]
              })

            "mac" ->
              CalendarSources.mac(
                owner,
                "event",
                compact(%{
                  "calendar_id" => ref["calendar_id"],
                  "event_id" => ref["event_id"],
                  "occurrence" => ref["occurrence"]
                })
              )
          end
        end
    end
  end

  defp external_owner({:ok, owner}), do: {:ok, owner}
  defp external_owner({:error, reason}), do: {:error, owner_reason(reason)}

  # ---------------------------------------------------------------------------
  # Fan-out with a deadline per source
  # ---------------------------------------------------------------------------

  defp gather(_owner, jobs) do
    deadline = deadline_ms()

    tasks =
      Enum.map(jobs, fn {key, job} ->
        {key, Task.Supervisor.async_nolink(SalixAgent.TaskSup, job)}
      end)

    outcomes =
      tasks
      |> Enum.map(fn {_key, task} -> task end)
      |> Task.yield_many(timeout: deadline, on_timeout: :kill_task)
      |> Enum.zip(tasks)
      |> Enum.map(fn {{_task, outcome}, {key, _}} -> {key, outcome(outcome)} end)

    results =
      for {key, {:ok, items, truncated}} <- outcomes,
          do: {key, {Enum.map(items, &normalize/1), truncated}}

    statuses = Enum.map(outcomes, fn {key, outcome} -> status(key, outcome) end)
    {results, statuses}
  end

  defp one_source(ref, job) do
    with {:ok, _source} <- source_of(ref) do
      task = Task.Supervisor.async_nolink(SalixAgent.TaskSup, job)

      case outcome(Task.yield(task, deadline_ms()) || Task.shutdown(task, :brutal_kill)) do
        {:ok, result, _} -> {:ok, result}
        {:error, _} = error -> error
      end
    end
  end

  defp write(source, _ref, fun) do
    task = Task.Supervisor.async_nolink(SalixAgent.TaskSup, fn -> fun.(source) end)

    case outcome(Task.yield(task, deadline_ms()) || Task.shutdown(task, :brutal_kill)) do
      {:ok, %{"event" => event}, _} -> {:ok, %{"event" => normalize(event)}}
      {:ok, result, _} -> {:ok, result}
      {:error, :timeout} -> {:error, :write_timeout}
      {:error, _} = error -> error
    end
  end

  defp outcome({:ok, {:ok, items, truncated}}), do: {:ok, items, truncated}
  defp outcome({:ok, {:ok, result}}) when is_map(result), do: {:ok, result, false}
  defp outcome({:ok, {:error, reason}}), do: {:error, reason}
  defp outcome({:ok, _invalid}), do: {:error, :invalid_source_result}
  defp outcome({:exit, _reason}), do: {:error, :source_failed}
  defp outcome(nil), do: {:error, :timeout}

  defp deadline_ms,
    do: Application.get_env(:salix_agent, :calendar_source_deadline_ms, @default_deadline_ms)

  defp status({source, account_id}, outcome) do
    base =
      if is_nil(account_id),
        do: %{"source" => source},
        else: %{"source" => source, "account_id" => account_id}

    Map.merge(base, outcome_status(outcome))
  end

  defp outcome_status({:ok, _items, truncated}), do: %{"status" => "ok", "truncated" => truncated}

  defp outcome_status({:error, reason}) when reason in [:not_connected, "not_connected"],
    do: %{"status" => "not_connected"}

  defp outcome_status({:error, reason}) when is_atom(reason) or is_binary(reason) do
    text = reason_text(reason)

    if text in @mac_unavailable,
      do: %{"status" => "unavailable", "reason" => text},
      else: %{"status" => "error", "reason" => text}
  end

  defp outcome_status({:error, reason}),
    do: %{"status" => "error", "reason" => reason_text(reason)}

  defp reason_text(reason) when is_binary(reason), do: reason
  defp reason_text(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp reason_text(_reason), do: "source_failed"

  # ---------------------------------------------------------------------------
  # Arguments
  # ---------------------------------------------------------------------------

  defp period(%{"time_min" => min, "time_max" => max} = args)
       when is_binary(min) and is_binary(max) do
    with {:ok, from, _} <- DateTime.from_iso8601(min),
         {:ok, to, _} <- DateTime.from_iso8601(max),
         :lt <- DateTime.compare(from, to) do
      if DateTime.diff(to, from, :second) > @max_days * 86_400,
        do: {:error, :period_too_long},
        else:
          {:ok, %{from: from, to: to, time_min: min, time_max: max, time_zone: args["time_zone"]}}
    else
      _ -> {:error, :invalid_period}
    end
  end

  defp period(_args), do: {:error, :invalid_period}

  defp selection(nil), do: {:ok, nil}

  defp selection(refs) when is_list(refs) do
    if Enum.all?(refs, &match?({:ok, _}, source_of(&1))) do
      {:ok,
       Enum.group_by(
         refs,
         &source_key(&1["source"], if(&1["source"] == "google", do: &1["account_id"])),
         & &1["calendar_id"]
       )}
    else
      {:error, :invalid_calendar_ref}
    end
  end

  defp selection(_refs), do: {:error, :invalid_calendar_ref}

  defp selected_source?(_key, nil), do: true
  defp selected_source?(key, selection), do: Map.has_key?(selection, key)

  defp selected_ids(nil, _key), do: nil
  defp selected_ids(selection, key), do: Map.get(selection, key)

  defp source_of(%{"source" => source} = ref) when source in ~w(comma google mac) do
    cond do
      not is_binary(ref["calendar_id"]) or ref["calendar_id"] == "" ->
        {:error, :invalid_calendar_ref}

      source == "google" and not is_binary(ref["account_id"]) ->
        {:error, :invalid_calendar_ref}

      true ->
        {:ok, source}
    end
  end

  defp source_of(_ref), do: {:error, :invalid_calendar_ref}

  defp scope(nil), do: {:ok, "instance"}
  defp scope(scope) when scope in @scopes, do: {:ok, scope}
  defp scope(_scope), do: {:error, :invalid_scope}

  # A move stays inside the same source and account.
  defp target_calendar(_ref, nil), do: {:ok, nil}

  defp target_calendar(ref, %{"source" => source} = target) when is_map(target) do
    if source == ref["source"] and target["account_id"] == ref["account_id"] and
         is_binary(target["calendar_id"]),
       do: {:ok, target["calendar_id"]},
       else: {:error, :cross_source_move}
  end

  defp target_calendar(_ref, _target), do: {:error, :invalid_calendar_ref}

  # The model may omit all_day: a date-only start is an all-day event.
  defp with_all_day(%{"start" => start} = event) when is_binary(start),
    do: Map.put_new(event, "all_day", String.length(start) == 10)

  defp with_all_day(event), do: event

  defp compact(map), do: map |> Enum.reject(fn {_key, value} -> is_nil(value) end) |> Map.new()

  # ---------------------------------------------------------------------------
  # Events
  # ---------------------------------------------------------------------------

  defp normalize(%{"description" => description} = event)
       when is_binary(description) do
    if String.length(description) > @max_description,
      do:
        event
        |> Map.put("description", String.slice(description, 0, @max_description))
        |> Map.put("description_truncated", true),
      else: event
  end

  defp normalize(event), do: event

  defp mark_duplicates(events) do
    primaries =
      events
      |> Enum.filter(&(is_binary(&1["ical_uid"]) and &1["ical_uid"] != ""))
      |> Enum.group_by(&{&1["ical_uid"], start_key(&1)})
      |> Enum.flat_map(fn {_key, copies} ->
        [primary | _] = Enum.sort_by(copies, &{@precedence[source(&1)], event_id(&1)})

        for copy <- copies,
            origin(copy) != origin(primary),
            do: {copy["event_ref"], primary["event_ref"]}
      end)
      |> Map.new()

    Enum.map(events, fn event ->
      case Map.fetch(primaries, event["event_ref"]) do
        {:ok, primary} -> Map.put(event, "duplicate_of", primary)
        :error -> event
      end
    end)
  end

  defp origin(event), do: {source(event), get_in(event, ["event_ref", "account_id"])}
  defp source(event), do: get_in(event, ["event_ref", "source"])
  defp event_id(event), do: get_in(event, ["event_ref", "event_id"]) || ""

  # Comparable start instant; an all-day date starts at midnight in its zone.
  defp start_key(%{"start" => start} = event) when is_binary(start) do
    case DateTime.from_iso8601(start) do
      {:ok, instant, _} ->
        DateTime.to_unix(instant, :millisecond)

      _ ->
        with {:ok, date} <- Date.from_iso8601(start),
             {:ok, midnight} <- DateTime.new(date, ~T[00:00:00], event["time_zone"] || "Etc/UTC") do
          DateTime.to_unix(midnight, :millisecond)
        else
          _ -> 0
        end
    end
  end

  defp start_key(_event), do: 0
end
