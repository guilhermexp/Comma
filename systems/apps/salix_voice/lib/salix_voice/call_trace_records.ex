defmodule SalixVoice.CallTraceRecords do
  @moduledoc """
  Per-call append-only trace over the shared segment log. The CallActor owns
  the sole writer; a call is not resumed after its owner is lost.
  """

  alias SalixStore.{Keys, SegmentLog, ULID}

  def load(agent_id, call_id), do: SegmentLog.load(opts(agent_id, call_id))

  def append(agent_id, call_id, %SegmentLog{} = cache, records) when is_list(records),
    do: SegmentLog.append(cache, records, opts(agent_id, call_id))

  def tail(agent_id, call_id, %SegmentLog{} = cache, limit \\ 100, before \\ nil)
      when is_integer(limit) and limit > 0 do
    SegmentLog.tail(cache, min(limit, 500), before, opts(agent_id, call_id))
  end

  def read_trace(agent_id, call_id, options \\ []) do
    with {:ok, limit} <- read_limit(Keyword.get(options, :limit)),
         {:ok, before} <- read_cursor(Keyword.get(options, :before)),
         {:ok, %SegmentLog{segments: [%{first: first_id} | _], last_id: last_id} = cache} <-
           load(agent_id, call_id),
         {:ok, %{"type" => "call_started"} = started} <-
           SegmentLog.fetch(cache, first_id, opts(agent_id, call_id)),
         {:ok, last} <- SegmentLog.fetch(cache, last_id, opts(agent_id, call_id)),
         {:ok, events, has_more, next_before} <- tail(agent_id, call_id, cache, limit, before) do
      ended = last["type"] == "call_ended"

      {:ok,
       %{
         "call_id" => call_id,
         "mode" => started["mode"],
         "carrier" => started["carrier"],
         "router_agent_id" => agent_id,
         "started_at" => started["at"],
         "tenant_id" => started["tenant_id"],
         "group_id" => started["group_id"],
         "caller" => started["caller"],
         "ended" => ended,
         "end_reason" => if(ended, do: last["reason"]),
         "duration_ms" => if(ended, do: last["duration_ms"]),
         "event_count" => length(events),
         "has_more" => has_more,
         "next_before" => next_before,
         "events" => events
       }}
    else
      {:error, :invalid_input} = error -> error
      _ -> {:error, :call_not_found}
    end
  rescue
    ArgumentError -> {:error, :call_not_found}
  end

  defp read_limit(nil), do: {:ok, 100}
  defp read_limit(value) when is_integer(value) and value > 0, do: {:ok, min(value, 500)}

  defp read_limit(value) when is_binary(value) do
    case Integer.parse(value) do
      {n, ""} when n > 0 -> {:ok, min(n, 500)}
      _ -> {:error, :invalid_input}
    end
  end

  defp read_limit(_), do: {:error, :invalid_input}
  defp read_cursor(value) when value in [nil, ""], do: {:ok, nil}

  defp read_cursor(value),
    do: if(ULID.valid?(value), do: {:ok, value}, else: {:error, :invalid_input})

  defp opts(agent_id, call_id) do
    [
      prefix: Keys.agent_voice_call_segments_prefix(agent_id, call_id),
      decode_id: &decode_id/1,
      record_id: & &1["id"],
      validate: &validate/1,
      parse_cursor: &parse_cursor/1,
      stale_error: :stale_voice_call_segment,
      conflict_error: :voice_call_record_conflict,
      decode_error: :invalid_voice_call_segment
    ]
  end

  defp decode_id(id), do: if(ULID.valid?(id), do: {:ok, id}, else: :error)
  defp parse_cursor(before) when before in [nil, ""], do: nil
  defp parse_cursor(before), do: to_string(before)

  defp validate(record) when is_map(record) do
    if ULID.valid?(record["id"]) and is_binary(record["type"]) and
         is_binary(record["at"]) and is_integer(record["t_ms"]) and record["t_ms"] >= 0,
       do: :ok,
       else: {:error, :invalid_voice_call_record}
  end

  defp validate(_), do: {:error, :invalid_voice_call_record}
end
