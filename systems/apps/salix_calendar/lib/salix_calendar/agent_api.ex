defmodule SalixCalendar.AgentAPI do
  @moduledoc """
  The Comma source of the agent's calendar tools, in the unified calendar shape
  shared with Google and the Mac (`SalixAgent.CalendarSources`).

  A group has two Comma calendars. The Comma-local calendar holds Events that
  belong to one owner principal; only that owner reads, creates, edits or
  deletes them. The meeting-enrollment calendar is a read-only copy of the
  provider calendars a group enrolled for meetings; it exists only after an
  enrollment and is never created here. CalendarContext stays keyed by the
  internal OccurrenceRef, which every Comma `event_ref` carries as `occurrence`.

  `owner` is the server-resolved principal of the group's owner, or `nil` when
  none is available; the model never supplies it.
  """

  alias SalixCalendar.{Occurrences, Recurrence, Server}
  alias SalixStore.{Ids, JSON}

  @owner_subject_keys ~w(namespace tenant_id subject_id)
  @max_events 2_500
  @local_calendar_identity %{"kind" => "comma_local_default"}
  @meeting_calendar_identity %{"kind" => "meeting_enrollment", "version" => 1}
  @default_duration "PT30M"
  @patch_fields ~w(title start end time_zone location description all_day recurrence)

  @doc "The group's Comma calendars."
  def calendars(group_id, owner) do
    with {:ok, local} <- ensure_local_calendar(group_id),
         {:ok, meeting} <- meeting_calendar(group_id) do
      writable = match?({:ok, _}, validate_principal(group_id, owner))

      {:ok,
       %{
         "calendars" => [
           public_calendar(local, writable)
           | Enum.map(List.wrap(meeting), &public_calendar(&1, false))
         ]
       }}
    end
  end

  @doc """
  Events in `[range_start_ms, range_end_ms)`, earliest first, at most 2,500.

  `calendar_ids` (optional) restricts the Comma calendars read. Local Events are
  listed only for a valid owner.
  """
  def events(group_id, params, owner) when is_map(params) do
    params = JSON.stringify(params)
    range_start = params["range_start_ms"]
    range_end = params["range_end_ms"]
    limit = params["limit"] || @max_events

    with true <- is_integer(range_start) and is_integer(range_end) and range_start < range_end,
         true <- is_integer(limit) and limit > 0 and limit <= @max_events,
         true <- is_nil(params["calendar_ids"]) or is_list(params["calendar_ids"]),
         {:ok, local} <- ensure_local_calendar(group_id),
         {:ok, meeting} <- meeting_calendar(group_id),
         {:ok, local_events, local_cut} <-
           local_events(group_id, local, params, owner, range_start, range_end, limit),
         {:ok, meeting_events, meeting_cut} <-
           meeting_events(group_id, meeting, params, range_start, range_end, limit) do
      listed = Enum.sort_by(local_events ++ meeting_events, & &1.start_ms)

      {:ok,
       %{
         "events" => listed |> Enum.take(limit) |> Enum.map(& &1.event),
         "truncated" => local_cut or meeting_cut or length(listed) > limit
       }}
    else
      false -> {:error, :invalid_calendar_query}
      {:error, _} = error -> error
    end
  end

  @doc """
  One Event. A meeting-calendar Event needs its `occurrence` (OccurrenceRef) and
  also returns its CalendarContext.
  """
  def event(group_id, params, owner) when is_map(params) do
    params = JSON.stringify(params)

    case calendar_kind(group_id, params["calendar_id"]) do
      {:ok, :local} ->
        with {:ok, owner} <- read_owner(group_id, owner),
             {:ok, item} <- owned_item(group_id, params, owner),
             {:ok, view} <- local_view(item, params["occurrence"]) do
          {:ok, %{"event" => unified(item, view, true)}}
        end

      {:ok, :meeting} ->
        with occurrence_ref when is_map(occurrence_ref) <- params["occurrence"],
             {:ok, %{"item" => item, "occurrence" => view}} <-
               Occurrences.get(
                 group_id,
                 params["calendar_id"],
                 params["event_id"],
                 occurrence_ref
               ),
             {:ok, context} <- context(group_id, view["occurrence_ref"]) do
          {:ok, %{"event" => Map.put(unified(item, view, false), "context", context)}}
        else
          nil -> {:error, :invalid_occurrence_ref}
          {:error, _} = error -> error
        end

      {:error, _} = error ->
        error
    end
  end

  @doc """
  Create one Comma-local Event for the owner.

  `owner` and `creation_request_id` are server-owned; an exact retry resolves
  the already-created Event. Only the Comma-local calendar is writable.
  """
  def create(group_id, params, owner, creation_request_id) when is_map(params) do
    params = JSON.stringify(params)

    with {:ok, :local} <- writable_calendar(group_id, params["calendar_id"]),
         {:ok, owner} <- validate_principal(group_id, owner),
         true <- is_binary(creation_request_id) and creation_request_id != "",
         {:ok, proposal} <- proposal(params["event"]),
         {:ok, item} <-
           Server.create_local_item(
             group_id,
             params["calendar_id"],
             proposal,
             owner,
             creation_request_id
           ),
         {:ok, view} <- local_view(item, nil) do
      {:ok, %{"event" => unified(item, view, true)}}
    else
      false -> {:error, :invalid_creation_request}
      {:error, _} = error -> error
    end
  end

  @doc "Edit one owner's Comma-local Event; `etag` is the revision it was read at."
  def update(group_id, params, owner) when is_map(params) do
    params = JSON.stringify(params)

    with {:ok, :local} <- writable_calendar(group_id, params["calendar_id"]),
         :ok <- same_calendar(params),
         {:ok, owner} <- validate_principal(group_id, owner),
         {:ok, revision} <- revision(params["etag"]),
         {:ok, current} <- owned_item(group_id, params, owner),
         {:ok, patch} <- patch(params["patch"], current),
         {:ok, item} <-
           Server.update_local_item(
             group_id,
             params["calendar_id"],
             params["event_id"],
             owner,
             patch,
             revision
           ),
         {:ok, view} <- local_view(item, nil) do
      {:ok, %{"event" => unified(item, view, true)}}
    end
  end

  @doc "Delete one owner's Comma-local Event; `etag` is the revision it was read at."
  def delete(group_id, params, owner) when is_map(params) do
    params = JSON.stringify(params)

    with {:ok, :local} <- writable_calendar(group_id, params["calendar_id"]),
         {:ok, owner} <- validate_principal(group_id, owner),
         {:ok, revision} <- revision(params["etag"]),
         :ok <-
           Server.delete_local_item(
             group_id,
             params["calendar_id"],
             params["event_id"],
             owner,
             revision
           ) do
      {:ok, %{}}
    end
  end

  def update_context(group_id, params) when is_map(params) do
    params = JSON.stringify(params)
    occurrence_ref = params["occurrence_ref"]

    attrs =
      params
      |> Map.take(~w(expected_revision objective background agenda questions resource_refs))
      |> Map.put("updated_by", params["actor"])

    Server.update_context(group_id, params["calendar_id"], occurrence_ref, attrs)
  end

  @doc """
  Validate the requesting principal and resolve the private-feed subscription
  scope for the group's canonical local calendar.

  Returns only the scope; subscription issuance and delivery are the caller's
  concern, so the secret is never minted here.
  """
  def feed_scope(group_id, principal_ref) do
    with {:ok, owner} <- validate_principal(group_id, principal_ref),
         {:ok, calendar} <- ensure_local_calendar(group_id) do
      {:ok,
       %{
         "tenant_id" => owner["tenant_id"],
         "group_id" => group_id,
         "calendar_id" => calendar["calendar_id"],
         "subject_namespace" => owner["namespace"],
         "subject_id" => owner["subject_id"]
       }}
    end
  end

  # ---------------------------------------------------------------------------
  # Calendars
  # ---------------------------------------------------------------------------

  defp ensure_local_calendar(group_id),
    do:
      Server.ensure_calendar(group_id, @local_calendar_identity, %{
        name: "Comma",
        default_time_zone: "UTC"
      })

  defp meeting_calendar(group_id) do
    case Server.lookup_calendar(group_id, @meeting_calendar_identity) do
      {:ok, calendar} -> {:ok, calendar}
      {:error, :not_found} -> {:ok, nil}
      {:error, _} = error -> error
    end
  end

  defp calendar_kind(group_id, calendar_id) when is_binary(calendar_id) do
    with {:ok, local} <- ensure_local_calendar(group_id),
         {:ok, meeting} <- meeting_calendar(group_id) do
      cond do
        calendar_id == local["calendar_id"] -> {:ok, :local}
        is_map(meeting) and calendar_id == meeting["calendar_id"] -> {:ok, :meeting}
        true -> {:error, :not_found}
      end
    end
  end

  defp calendar_kind(_group_id, _calendar_id), do: {:error, :not_found}

  defp writable_calendar(group_id, calendar_id) do
    case calendar_kind(group_id, calendar_id) do
      {:ok, :meeting} -> {:error, :read_only}
      other -> other
    end
  end

  # There is one writable Comma calendar, so an Event cannot move between them.
  defp same_calendar(%{"target_calendar_id" => target, "calendar_id" => calendar_id})
       when is_binary(target) and target != calendar_id,
       do: {:error, :read_only}

  defp same_calendar(_params), do: :ok

  defp public_calendar(calendar, writable) do
    %{
      "calendar_ref" => calendar_ref(calendar["calendar_id"]),
      "name" => calendar["name"],
      "writable" => writable,
      "color" => nil
    }
  end

  defp calendar_ref(calendar_id),
    do: %{"source" => "comma", "account_id" => nil, "calendar_id" => calendar_id}

  defp selected?(_calendar_id, %{"calendar_ids" => nil}), do: true
  defp selected?(calendar_id, %{"calendar_ids" => ids}), do: calendar_id in ids
  defp selected?(_calendar_id, _params), do: true

  # ---------------------------------------------------------------------------
  # Events
  # ---------------------------------------------------------------------------

  defp local_events(group_id, local, params, owner, range_start, range_end, limit) do
    calendar_id = local["calendar_id"]

    with true <- selected?(calendar_id, params),
         {:ok, owner} <- validate_principal(group_id, owner),
         {:ok, items} <-
           Server.list_owner_items(group_id, calendar_id, owner, range_start, range_end) do
      listed =
        for item <- items,
            {:ok, views} <- [Recurrence.expand(item, range_start, range_end, limit: 1)],
            view <- views,
            do: %{start_ms: view["start_ms"], event: unified(item, view, true)}

      {:ok, listed, length(listed) > limit}
    else
      false ->
        {:ok, [], false}

      {:error, reason} when reason in [:missing_principal, :principal_tenant_mismatch] ->
        {:ok, [], false}

      {:error, _} = error ->
        error
    end
  end

  defp meeting_events(_group_id, nil, _params, _from, _to, _limit), do: {:ok, [], false}

  defp meeting_events(group_id, meeting, params, range_start, range_end, limit) do
    calendar_id = meeting["calendar_id"]

    if selected?(calendar_id, params) do
      with {:ok, occurrences, truncated} <-
             Occurrences.list_events(group_id, calendar_id, range_start, range_end, limit) do
        listed =
          Enum.map(occurrences, fn %{"item" => item, "occurrence" => view} ->
            %{start_ms: view["start_ms"], event: unified(item, view, false)}
          end)

        {:ok, listed, truncated}
      end
    else
      {:ok, [], false}
    end
  end

  defp owned_item(group_id, params, owner) do
    with {:ok, %{"owner_principal_ref" => item_owner} = item} <-
           Server.get_local_item(group_id, params["calendar_id"], params["event_id"]),
         true <- Map.take(item_owner, @owner_subject_keys) == owner do
      {:ok, item}
    else
      _ -> {:error, :not_found}
    end
  end

  defp local_view(item, occurrence_ref) do
    ref =
      if is_map(occurrence_ref),
        do: occurrence_ref,
        else: %{
          "calendar_id" => item["calendar_id"],
          "scheduling_link_id" => item["scheduling_link_id"],
          "recurrence_key" => %{"kind" => "single"}
        }

    case Recurrence.resolve(item, ref) do
      {:ok, view} -> {:ok, view}
      {:error, _} -> {:error, :not_found}
    end
  end

  defp context(group_id, %{"calendar_id" => calendar_id} = occurrence_ref) do
    case Server.get_context(group_id, calendar_id, occurrence_ref) do
      {:ok, context} -> {:ok, context}
      {:error, :not_found} -> {:ok, %{"revision" => 0}}
      {:error, _} = error -> error
    end
  end

  defp context(_group_id, _occurrence_ref), do: {:error, :invalid_occurrence_ref}

  defp unified(item, view, writable) do
    object = item["object"] || %{}
    effective = view["effective"] || %{}
    zone = effective["timeZone"] || object["timeZone"] || "UTC"
    all_day = all_day?(object)
    ref = calendar_ref(item["calendar_id"])

    %{
      "event_ref" =>
        Map.merge(ref, %{
          "event_id" => item["calendar_item_id"],
          "occurrence" => view["occurrence_ref"],
          "etag" => revision_tag(item["revision"])
        }),
      "calendar_ref" => ref,
      "title" => object["title"],
      "start" => instant(view["start_ms"], zone, all_day),
      "end" => instant(view["end_ms"], zone, all_day),
      "all_day" => all_day,
      "time_zone" => zone,
      "location" => location(object),
      "description" => object["description"],
      "recurring" => get_in(view, ["occurrence_ref", "recurrence_key", "kind"]) == "recurring",
      "writable" => writable,
      "ical_uid" => object["uid"]
    }
  end

  defp all_day?(object),
    do:
      object["showWithoutTime"] == true or
        (is_binary(object["start"]) and Regex.match?(~r/^\d{4}-\d{2}-\d{2}$/, object["start"]))

  defp instant(ms, zone, all_day) when is_integer(ms) do
    utc = DateTime.from_unix!(ms, :millisecond)

    zoned =
      case DateTime.shift_zone(utc, zone) do
        {:ok, shifted} -> shifted
        {:error, _} -> utc
      end

    if all_day,
      do: zoned |> DateTime.to_date() |> Date.to_iso8601(),
      else: zoned |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp instant(_ms, _zone, _all_day), do: nil

  defp location(object) do
    case object["locations"] do
      %{} = locations ->
        locations
        |> Enum.sort_by(fn {id, _} -> id end)
        |> Enum.find_value(fn {_id, value} -> is_map(value) && value["name"] end)

      _ ->
        nil
    end
  end

  defp revision_tag(revision) when is_integer(revision), do: Integer.to_string(revision)
  defp revision_tag(_revision), do: nil

  defp revision(nil), do: {:ok, nil}

  defp revision(etag) when is_binary(etag) do
    case Integer.parse(etag) do
      {revision, ""} when revision > 0 -> {:ok, revision}
      _ -> {:error, :calendar_event_conflict}
    end
  end

  defp revision(_etag), do: {:error, :calendar_event_conflict}

  # ---------------------------------------------------------------------------
  # Writes: unified Event fields to the local proposal
  # ---------------------------------------------------------------------------

  defp proposal(event) when is_map(event) do
    with :ok <- supported(event),
         zone when is_binary(zone) <- event["time_zone"],
         {:ok, start, start_at} <- wall_time(event["start"], zone),
         {:ok, duration} <- duration(start_at, event["end"], zone, @default_duration) do
      {:ok,
       event
       |> Map.take(~w(title description location))
       |> Map.merge(%{"start" => start, "time_zone" => zone, "duration" => duration})}
    else
      nil -> {:error, :invalid_time_zone}
      {:error, _} = error -> error
    end
  end

  defp proposal(_event), do: {:error, :invalid_event}

  defp patch(patch, current) when is_map(patch) do
    stored = current["object"] || %{}
    zone = patch["time_zone"] || stored["timeZone"]

    with :ok <- supported(patch),
         true <- Enum.all?(Map.keys(patch), &(&1 in @patch_fields)) or {:error, :invalid_event},
         {:ok, start, start_at} <- wall_time(patch["start"] || stored["start"], zone),
         {:ok, duration} <- patched_duration(patch, stored, start_at, zone) do
      {:ok,
       patch
       |> Map.take(~w(title description location))
       |> Map.merge(%{"start" => start, "time_zone" => zone, "duration" => duration})}
    end
  end

  defp patch(_patch, _current), do: {:error, :invalid_event}

  defp patched_duration(%{"end" => nil}, stored, _start_at, _zone),
    do: {:ok, stored["duration"] || @default_duration}

  defp patched_duration(%{"end" => _} = patch, _stored, start_at, zone),
    do: duration(start_at, patch["end"], zone, @default_duration)

  defp patched_duration(_patch, stored, _start_at, _zone),
    do: {:ok, stored["duration"] || @default_duration}

  # Local Events are timed and single (`SalixCalendar.LocalItem`).
  defp supported(event) do
    cond do
      event["all_day"] == true -> {:error, :unsupported_all_day_event}
      event["recurrence"] not in [nil, []] -> {:error, :unsupported_recurring_event}
      true -> :ok
    end
  end

  # An offset instant is shifted into the zone; a bare wall time is taken as is.
  defp wall_time(value, zone) when is_binary(value) and is_binary(zone) do
    with {:ok, naive} <- naive_in_zone(value, zone),
         {:ok, %{unix_ms: ms}} <- Recurrence.resolve_local_time(naive, zone) do
      {:ok, naive |> NaiveDateTime.truncate(:second) |> NaiveDateTime.to_iso8601(), ms}
    else
      _ -> {:error, :invalid_event_start}
    end
  end

  defp wall_time(_value, _zone), do: {:error, :invalid_event_start}

  defp naive_in_zone(value, zone) do
    case DateTime.from_iso8601(value) do
      {:ok, instant, _offset} ->
        with {:ok, zoned} <- DateTime.shift_zone(instant, zone),
             do: {:ok, DateTime.to_naive(zoned)}

      {:error, :missing_offset} ->
        NaiveDateTime.from_iso8601(value)

      {:error, _} = error ->
        error
    end
  end

  defp duration(_start_at, nil, _zone, default), do: {:ok, default}

  defp duration(start_at, finish, zone, _default) do
    with {:ok, _finish, finish_at} <- wall_time(finish, zone),
         seconds when seconds > 0 <- div(finish_at - start_at, 1_000) do
      {:ok, iso_duration(seconds)}
    else
      _ -> {:error, :invalid_event_end}
    end
  end

  defp iso_duration(seconds) do
    days = div(seconds, 86_400)
    hours = div(rem(seconds, 86_400), 3_600)
    minutes = div(rem(seconds, 3_600), 60)
    rest = rem(seconds, 60)

    time =
      [{hours, "H"}, {minutes, "M"}, {rest, "S"}]
      |> Enum.reject(fn {value, _unit} -> value == 0 end)
      |> Enum.map_join(fn {value, unit} -> "#{value}#{unit}" end)

    "P" <> if(days > 0, do: "#{days}D", else: "") <> if(time == "", do: "", else: "T" <> time)
  end

  # ---------------------------------------------------------------------------
  # Owner
  # ---------------------------------------------------------------------------

  defp read_owner(group_id, owner) do
    case validate_principal(group_id, owner) do
      {:ok, owner} -> {:ok, owner}
      {:error, _} -> {:error, :not_found}
    end
  end

  defp validate_principal(
         group_id,
         %{"namespace" => ns, "tenant_id" => tid, "subject_id" => sid} = ref
       )
       when is_binary(ns) and ns != "" and is_binary(tid) and is_binary(sid) and sid != "" do
    cond do
      not Ids.valid_group_id?(group_id) -> {:error, :invalid_calendar_owner_identity}
      tid != Ids.tenant_id_from_group!(group_id) -> {:error, :principal_tenant_mismatch}
      true -> {:ok, Map.take(ref, @owner_subject_keys)}
    end
  end

  defp validate_principal(_group_id, _ref), do: {:error, :missing_principal}
end
