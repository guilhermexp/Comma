defmodule SalixVoice.CallTrace do
  @moduledoc false

  # The CallActor owns this state and is the only process that starts a write.
  # A task may perform storage I/O, but never owns or advances the call.
  alias SalixStore.ULID
  alias SalixVoice.{CallTraceRecords, Telemetry}

  @interval_ms 2_000
  @batch_size 50
  @max_records 2_000
  @max_bytes 4 * 1024 * 1024
  @marker_reserve 256

  def new(nil, _call_id, _started_mono), do: nil

  def new(agent_id, call_id, started_mono) do
    %{
      agent_id: agent_id,
      call_id: call_id,
      started_mono: started_mono,
      pending: [],
      pending_count: 0,
      count: 0,
      bytes: 0,
      last_id: nil,
      cache: nil,
      task: nil,
      retry: nil,
      timer: nil,
      truncated?: false,
      finishing?: false
    }
  end

  def record(nil, _type, _fields), do: nil
  def record(%{truncated?: true} = trace, _type, _fields), do: trace

  def record(trace, type, fields) do
    record = make_record(trace, type, fields)
    size = byte_size(Jason.encode!(record)) + 1 + missing_size_reserve(record)

    if trace.count < @max_records - 1 and trace.bytes + size <= @max_bytes - @marker_reserve do
      trace |> enqueue(record, size) |> maybe_flush()
    else
      marker = make_record(trace, "trace_truncated", %{})
      marker_size = byte_size(Jason.encode!(marker)) + 1
      trace |> enqueue(marker, marker_size) |> Map.put(:truncated?, true) |> maybe_flush()
    end
  rescue
    _ ->
      Telemetry.trace_dropped(1, "storage")
      trace
  catch
    _, _ ->
      Telemetry.trace_dropped(1, "storage")
      trace
  end

  defp missing_size_reserve(%{"attachments" => attachments}) when is_list(attachments) do
    Enum.count(attachments, &(not is_integer(&1["bytes"]))) * 20
  end

  defp missing_size_reserve(_), do: 0

  defp make_record(trace, type, fields) do
    Map.merge(fields, %{
      "id" => ULID.generate(trace.last_id),
      "at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "t_ms" =>
        max(
          System.convert_time_unit(
            System.monotonic_time() - trace.started_mono,
            :native,
            :millisecond
          ),
          0
        ),
      "type" => type
    })
  end

  defp enqueue(trace, record, size) do
    %{
      trace
      | pending: [record | trace.pending],
        pending_count: trace.pending_count + 1,
        count: trace.count + 1,
        bytes: trace.bytes + size,
        last_id: record["id"]
    }
  end

  defp maybe_flush(%{pending_count: 0, retry: nil} = trace), do: trace

  defp maybe_flush(%{pending_count: count, task: nil, retry: nil} = trace)
       when count >= @batch_size,
       do: flush(trace)

  defp maybe_flush(trace), do: schedule(trace)

  def on_timer(nil), do: nil
  def on_timer(trace), do: trace |> Map.put(:timer, nil) |> flush()

  def finish(nil, _fields), do: nil
  def finish(%{finishing?: true} = trace, _fields), do: trace

  def finish(trace, fields) do
    trace = trace |> record("call_ended", fields) |> Map.put(:finishing?, true)

    if trace.retry && trace.timer do
      trace
    else
      trace |> cancel_timer() |> flush()
    end
  end

  def finished?(nil), do: true
  def finished?(trace), do: trace.task == nil and trace.retry == nil and trace.pending_count == 0

  def owns_ref?(nil, _ref), do: false
  def owns_ref?(%{task: {%Task{ref: ref}, _, _}}, ref), do: true
  def owns_ref?(_trace, _ref), do: false

  def result(trace, ref, result) do
    Process.demonitor(ref, [:flush])
    {%Task{ref: ^ref}, batch, attempt} = trace.task
    trace = %{trace | task: nil}

    case result do
      {:ok, cache, _statuses, []} ->
        trace = %{trace | cache: cache}
        if trace.finishing?, do: flush(trace), else: maybe_flush(trace)

      {:ok, cache, _statuses, missing} when attempt == 1 ->
        trace |> Map.merge(%{cache: cache, retry: {missing, 2}}) |> schedule()

      {:ok, cache, _statuses, missing} ->
        Telemetry.trace_dropped(length(missing), "storage")
        trace = %{trace | cache: cache}
        if trace.finishing?, do: flush(trace), else: maybe_flush(trace)

      _ ->
        failed(trace, batch, attempt)
    end
  end

  def down(trace, ref), do: result(trace, ref, {:error, :task_failed})

  defp failed(trace, batch, 1) do
    trace |> Map.merge(%{cache: nil, retry: {batch, 2}}) |> schedule()
  end

  defp failed(trace, batch, 2) do
    Telemetry.trace_dropped(length(batch), "storage")
    trace = %{trace | cache: nil}
    if trace.finishing?, do: flush(trace), else: maybe_flush(trace)
  end

  defp flush(%{task: task} = trace) when not is_nil(task), do: trace

  defp flush(trace) do
    {batch, attempt, trace} =
      case trace.retry do
        {batch, attempt} ->
          {batch, attempt, %{trace | retry: nil}}

        nil ->
          {batch, rest} = trace.pending |> Enum.reverse() |> Enum.split(@batch_size)
          {batch, 1, %{trace | pending: Enum.reverse(rest), pending_count: length(rest)}}
      end

    if batch == [] do
      trace
    else
      agent_id = trace.agent_id
      call_id = trace.call_id
      cache = trace.cache

      task =
        try do
          Task.Supervisor.async_nolink(SalixVoice.TaskSupervisor, fn ->
            try do
              {records, missing} = enrich_attachments(agent_id, batch)

              case records do
                [] ->
                  {:ok, cache, [], missing}

                _ ->
                  with {:ok, cache} <- load_cache(cache, agent_id, call_id),
                       {:ok, updated, statuses} <-
                         CallTraceRecords.append(agent_id, call_id, cache, records) do
                    {:ok, updated, statuses, missing}
                  end
              end
            rescue
              _ -> {:error, :storage}
            catch
              _, _ -> {:error, :storage}
            end
          end)
        catch
          _, _ -> nil
        end

      if task, do: %{trace | task: {task, batch, attempt}}, else: failed(trace, batch, attempt)
    end
  end

  defp load_cache(nil, agent_id, call_id), do: CallTraceRecords.load(agent_id, call_id)
  defp load_cache(cache, _agent_id, _call_id), do: {:ok, cache}

  # Existing PTT clients send paths, not sizes. Resolve only missing metadata in
  # the write task; never read image bodies or delay the calling process.
  defp enrich_attachments(agent_id, records) do
    {ready, missing} =
      Enum.reduce(records, {[], []}, fn record, {ready, missing} ->
        case Map.get(record, "attachments") do
          attachments when is_list(attachments) ->
            case enrich_list(agent_id, attachments) do
              {:ok, enriched} -> {[Map.put(record, "attachments", enriched) | ready], missing}
              :error -> {ready, [record | missing]}
            end

          _ ->
            {[record | ready], missing}
        end
      end)

    {Enum.reverse(ready), Enum.reverse(missing)}
  end

  defp enrich_list(agent_id, attachments) do
    Enum.reduce_while(attachments, {:ok, []}, fn attachment, {:ok, acc} ->
      case attachment["bytes"] do
        n when is_integer(n) and n >= 0 ->
          {:cont, {:ok, [attachment | acc]}}

        _ ->
          with path when is_binary(path) <- attachment["path"],
               {:ok, ref} <- SalixIM.Ports.AgentWorkspace.file_ref(agent_id, path),
               n when is_integer(n) and n >= 0 <- ref[:size] || ref["size"] do
            {:cont, {:ok, [Map.put(attachment, "bytes", n) | acc]}}
          else
            _ -> {:halt, :error}
          end
      end
    end)
    |> case do
      {:ok, attachments} -> {:ok, Enum.reverse(attachments)}
      :error -> :error
    end
  rescue
    _ -> :error
  catch
    _, _ -> :error
  end

  defp schedule(%{timer: nil} = trace),
    do: %{trace | timer: Process.send_after(self(), :voice_trace_flush, @interval_ms)}

  defp schedule(trace), do: trace

  def cancel_timer(nil), do: nil
  def cancel_timer(%{timer: nil} = trace), do: trace

  def cancel_timer(trace) do
    Process.cancel_timer(trace.timer)
    %{trace | timer: nil}
  end

  def discard(nil), do: nil

  def discard(trace) do
    trace = cancel_timer(trace)

    in_flight =
      case trace.task do
        {%Task{} = task, batch, _} ->
          case Task.shutdown(task, :brutal_kill) do
            {:ok, {:ok, _, _, missing}} -> length(missing)
            _ -> length(batch)
          end

        nil ->
          0
      end

    retry =
      case trace.retry do
        {batch, _} -> length(batch)
        nil -> 0
      end

    count = in_flight + retry + trace.pending_count
    if count > 0, do: Telemetry.trace_dropped(count, "shutdown")
    %{trace | task: nil, retry: nil, pending: [], pending_count: 0}
  end
end
