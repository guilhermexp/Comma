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

  Every journaled event reaches `observe/7` with its journal record id, the
  journal's canonical order, including replays: deduplication is storage,
  not presentation, so an end that was journaled before a failed projection
  still applies when its retry settles as a duplicate. Application is
  idempotent. An event moves the presentation only when it names the
  admitted dispatch, the Connector run, and the execution that the canonical
  status owner admitted for the dispatch (`ExternalSessionStatus`).

  Each runtime's tool start and end come from its adapter's explicit status
  pair. An end advances the presentation's ended frontier to its record id.
  A start whose record id is not above that frontier is older in the journal
  than an applied end, so it is never presented: a start emitted before its
  own end cannot reopen it, however late it is journaled. Memory is the
  running operations and that one frontier. The most recently started
  running operation is shown with its start evidence (the Connector's
  observation time); when it ends, the latest remaining one is shown, else
  thinking.

  The owner renews the shown frame each `ActivityEvent.renew_interval_ms/0`
  while the canonical status still proves the exact admitted execution
  active with a valid observation (`ExternalSessionStore.presentation_authority/2`).
  A settled or failed turn, a failed dispatch, or lost authority (another
  dispatch or execution, a finished, unknown or unobservable status) ends it.
  """

  alias SalixAgent.{ActivityEvent, ActivityScope, ToolCallProvenance}

  # {start statuses, end statuses} per Connector adapter (salix-connect
  # claude_runtime.go, main.go Codex, pi_runtime.go, kimi_runtime.go).
  @tool_statuses %{
    "claude" => {~w(started), ~w(completed)},
    "codex" => {~w(started inProgress), ~w(completed failed declined)},
    "pi" => {~w(start), ~w(end)},
    "kimi" => {~w(tool.call.started shell.started), ~w(tool.result)}
  }

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
          ended_frontier: nil,
          next_index: 0
        }

      nil ->
        nil
    end
  end

  @doc """
  Apply one journaled Connector event (`record_id` is its journal id).
  `admitted_execution` returns the canonical `{dispatch_id, execution_id}`,
  read only until this dispatch's execution is known.
  """
  def observe(nil, _agent_id, _session_id, _run, _record_id, _event, _admitted), do: nil

  def observe(state, agent_id, session_id, run, record_id, %{} = event, admitted_execution)
      when is_binary(record_id) do
    event_execution = event["execution_id"]

    if event["dispatch_id"] == state.dispatch_id and
         (is_nil(state.connector_run_id) or run == state.connector_run_id) do
      case with_admitted_execution(state, admitted_execution) do
        %{execution_id: ^event_execution} = admitted ->
          apply_event(admitted, agent_id, session_id, record_id, event)

        %{} = admitted ->
          admitted

        nil ->
          state
      end
    else
      state
    end
  end

  def observe(state, _agent_id, _session_id, _run, _record_id, _event, _admitted), do: state

  @doc """
  Renew the shown frame while `authority` (from
  `ExternalSessionStore.presentation_authority/2`) proves this exact
  execution active; otherwise end the presentation.
  """
  def renew(nil, _agent_id, _session_id, _authority), do: nil

  def renew(state, agent_id, session_id, authority) do
    if authoritative?(state, authority) do
      case Map.values(state.running) do
        [] -> renew_thinking(state, agent_id, session_id)
        running -> ActivityEvent.renew_tool_calls(agent_id, session_id, running, state.scope)
      end

      state
    else
      finish(state, agent_id, session_id)
    end
  end

  defp renew_thinking(state, agent_id, session_id) do
    response_key = state.scope["response_identity"]

    case SalixAgent.ActivitySurface.get_session(agent_id, session_id) do
      %{"phase" => "thinking", "response_key" => ^response_key} ->
        ActivityEvent.thinking(agent_id, session_id, nil, state.scope)

      _moved_on ->
        :ok
    end
  end

  @doc "The dispatch failed, ended or lost authority."
  def finish(nil, _agent_id, _session_id), do: nil

  def finish(state, agent_id, session_id) do
    ActivityEvent.retire(agent_id, session_id, state.scope["response_identity"])
    nil
  end

  # Before the runtime's first lifecycle event, the dispatch is starting
  # without an admitted execution.
  defp authoritative?(state, {:ok, %{"dispatch_id" => dispatch_id} = status})
       when dispatch_id == state.dispatch_id do
    case {status["status"], state.execution_id} do
      {"running", execution_id} when is_binary(execution_id) ->
        status["execution_id"] == execution_id

      {"starting", nil} ->
        true

      _ended_lost_or_other ->
        false
    end
  end

  defp authoritative?(_state, _authority), do: false

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

  defp apply_event(state, agent_id, session_id, _record_id, %{"work_state" => work_state})
       when work_state in ["settled", "failed"],
       do: finish(state, agent_id, session_id)

  defp apply_event(
         state,
         agent_id,
         session_id,
         record_id,
         %{"type" => "operation", "operation_id" => id, "status" => status} = event
       )
       when is_binary(id) and id != "" and is_binary(status) do
    {starts, ends} = Map.get(@tool_statuses, event["provider"], {[], []})

    cond do
      status in starts and after_frontier?(state, record_id) ->
        start(state, agent_id, session_id, id, event)

      status in ends ->
        state = %{state | ended_frontier: max_id(state.ended_frontier, record_id)}
        stop(state, agent_id, session_id, id)

      true ->
        state
    end
  end

  defp apply_event(state, _agent_id, _session_id, _record_id, _event), do: state

  defp after_frontier?(%{ended_frontier: nil}, _record_id), do: true
  defp after_frontier?(%{ended_frontier: frontier}, record_id), do: record_id > frontier

  defp max_id(nil, record_id), do: record_id
  defp max_id(frontier, record_id), do: max(frontier, record_id)

  defp start(state, agent_id, session_id, id, event) do
    if Map.has_key?(state.running, id) do
      # A replayed start of a running call keeps its identity and start.
      state
    else
      running = %{
        call: %{"id" => id, "name" => event["name"], "args" => event["input"] || %{}},
        started_at: started_at(event["created_at"]),
        call_index: state.next_index
      }

      state = %{
        state
        | running: Map.put(state.running, id, running),
          next_index: state.next_index + 1
      }

      ActivityEvent.settle_tool_calls(
        agent_id,
        session_id,
        Map.values(state.running),
        state.scope
      )

      state
    end
  end

  defp stop(state, agent_id, session_id, id) do
    case Map.pop(state.running, id) do
      {nil, _running} ->
        state

      {_ended, running} ->
        shown = latest(state.running)
        state = %{state | running: running}

        if shown.call["id"] == id,
          do:
            ActivityEvent.settle_tool_calls(
              agent_id,
              session_id,
              Map.values(running),
              state.scope
            )

        state
    end
  end

  defp latest(running),
    do: running |> Map.values() |> Enum.max_by(&{&1.started_at || 0, &1.call_index})

  defp started_at(seconds) when is_integer(seconds) and seconds > 0, do: seconds
  defp started_at(_seconds), do: nil
end
