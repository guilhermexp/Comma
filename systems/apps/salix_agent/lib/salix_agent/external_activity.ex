defmodule SalixAgent.ExternalActivity do
  @moduledoc """
  Activity presentation of one admitted external runtime dispatch, kept by the
  `SalixAgent.ExternalSessionActor` that owns the Session. It is transient
  presentation state, not a log: the durable record stays the Connector event
  journal in `SalixAgent.ExternalSessionStore`.

  The scope comes only from the dispatch the Session CAS admitted
  (`ExternalSessionStore.start_dispatch/7`) and the trusted origins of its
  admitted input (`SalixAgent.ActivityScope`). A dispatch without a provable
  scope presents nothing beyond generic Participant status.

  Only events the journal newly committed reach `observe/6`; its event-id
  deduplication keeps replays out. An event moves the presentation only when
  it names the admitted dispatch, the Connector run, and the execution that
  the canonical status owner admitted for that dispatch
  (`ExternalSessionStatus`); until that owner has admitted one, nothing
  moves. Each runtime's tool start and end come from its own adapter's
  explicit status pair; other operations do not present. An end is final:
  an ended id is never reopened while remembered, and the journal's
  deduplication covers replays of older ids. The most recently started
  running operation is shown with its start evidence (the Connector's
  observation time); when it ends, the latest remaining one is shown, else
  thinking. A settled or failed turn of the admitted execution, or a failed
  dispatch, ends the presentation with idle.

  The owner keeps an open presentation resident through quiet operations
  until it ends or `hold_ms/0` passes without an event, when the frame is
  retired. A new owner incarnation retires a frame it did not admit.
  """

  alias SalixAgent.{ActivityEvent, ActivityScope, ToolCallProvenance}

  # Ended ids remembered per dispatch, oldest forgotten first. A forgotten id
  # is still protected against replay by the journal's event-id dedup; only a
  # never-journaled start arriving after this many later ends could reopen it.
  @ended_limit 512
  @default_hold_ms 10 * 60_000

  # {start statuses, end statuses} per Connector adapter (salix-connect
  # claude_runtime.go, main.go Codex, pi_runtime.go, kimi_runtime.go).
  @tool_statuses %{
    "claude" => {~w(started), ~w(completed)},
    "codex" => {~w(started inProgress), ~w(completed failed declined)},
    "pi" => {~w(start), ~w(end)},
    "kimi" => {~w(tool.call.started shell.started), ~w(tool.result)}
  }

  @doc "How long an open presentation stays without any event."
  def hold_ms, do: Application.get_env(:salix_agent, :external_activity_hold_ms, @default_hold_ms)

  @doc "The presentation for a dispatch the Session CAS just admitted, or nil."
  def begin(agent_id, session_id, dispatch_id, connector_run_id, input_messages, source_ids) do
    origins =
      input_messages
      |> List.wrap()
      |> Enum.flat_map(fn
        %{"role" => "user", "trusted_origin" => %{} = origin} -> [origin]
        %{"role" => "runtime"} = message -> ToolCallProvenance.origins(message)
        _other -> []
      end)

    case ActivityScope.derive(
           agent_id,
           session_id,
           {:external_dispatch, dispatch_id},
           source_ids,
           origins
         ) do
      %{} = scope ->
        ActivityEvent.thinking(agent_id, session_id, nil, scope)

        %{
          dispatch_id: dispatch_id,
          connector_run_id: connector_run_id,
          execution_id: nil,
          scope: scope,
          running: %{},
          ended: {MapSet.new(), :queue.new()},
          next_index: 0,
          touched_ms: now_ms()
        }

      nil ->
        nil
    end
  end

  @doc """
  Apply one newly committed Connector event. `admitted_execution` returns the
  canonical `{dispatch_id, execution_id}`, read only until this dispatch's
  execution is known.
  """
  def observe(nil, _agent_id, _session_id, _connector_run_id, _event, _admitted), do: nil

  def observe(state, agent_id, session_id, connector_run_id, %{} = event, admitted_execution) do
    event_execution = event["execution_id"]

    if event["dispatch_id"] == state.dispatch_id and
         (is_nil(state.connector_run_id) or connector_run_id == state.connector_run_id) do
      case with_admitted_execution(state, admitted_execution) do
        %{execution_id: ^event_execution} = admitted ->
          apply_event(%{admitted | touched_ms: now_ms()}, agent_id, session_id, event)

        %{} = admitted ->
          admitted

        nil ->
          state
      end
    else
      state
    end
  end

  def observe(state, _agent_id, _session_id, _connector_run_id, _event, _admitted), do: state

  @doc "The dispatch failed before or without a terminal Connector event."
  def finish(nil, _agent_id, _session_id), do: nil

  def finish(state, agent_id, session_id) do
    ActivityEvent.idle(agent_id, session_id, state.scope)
    nil
  end

  @doc "No event for `hold_ms/0`: the presentation can no longer be vouched for."
  def expired?(nil), do: true
  def expired?(state), do: now_ms() - state.touched_ms > hold_ms()

  @doc "Retire an expired presentation's frame unless the surface moved on."
  def release(nil, _agent_id, _session_id), do: nil

  def release(state, agent_id, session_id) do
    ActivityEvent.retire(agent_id, session_id, state.scope["response_identity"])
    nil
  end

  defp with_admitted_execution(%{execution_id: id} = state, _admitted) when is_binary(id),
    do: state

  defp with_admitted_execution(state, admitted_execution) do
    case admitted_execution.() do
      {dispatch_id, execution_id} when dispatch_id == state.dispatch_id ->
        %{state | execution_id: execution_id}

      _not_admitted ->
        nil
    end
  end

  defp apply_event(state, agent_id, session_id, %{"work_state" => work_state})
       when work_state in ["settled", "failed"],
       do: finish(state, agent_id, session_id)

  defp apply_event(
         state,
         agent_id,
         session_id,
         %{"type" => "operation", "operation_id" => id, "status" => status} = event
       )
       when is_binary(id) and id != "" and is_binary(status) do
    {starts, ends} = Map.get(@tool_statuses, event["provider"], {[], []})

    cond do
      ended?(state, id) -> state
      status in starts -> start(state, agent_id, session_id, id, event)
      status in ends -> stop(state, agent_id, session_id, id)
      true -> state
    end
  end

  defp apply_event(state, _agent_id, _session_id, _event), do: state

  defp start(state, agent_id, session_id, id, event) do
    running =
      Map.get_lazy(state.running, id, fn ->
        %{
          call: %{"id" => id, "name" => event["name"], "args" => event["input"] || %{}},
          started_at: started_at(event["created_at"]),
          call_index: state.next_index
        }
      end)

    state = %{
      state
      | running: Map.put(state.running, id, running),
        next_index: state.next_index + 1
    }

    ActivityEvent.settle_tool_calls(agent_id, session_id, Map.values(state.running), state.scope)
    state
  end

  defp stop(state, agent_id, session_id, id) do
    shown = latest(state.running)

    state = %{
      state
      | running: Map.delete(state.running, id),
        ended: remember_ended(state.ended, id)
    }

    if shown && shown.call["id"] == id,
      do:
        ActivityEvent.settle_tool_calls(
          agent_id,
          session_id,
          Map.values(state.running),
          state.scope
        )

    state
  end

  defp latest(running) when map_size(running) == 0, do: nil

  defp latest(running),
    do: running |> Map.values() |> Enum.max_by(&{&1.started_at || 0, &1.call_index})

  defp ended?(%{ended: {ids, _order}}, id), do: MapSet.member?(ids, id)

  defp remember_ended({ids, order}, id) do
    {ids, order} = {MapSet.put(ids, id), :queue.in(id, order)}

    if MapSet.size(ids) > @ended_limit do
      {{:value, oldest}, order} = :queue.out(order)
      {MapSet.delete(ids, oldest), order}
    else
      {ids, order}
    end
  end

  defp started_at(seconds) when is_integer(seconds) and seconds > 0, do: seconds
  defp started_at(_seconds), do: nil

  defp now_ms, do: System.monotonic_time(:millisecond)
end
