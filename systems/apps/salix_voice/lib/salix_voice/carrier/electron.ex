defmodule SalixVoice.Carrier.Electron do
  @moduledoc """
  Caption transport for a renderer WebRTC peer. CallActor owns the call.
  One serial poll every 500 ms per caller, no scan or per-child RPC. Each
  read returns at most 200 events. The queue has a 512 KiB byte bound.
  Abandoned peers hang up after 60 seconds without a read. Terminal events
  remain readable for 60 seconds. Polling cannot extend that retention.
  """
  use GenServer, restart: :temporary
  @pg SalixVoice.PG

  def start_link(attrs), do: GenServer.start_link(__MODULE__, attrs)

  def start(attrs) do
    with {:ok, pid} <-
           DynamicSupervisor.start_child(SalixVoice.CallSupervisor, {__MODULE__, attrs}) do
      GenServer.call(pid, :answer, 65_000)
    end
  catch
    :exit, _ -> {:error, :subscription_access_unavailable}
  end

  def events(id, scope, after_cursor), do: request(id, {:events, scope, after_cursor})
  def hang_up(id, scope), do: request(id, {:hang_up, scope})

  defp request(id, message) do
    case :pg.get_members(@pg, {:electron_voice, id}) do
      [pid | _] -> GenServer.call(pid, message)
      _ -> {:error, :call_not_found}
    end
  catch
    :exit, _ -> {:error, :call_not_found}
  end

  @impl true
  def init(attrs) do
    {:ok,
     %{
       attrs: attrs,
       scope: {attrs.tenant_id, attrs.group_id, attrs.caller["value"]},
       call: nil,
       call_id: nil,
       answer: nil,
       waiter: nil,
       events: :queue.new(),
       bytes: 0,
       cursor: 0,
       closed: false,
       idle: nil
     }, {:continue, :admit}}
  end

  @impl true
  def handle_continue(:admit, state) do
    with {:ok, %{call_id: id}} <- SalixVoice.admit(state.attrs),
         {:ok, call, _info} <- SalixVoice.attach(id, self()) do
      Process.monitor(call)
      :pg.join(@pg, {:electron_voice, id}, self())
      {:noreply, renew(%{state | call: call, call_id: id, attrs: nil})}
    else
      {:error, reason} -> {:noreply, finish_answer(%{state | attrs: nil}, {:error, reason})}
    end
  end

  @impl true
  def handle_call(:answer, from, %{answer: nil} = state), do: {:noreply, %{state | waiter: from}}
  def handle_call(:answer, _from, state), do: {:reply, state.answer, state}

  def handle_call({:events, scope, cursor}, _from, %{scope: scope} = state) do
    items = :queue.to_list(state.events)

    first =
      case items do
        [{seq, _, _} | _] -> seq
        _ -> state.cursor + 1
      end

    events = for {seq, event, _} <- items, seq > cursor, do: event

    {:reply, {:ok, %{events: events, cursor: state.cursor, truncated: cursor < first - 1}},
     renew(state)}
  end

  def handle_call({:hang_up, scope}, _from, %{scope: scope} = state) do
    if state.call, do: send(state.call, {:voice_carrier, :hangup, :caller_hangup})
    {:reply, {:ok, %{ending: true}}, state}
  end

  def handle_call(_, _from, state), do: {:reply, {:error, :call_not_found}, state}

  @impl true
  def handle_info({:voice_call, :signaled, sdp}, state),
    do: {:noreply, finish_answer(state, {:ok, %{sdp: sdp, call_id: state.call_id}})}

  def handle_info({:voice_call, :started}, state),
    do: {:noreply, emit(state, %{kind: "started"})}

  def handle_info({:voice_call, :caption, role, turn, text, final?}, state),
    do:
      {:noreply,
       emit(state, %{kind: "caption", role: role, turn: turn, text: text, final: final?})}

  def handle_info({:voice_call, :error, code}, state) do
    state = if state.answer, do: state, else: finish_answer(state, {:error, code})
    {:noreply, emit(state, %{kind: "error", code: code})}
  end

  def handle_info({:voice_call, :end, reason}, state), do: {:noreply, closed(state, reason)}

  def handle_info({:DOWN, _, :process, _, _}, state),
    do: {:noreply, closed(state, :carrier_error)}

  def handle_info(:idle, state) do
    if state.call, do: send(state.call, {:voice_carrier, :hangup, :idle_timeout})
    {:noreply, state}
  end

  def handle_info(:expire, state), do: {:stop, :normal, state}
  def handle_info(_, state), do: {:noreply, state}

  defp finish_answer(state, answer) do
    if state.waiter, do: GenServer.reply(state.waiter, answer)
    state = %{state | answer: answer, waiter: nil}
    if match?({:error, _}, answer), do: closed(state, :model_error), else: state
  end

  defp closed(%{closed: true} = state, _), do: state

  defp closed(state, reason) do
    if state.idle, do: Process.cancel_timer(state.idle)
    Process.send_after(self(), :expire, 60_000)
    state = emit(%{state | closed: true, idle: nil}, %{kind: "closed", reason: reason})

    if state.answer,
      do: state,
      else: finish_answer(state, {:error, :subscription_access_unavailable})
  end

  defp renew(%{closed: true} = state), do: state

  defp renew(state) do
    if state.idle, do: Process.cancel_timer(state.idle)
    %{state | idle: Process.send_after(self(), :idle, 60_000)}
  end

  defp emit(state, event) do
    size = byte_size(Jason.encode!(event))

    trim(%{
      state
      | events: :queue.in({state.cursor + 1, event, size}, state.events),
        cursor: state.cursor + 1,
        bytes: state.bytes + size
    })
  end

  defp trim(state) do
    if state.bytes > 524_288 or :queue.len(state.events) > 200 do
      {{:value, {_, _, size}}, rest} = :queue.out(state.events)
      trim(%{state | events: rest, bytes: state.bytes - size})
    else
      state
    end
  end
end
