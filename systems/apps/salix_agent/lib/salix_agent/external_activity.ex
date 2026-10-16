defmodule SalixAgent.ExternalActivity do
  @moduledoc """
  Activity presentation of one admitted external runtime dispatch, kept by the
  `SalixAgent.ExternalSessionActor` that owns the Session. It is transient
  presentation state, not a log: the durable record stays the Connector event
  journal in `SalixAgent.ExternalSessionStore`.

  The scope comes only from the dispatch the Session CAS admitted
  (`ExternalSessionStore.start_dispatch/7`) and the trusted origins of its
  admitted input (`SalixAgent.ActivityScope`). A dispatch without a provable
  scope presents nothing beyond generic Participant status. An actor that
  restarts mid-dispatch did not admit that dispatch in this incarnation, so it
  also presents nothing until the next admitted dispatch.

  A committed Connector event moves the presentation only when it names the
  admitted dispatch and Connector run. Per operation the transitions are
  idempotent: a replayed start keeps the same identity and start, an end is
  final, and a start that arrives after its own end is ignored. The most
  recently started running operation is shown with its start evidence (the
  Connector's observation time); when it ends, the latest remaining one is
  shown, else thinking. A settled or failed turn, or a failed dispatch, ends
  the presentation with idle, after which nothing from that dispatch shows.
  """

  alias SalixAgent.{ActivityEvent, ActivityScope, ToolCallProvenance}

  # Operation ids already ended in this dispatch. Bounded per dispatch; an id
  # evicted past this bound can no longer be recognized as ended.
  @ended_limit 512
  @start_statuses ~w(started inProgress in_progress running)

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
          scope: scope,
          running: %{},
          ended: MapSet.new(),
          next_index: 0
        }

      nil ->
        nil
    end
  end

  @doc "Apply one committed Connector event. Returns the next presentation."
  def observe(nil, _agent_id, _session_id, _connector_run_id, _event), do: nil

  def observe(state, agent_id, session_id, connector_run_id, %{} = event) do
    if event["dispatch_id"] == state.dispatch_id and
         (is_nil(state.connector_run_id) or connector_run_id == state.connector_run_id) do
      apply_event(state, agent_id, session_id, event)
    else
      state
    end
  end

  def observe(state, _agent_id, _session_id, _connector_run_id, _event), do: state

  @doc "The dispatch failed before or without a terminal Connector event."
  def finish(nil, _agent_id, _session_id), do: nil

  def finish(state, agent_id, session_id) do
    ActivityEvent.idle(agent_id, session_id, state.scope)
    nil
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
    cond do
      MapSet.member?(state.ended, id) ->
        state

      status in @start_statuses ->
        start(state, agent_id, session_id, id, event)

      Map.has_key?(state.running, id) ->
        stop(state, agent_id, session_id, id)

      true ->
        # An end without a seen start still closes the id against a late start.
        %{state | ended: remember_ended(state.ended, id)}
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

  defp remember_ended(ended, id) do
    ended = if MapSet.size(ended) >= @ended_limit, do: MapSet.new(), else: ended
    MapSet.put(ended, id)
  end

  defp started_at(seconds) when is_integer(seconds) and seconds > 0, do: seconds
  defp started_at(_seconds), do: nil
end
