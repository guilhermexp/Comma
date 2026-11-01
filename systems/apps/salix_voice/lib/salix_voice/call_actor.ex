defmodule SalixVoice.CallActor do
  @moduledoc """
  One live voice call (docs/messaging-voice.md).

  The actor runs on the node that holds the call's media and owns:

    * the caller profile (`SalixVoice.Profile`), decided before the model
      starts and waited for at most `profile_ms`; without it the model starts
      with the base instructions;
    * the model session (`SalixVoice.Model`), started at admission; caller
      audio that arrives before the model reports `:started` is buffered, up
      to the newest 2 s;
    * the carrier socket, attached once (`SalixVoice.attach/3`) and monitored;
    * the transcript ledger (`SalixVoice.Transcript`);
    * one call-start Router input, sent with the greeting, so the Router can
      speak before the caller asks anything, and one call-end Router input
      after it when the call ends;
    * pending delegations: each becomes Router provider input, gets one quiet
      `thinking` progress append at 20 s and one spoken apology at 90 s while
      the Router has not answered with `voice.say`;
    * the call deadline, voice key revocation and expiry, caller number
      removal, drain, and the one-active-call-per-Group rule;
    * billing and telemetry at the end.

  A `:push_to_talk` call (Electron Push-to-Talk) runs a GPT-Live session with
  concise responses, screen/tool requests delegated to the Router, no greeting,
  no profile blocking, a 600 s ceiling, and ingests screen context and attachments
  for the next delegation.

  `:pg` groups in `SalixVoice.PG`: `{:call, call_id}`, `:calls`,
  `{:group_call, group_id}` and, for a WebSocket call, `{:voice_key, key_id}`.
  When two calls of one Group race, the one with the later
  `{started_at_ms, call_id}` ends with reason `:busy`.

  The call owns its bounded, best-effort durable trace. Messages to and from
  other processes are listed in `SalixVoice`.
  """

  use GenServer, restart: :temporary

  require Logger

  alias SalixVoice.{CallTrace, Profile, Speech, Transcript}

  @pg SalixVoice.PG
  # The only voice settings a call keeps: what the model session needs. The
  # OpenAI key is dropped once the model has started.
  @model_setting_fields ~w(gpt_live_url gpt_live_model gpt_live_voice openai_api_key)
  @prebuffer_ms 2_000
  @max_say_chars 20_000

  @default_timers %{
    attach_twilio_ms: 20_000,
    attach_websocket_ms: 5_000,
    model_start_ms: 15_000,
    model_close_wait_ms: 3_000,
    delegation_settle_ms: 300,
    delegation_enqueue_wait_ms: 10_000,
    context_timeout_ms: 150_000,
    progress_thinking_ms: 20_000,
    progress_apology_ms: 90_000,
    notice_max_ms: 5_000,
    hangup_max_ms: 10_000,
    quiet_ms: 1_500,
    profile_ms: 2_500,
    max_call_ms: nil
  }

  # A call-end input waits at most this long for the call-start input to be
  # admitted, so the Router sees them in order.
  @call_started_wait_ms 10_000
  @delegation_enqueue_wait_ms 10_000

  @thinking_progress "The assistant is still working on it."
  @apology "Sorry, this is taking longer than expected. The assistant is still working on it."

  @instructions """
  You are the voice of the Comma assistant on a live call. Keep every reply short and \
  natural for speech. You cannot look things up or act on your own: for any request that \
  needs knowledge, tools, accounts or actions, delegate it, tell the caller briefly that \
  you are checking, and wait. Never say you do not know about something before delegating \
  the request and waiting for the result. Your own lack of knowledge is a reason to delegate, \
  not a final answer. Only report that information is unavailable if the delegation result \
  confirms it. When commentary arrives for a delegation, say it in your own \
  words without adding facts. Never invent results.\
  """

  @push_to_talk_instructions """
  You are the voice of the Comma assistant. The user speaks in short turns while holding
  a keyboard shortcut and listens after releasing it. Keep replies short and natural for speech.
  You cannot look things up or act on your own: for any request that needs knowledge,
  tools, accounts or actions, delegate it, tell the user briefly that you are checking, and wait.
  Never say you do not know about something before delegating the request and waiting for
  the result. Your own lack of knowledge is a reason to delegate, not a final answer.
  Only report that information is unavailable if the delegation result confirms it.
  When commentary arrives for a delegation, say it in your own words without adding facts.
  Never invent results. Screen and cursor context is supplied quietly for the user's current
  gesture; do not read its metadata aloud. Do not claim to see screen content unless the
  delegated agent has inspected it.
  """
  @push_to_talk_max_ms 600_000

  def start_link(args), do: GenServer.start_link(__MODULE__, args)

  @doc "The GPT-Live session instructions every call starts with."
  def instructions, do: @instructions

  # -- Init --------------------------------------------------------------------

  @impl GenServer
  def init(args) do
    Process.flag(:trap_exit, true)

    timers = Map.merge(@default_timers, Map.new(Application.get_env(:salix_voice, :timers, [])))
    settings = args.settings
    started_mono = now()
    mode = if args[:mode] == :push_to_talk, do: :push_to_talk, else: :conversation

    max_call_ms =
      timers.max_call_ms ||
        if(mode == :push_to_talk,
          do: @push_to_talk_max_ms,
          else: settings["max_call_seconds"] * 1000
        )

    state = %{
      call_id: args.call_id,
      carrier: args.carrier,
      mode: mode,
      highest_context_id: 0,
      ptt_context: nil,
      tenant_id: args.tenant_id,
      group_id: args.group_id,
      connect_id: args.connect_id,
      caller: args.caller,
      carrier_call_id: args.carrier_call_id || args.call_id,
      audio_format: args.audio_format,
      ptt_turn: nil,
      key_id: args[:key_id],
      key_name: args[:key_name],
      principal: args[:principal],
      display_name: args[:display_name],
      model_settings:
        Map.take(
          settings,
          if(args.carrier == :electron, do: ["gpt_live_voice"], else: @model_setting_fields)
        ),
      model_input: args[:model_input],
      sku:
        if(args.carrier == :electron,
          do: "gpt-live-1-codex",
          else: settings["gpt_live_model"] || "gpt-live-1"
        ),
      timers: timers,
      max_call_ms: max_call_ms,
      started_at_ms: args.started_at_ms,
      started_mono: started_mono,
      socket: nil,
      socket_ref: nil,
      attached_mono: nil,
      model_mod:
        if(args.carrier == :electron, do: SalixVoice.Model.Codex, else: SalixVoice.Model.impl()),
      model_pid: nil,
      model_ref: make_ref(),
      model_started_mono: nil,
      greeted: false,
      instructions:
        if(mode == :push_to_talk, do: @push_to_talk_instructions, else: @instructions),
      greeting: greeting(nil),
      profile_task: nil,
      call_started_task: nil,
      call_ended_attempted?: false,
      call_ended_task: nil,
      model_closed?: false,
      model_closed_mono: nil,
      model_transport_lost?: false,
      model_usage: %{},
      prebuffer: :queue.new(),
      prebuffer_bytes: 0,
      ledger: Transcript.new(),
      delegations: %{},
      egress_reservation: nil,
      trace: CallTrace.new(args[:router_agent_id], args.call_id, started_mono),
      closing: nil,
      phase: :live,
      end_reason: nil,
      ended_mono: nil,
      drain_waiters: [],
      timer_refs: %{},
      group_monitor: nil
    }

    state =
      trace_record(state, "call_started", %{
        "tenant_id" => state.tenant_id,
        "group_id" => state.group_id,
        "router_agent_id" => args[:router_agent_id],
        "caller" => state.caller,
        "mode" => to_string(state.mode),
        "carrier" => to_string(state.carrier),
        "transport" => to_string(state.audio_format)
      })

    :ok = :pg.join(@pg, {:call, state.call_id}, self())
    :ok = :pg.join(@pg, :calls, self())
    :ok = :pg.join(@pg, {:group_call, state.group_id}, self())
    if state.key_id, do: :ok = :pg.join(@pg, {:voice_key, state.key_id}, self())

    # A remote join reaches this node's `:pg` asynchronously, so a call of the
    # same Group admitted on another node at about the same time (or seen
    # after a partition heals) may be missing from the members read here. The
    # monitor reports such a later join, and the busy probe runs then.
    {group_monitor, members} = :pg.monitor(@pg, {:group_call, state.group_id})
    state = %{state | group_monitor: group_monitor}
    probe_busy(state, members)

    attach_ms =
      if state.carrier == :twilio, do: timers.attach_twilio_ms, else: timers.attach_websocket_ms

    state =
      state
      |> schedule(:attach, attach_ms, :attach_timeout)
      |> schedule(:max_call, max_call_ms, :max_duration)
      |> schedule_expiry(args[:key_expires_at])

    {:ok, state, {:continue, :start_profile}}
  end

  @impl GenServer
  def handle_continue(:start_profile, %{mode: :push_to_talk} = state),
    do: state |> start_model() |> noreply()

  def handle_continue(:start_profile, state) do
    profile = Application.get_env(:salix_voice, :profile_mod, Profile)
    group_id = state.group_id
    deadline_ms = System.monotonic_time(:millisecond) + state.timers.profile_ms

    task =
      Task.Supervisor.async_nolink(SalixVoice.TaskSupervisor, fn ->
        profile.resolve(group_id, deadline_ms)
      end)

    state
    |> Map.put(:profile_task, {task, now()})
    |> schedule(:profile, state.timers.profile_ms, :profile_deadline)
    |> noreply()
  catch
    # The task supervisor is gone: the node is shutting down.
    :exit, _reason -> state |> start_model() |> noreply()
  end

  def handle_continue({:end, reason}, state), do: state |> end_call(reason) |> noreply()

  defp start_model(%{phase: :live, model_pid: nil} = state) do
    opts = %{
      owner: self(),
      ref: state.model_ref,
      audio_format: state.audio_format,
      instructions: state.instructions,
      settings: state.model_settings,
      input: state.model_input
    }

    state = %{state | model_settings: nil, model_input: nil}

    result = with :ok <- SalixVoice.authorize(state), do: safe_start_model(state.model_mod, opts)

    case result do
      {:ok, pid} ->
        schedule(
          %{state | model_pid: pid},
          :model_start,
          if(state.carrier == :electron, do: 60_000, else: state.timers.model_start_ms),
          :model_start_timeout
        )

      {:error, %{"error_class" => "billing_unavailable"}} ->
        end_call(state, :billing_unavailable)

      {:error, reason} ->
        Logger.warning("voice model start failed call=#{state.call_id} reason=#{inspect(reason)}")
        end_call(state, :model_error)
    end
  end

  defp start_model(state), do: state

  # The profile decides the instructions and greeting once; the model starts
  # after it, with or without a profile.
  defp profile_done(%{profile_task: {_task, started}} = state, result) do
    {outcome, state} = apply_profile(state, result)
    SalixVoice.Telemetry.profile_stop(now() - started, outcome)
    %{state | profile_task: nil} |> cancel(:profile) |> start_model()
  end

  defp apply_profile(state, {:ok, %{lines: lines, language: language}}) when is_list(lines) do
    state = %{state | greeting: greeting(language)}

    case Profile.block(lines) do
      nil -> {"empty", state}
      block -> {"ok", %{state | instructions: @instructions <> "\n\n" <> block}}
    end
  end

  defp apply_profile(state, {:error, code}), do: {code, state}
  defp apply_profile(state, _result), do: {"error", state}

  defp stop_profile(%{profile_task: {task, _started}} = state) do
    Task.shutdown(task, :brutal_kill)
    %{state | profile_task: nil}
  end

  defp stop_profile(state), do: state

  defp greeting(language) do
    "Greet the caller now in #{Profile.language_name(language)}. Introduce yourself as Comma " <>
      "and ask how you can help. Then pause and listen."
  end

  defp safe_start_model(mod, opts) do
    mod.start_link(opts)
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  # -- Calls -------------------------------------------------------------------

  @impl GenServer
  def handle_call({:attach, socket, opts}, _from, state) do
    expected = opts[:carrier_call_id]

    cond do
      state.phase != :live ->
        {:reply, {:error, :call_ended}, state}

      state.socket != nil ->
        {:reply, {:error, :already_attached}, state}

      state.carrier == :twilio and opts[:via] != :token ->
        {:reply, {:error, :token_required}, state}

      # A Twilio stream must name the admitted CallSid; a missing one fails
      # closed like a wrong one.
      (state.carrier == :twilio or expected != nil) and expected != state.carrier_call_id ->
        {:reply, {:error, :carrier_call_mismatch}, state}

      true ->
        state =
          %{state | socket: socket, socket_ref: Process.monitor(socket), attached_mono: now()}
          |> cancel(:attach)
          |> trace_record("attached", %{})
          |> maybe_greet()

        {:reply, {:ok, self(), call_info(state)}, state}
    end
  end

  def handle_call(:info, _from, state), do: {:reply, {:ok, call_info(state)}, state}

  def handle_call({:context, payload}, _from, %{phase: :live, mode: :push_to_talk} = state) do
    case apply_ptt_context(state, payload) do
      {:ok, reply, next_state} ->
        {:reply, {:ok, reply}, next_state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:context, _payload}, _from, %{phase: :live} = state),
    do: {:reply, {:error, :invalid_input}, state}

  def handle_call({:context, _payload}, _from, state),
    do: {:reply, {:error, :call_not_found}, state}

  def handle_call({:voice_provider, op, request}, _from, state) when is_map(request) do
    cond do
      request["group_id"] != state.group_id or request["connect_id"] != state.connect_id ->
        {:reply, {:error, :forbidden}, state}

      state.phase != :live or state.model_pid == nil ->
        {:reply, {:error, :voice_call_ended}, state}

      true ->
        case provider_op(op, request, state) do
          {:ok, reply, state} -> {:reply, {:ok, reply}, state}
          {:ok, reply, state, continue} -> {:reply, {:ok, reply}, state, continue}
          {:error, reason} -> {:reply, {:error, reason}, state}
        end
    end
  end

  def handle_call({:voice_provider, _op, _request}, _from, state),
    do: {:reply, {:error, {:bad_request, "request must be a map"}}, state}

  defp provider_op(:say, request, state) do
    with {:ok, text} <- required_text(request["text"]),
         {:ok, delegation_id} <- resolve_delegation(state, request["delegation_id"]) do
      state = router_reply(state, :say, request, text, delegation_id)
      chunks = Speech.chunks(text)
      kind = if state.carrier == :electron and delegation_id, do: :final, else: :commentary
      Enum.each(chunks, &append(state, kind, delegation_id, &1))
      state = answer_delegation(state, delegation_id)

      {:ok, %{"delivered" => true, "chunks" => length(chunks), "delegation_id" => delegation_id},
       state}
    end
  end

  defp provider_op(:note, request, state) do
    with {:ok, text} <- required_text(request["text"]),
         {:ok, delegation_id} <- resolve_delegation(state, request["delegation_id"]) do
      state = router_reply(state, :note, request, text, delegation_id)
      chunks = Speech.chunks(text)
      Enum.each(chunks, &append(state, :thinking, delegation_id, &1))
      {:ok, %{"delivered" => true, "chunks" => length(chunks)}, state}
    end
  end

  defp provider_op(:hang_up, request, state) do
    with {:ok, text} <- optional_text(request["text"]),
         {:ok, delegation_id} <- resolve_delegation(state, request["delegation_id"]) do
      state = router_reply(state, :hang_up, request, text, delegation_id)

      case text do
        nil ->
          {:ok, %{"ending" => true}, state, {:continue, {:end, :agent_hangup}}}

        text ->
          chunks = Speech.chunks(text)
          Enum.each(chunks, &append(state, :commentary, delegation_id, &1))

          state =
            state
            |> answer_delegation(delegation_id)
            |> start_closing(:agent_hangup, state.timers.hangup_max_ms)

          {:ok, %{"ending" => true, "chunks" => length(chunks)}, state}
      end
    end
  end

  defp provider_op(_op, _request, _state), do: {:error, {:bad_request, "unknown voice operation"}}

  defp required_text(text) when is_binary(text) do
    case String.trim(text) do
      "" -> {:error, {:bad_request, "text is required"}}
      text when byte_size(text) > @max_say_chars -> {:error, {:bad_request, "text is too long"}}
      text -> {:ok, text}
    end
  end

  defp required_text(_text), do: {:error, {:bad_request, "text is required"}}

  defp optional_text(nil), do: {:ok, nil}

  defp optional_text(text) when is_binary(text) do
    if String.trim(text) == "", do: {:ok, nil}, else: required_text(text)
  end

  defp optional_text(_text), do: {:error, {:bad_request, "text must be a string"}}

  # An explicit delegation must belong to this call. Without one, the oldest
  # unanswered delegation is used, else none (general session context).
  defp resolve_delegation(state, id) when is_binary(id) and id != "" do
    if Map.has_key?(state.delegations, id),
      do: {:ok, id},
      else: {:error, {:bad_request, "unknown delegation_id"}}
  end

  defp resolve_delegation(state, _id), do: {:ok, oldest_pending(state)}

  defp oldest_pending(state) do
    state.delegations
    |> Enum.filter(fn {_id, delegation} -> delegation.status == :pending end)
    |> Enum.min_by(fn {_id, delegation} -> delegation.created_mono end, fn -> nil end)
    |> case do
      {id, _delegation} -> id
      nil -> nil
    end
  end

  # -- Carrier and model messages ---------------------------------------------

  @impl GenServer
  def handle_info({:voice_carrier, :audio, audio}, state) when is_binary(audio) do
    cond do
      state.phase != :live -> {:noreply, state}
      state.model_started_mono -> model_send_audio(state, audio) |> noreply()
      true -> {:noreply, prebuffer(state, audio)}
    end
  end

  def handle_info({:voice_carrier, :hangup, _reason}, state),
    do: state |> end_call(:caller_hangup) |> noreply()

  def handle_info({:voice_carrier, _kind, _value}, state), do: {:noreply, state}

  def handle_info({:voice_model, ref, event}, %{model_ref: ref} = state),
    do: state |> model_event(event) |> noreply()

  def handle_info({:voice_model, _ref, _event}, state), do: {:noreply, state}

  def handle_info({:flush_delegation, id}, state), do: state |> flush_delegation(id) |> noreply()

  def handle_info({:delegation_enqueued, id, result}, state),
    do: state |> delegation_enqueued(id, result) |> noreply()

  def handle_info({:call_started_enqueued, {:ok, _}}, state), do: {:noreply, state}

  # The call goes on without it: the voice model already greeted the caller,
  # and each request still reaches the Router as a delegation.
  def handle_info({:call_started_enqueued, _result}, state) do
    Logger.warning("voice call start ingress failed call=#{state.call_id} reason=error")

    {:noreply, state}
  end

  def handle_info({:progress, id, stage}, state), do: state |> progress(id, stage) |> noreply()

  def handle_info({:voice_busy_probe, pid, their_key}, state) do
    cond do
      state.phase != :live ->
        {:noreply, state}

      busy_key(state) > their_key ->
        state |> end_call(:busy) |> noreply()

      true ->
        send(pid, {:voice_busy_probe_reply, self(), busy_key(state)})
        {:noreply, state}
    end
  end

  def handle_info({ref, :join, _group, pids}, %{group_monitor: ref} = state) do
    if state.phase == :live, do: probe_busy(state, pids)
    {:noreply, state}
  end

  def handle_info({ref, :leave, _group, _pids}, %{group_monitor: ref} = state),
    do: {:noreply, state}

  def handle_info({:voice_busy_probe_reply, _pid, their_key}, state) do
    if state.phase == :live and busy_key(state) > their_key,
      do: state |> end_call(:busy) |> noreply(),
      else: {:noreply, state}
  end

  def handle_info({:voice_key_revoked, key_id}, %{key_id: key_id} = state)
      when is_binary(key_id),
      do: state |> notice_then_end(:revoked, revoked_notice()) |> noreply()

  def handle_info({:voice_key_revoked, _key_id}, state), do: {:noreply, state}

  # A changed key expiry replaces the admission timer; nil clears it, and a
  # past instant ends the call as revoked at once.
  def handle_info(
        {:voice_key_expiry, key_id, expires_at},
        %{key_id: key_id, phase: :live} = state
      )
      when is_binary(key_id),
      do: state |> cancel(:key_expiry) |> schedule_expiry(expires_at) |> noreply()

  def handle_info({:voice_key_expiry, _key_id, _expires_at}, state), do: {:noreply, state}

  def handle_info({:voice_group_revoked, group_id}, %{group_id: group_id} = state),
    do: state |> notice_then_end(:revoked, revoked_notice()) |> noreply()

  def handle_info({:voice_group_revoked, _group_id}, state), do: {:noreply, state}

  # A caller number removed from the Group's voice connect ends that number's
  # phone call; a Signal binding removed from the Group's Signal connect ends
  # that peer's Signal call.
  def handle_info(
        {:voice_caller_revoked, group_id, value},
        %{group_id: group_id, caller: %{"kind" => kind, "value" => value}} = state
      )
      when kind in ["e164", "signal"],
      do: state |> notice_then_end(:revoked, revoked_notice()) |> noreply()

  def handle_info({:voice_caller_revoked, _group_id, _e164}, state), do: {:noreply, state}

  # The carrier side gave up before any socket attached (the stream closed
  # before `start`, or the carrier reports the call finished). An attached
  # call ignores this: its socket owns the end.
  def handle_info({:voice_abandon, carrier_call_id, reason}, %{socket: nil} = state)
      when is_nil(carrier_call_id) or carrier_call_id == state.carrier_call_id,
      do: state |> end_call(reason) |> noreply()

  def handle_info({:voice_abandon, _carrier_call_id, _reason}, state), do: {:noreply, state}

  def handle_info({:call_ended_enqueued, _result}, %{phase: :ending} = state),
    do: %{state | call_ended_task: nil} |> maybe_finish_ending() |> noreply()

  def handle_info({:call_ended_enqueued, _result}, state), do: {:noreply, state}

  def handle_info({:voice_drain, from, ref}, state) do
    state = %{state | drain_waiters: [{from, ref} | state.drain_waiters]}
    state |> notice_then_end(:draining, draining_notice()) |> noreply()
  end

  def handle_info({:voice_drain_now, deadline}, state),
    do: state |> force_end(:draining, deadline) |> noreply()

  def handle_info({:timer, name, event}, state) do
    state = %{state | timer_refs: Map.delete(state.timer_refs, name)}
    state |> timer(event) |> noreply()
  end

  def handle_info(:voice_trace_flush, state) do
    %{state | trace: CallTrace.on_timer(state.trace)} |> maybe_finish_ending() |> noreply()
  end

  def handle_info({ref, result}, %{trace: %{task: {%Task{ref: ref}, _, _}}} = state) do
    %{state | trace: CallTrace.result(state.trace, ref, result)}
    |> maybe_finish_ending()
    |> noreply()
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, _reason},
        %{trace: %{task: {%Task{ref: ref}, _, _}}} = state
      ) do
    %{state | trace: CallTrace.down(state.trace, ref)}
    |> maybe_finish_ending()
    |> noreply()
  end

  def handle_info({ref, result}, %{profile_task: {%Task{ref: ref}, _started}} = state) do
    Process.demonitor(ref, [:flush])
    state |> profile_done(result) |> noreply()
  end

  def handle_info(
        {:DOWN, ref, :process, _pid, _reason},
        %{profile_task: {%Task{ref: ref}, _}} = state
      ),
      do: state |> profile_done({:error, "error"}) |> noreply()

  def handle_info({:DOWN, ref, :process, _pid, reason}, %{socket_ref: ref} = state) do
    reason = if clean_exit?(reason), do: :caller_hangup, else: :carrier_error
    state = %{state | socket: nil, socket_ref: nil}
    state |> end_call(reason) |> noreply()
  end

  def handle_info({:EXIT, pid, _reason}, %{model_pid: pid} = state) do
    state = %{state | model_closed?: true, model_pid: nil} |> mark_model_closed()

    cond do
      state.phase == :ending ->
        state |> maybe_finish_ending() |> noreply()

      true ->
        Logger.warning("voice model exited call=#{state.call_id} reason=error")

        state
        |> trace_record("error", %{"class" => "model", "code" => "exited"})
        |> end_call(:model_error)
        |> noreply()
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  # A timeout message sent just before the attach cancelled its timer is stale.
  defp timer(%{socket: socket} = state, :attach_timeout) when is_pid(socket), do: state
  defp timer(state, :attach_timeout), do: end_call(state, :attach_timeout)
  defp timer(state, :max_duration), do: notice_then_end(state, :max_duration, max_notice())
  defp timer(state, :key_expired), do: notice_then_end(state, :revoked, revoked_notice())

  defp timer(state, :model_start_timeout) do
    if state.model_started_mono, do: state, else: end_call(state, :model_error)
  end

  defp timer(state, :closing_done) do
    case state.closing do
      %{reason: reason} -> end_call(state, reason)
      nil -> state
    end
  end

  defp timer(state, :model_close_wait) do
    if is_pid(state.model_pid) and not state.model_closed?,
      do: Process.exit(state.model_pid, :kill)

    %{state | model_closed?: true} |> maybe_finish_ending()
  end

  defp timer(state, :ending_deadline),
    do: force_end(state, state.end_reason, System.monotonic_time(:millisecond))

  defp timer(%{profile_task: {task, _started}} = state, :profile_deadline) do
    Task.shutdown(task, :brutal_kill)
    profile_done(state, {:error, "timeout"})
  end

  defp timer(state, {:context_timeout, id}) do
    case state.ptt_context do
      %{id: ^id, status: status, native_start_ms: boundary} = context
      when status == :pending or (status == :complete and is_nil(boundary)) ->
        updated_context = %{context | status: :failed, attachments: []}
        state = %{state | ptt_context: updated_context}
        state = context_trace(state, id, :failed, nil, [], "timeout")

        state =
          fail_waiting_delegations(
            state,
            id,
            "The screen context is unavailable for this request. Tell the user briefly and ask them to try again."
          )

        to_socket(state, {:voice_call, :context_failed, id})
        state

      _ ->
        state
    end
  end

  defp timer(state, _event), do: state

  # Wait for both ends of the audio path. Either may become ready first.
  # The carrier must keep sending input audio, including silence:
  # https://developers.openai.com/api/docs/guides/live-conversations#greet-before-the-caller-speaks
  defp maybe_greet(%{mode: :push_to_talk, phase: :live, closing: nil, greeted: false} = state)
       when is_integer(state.model_started_mono) and is_pid(state.socket) do
    %{state | greeted: true}
  end

  defp maybe_greet(%{phase: :live, closing: nil, greeted: false} = state)
       when is_integer(state.model_started_mono) and is_pid(state.socket) do
    append(state, :instructions, nil, state.greeting)
    %{state | greeted: true, call_started_task: enqueue_call_started(state)}
  end

  defp maybe_greet(state), do: state

  defp model_event(state, {:started, _session_id}) do
    to_socket(state, {:voice_call, :started})

    state =
      if state.model_started_mono, do: state, else: trace_record(state, "model_started", %{})

    state = %{state | model_started_mono: state.model_started_mono || now()}
    state = state |> cancel(:model_start) |> maybe_greet()

    Enum.each(:queue.to_list(state.prebuffer), &state.model_mod.send_audio(state.model_pid, &1))
    %{state | prebuffer: :queue.new(), prebuffer_bytes: 0}
  end

  defp model_event(state, {:signaled, sdp}) do
    to_socket(state, {:voice_call, :signaled, sdp})
    state
  end

  defp model_event(state, {:fatal_error, code}) do
    to_socket(state, {:voice_call, :error, code})

    state
    |> trace_record("error", %{"class" => "model", "code" => safe_error_code(code)})
    |> end_call(:model_error)
  end

  defp model_event(state, {:caption, role, turn, text, final?}) do
    to_socket(state, {:voice_call, :caption, role, turn, text, final?})

    ledger =
      cond do
        not final? -> state.ledger
        role == :caller -> Transcript.add_caller(state.ledger, text, nil)
        true -> Transcript.add_agent(state.ledger, text)
      end

    state = %{state | ledger: ledger}

    cond do
      not final? and role == :agent -> reserve_egress(state, turn)
      not final? -> state
      role == :caller -> caller_turn(state, text, turn, nil)
      true -> agent_turn(state, text, turn)
    end
  end

  # A read-aloud call has nothing to delegate to.

  defp model_event(
         %{mode: :push_to_talk, ptt_context: %{id: id, status: status} = context} = state,
         {:context_started, id, boundary}
       )
       when status in [:pending, :complete] do
    if is_integer(boundary) and boundary >= 0 do
      state = %{state | ptt_context: %{context | native_start_ms: boundary}}
      state = if status == :complete, do: cancel(state, :context_timeout), else: state
      flush_waiting_delegations(state, id)
    else
      {:ok, _, state} = transition_ptt_context(state, %{context_id: id, status: :failed})
      state
    end
  end

  defp model_event(
         %{mode: :push_to_talk, ptt_turn: %{id: id}} = state,
         {:user_turn_started, id, _}
       ),
       do: state

  defp model_event(%{mode: :push_to_talk} = state, {:user_turn_started, id, start_ms}) do
    context_id =
      case state.ptt_context do
        %{id: context_id, status: status} when status in [:pending, :complete] -> context_id
        _ -> nil
      end

    %{state | ptt_turn: %{id: id, context_id: context_id, start_ms: start_ms}}
  end

  defp model_event(state, {:delegation, id, offset_ms, request, native_turn_id}) do
    state = model_event(state, {:delegation, id, offset_ms})

    if Map.has_key?(state.delegations, id) do
      state =
        update_in(state.delegations[id], fn delegation ->
          %{delegation | native_turn_id: delegation.native_turn_id || native_turn_id}
        end)

      cond do
        is_nil(request) and state.mode == :push_to_talk ->
          fail_delegation(
            state,
            id,
            "The handoff contains no readable request. Ask the user to try again."
          )

        state.mode == :push_to_talk ->
          handle_ptt_delegation_request(state, id, request, native_turn_id)

        true ->
          update_in(state.delegations[id], &%{&1 | request: request})
      end
    else
      state
    end
  end

  defp model_event(state, {:audio, audio}) do
    to_socket(state, {:voice_call, :audio, audio})

    case state.closing do
      %{} -> schedule(state, :closing_quiet, state.timers.quiet_ms, :closing_done)
      nil -> state
    end
  end

  defp model_event(state, {:input_transcript, text, final?, offset_ms}) when is_binary(text) do
    to_socket(state, {:voice_call, :transcript, :caller, text, final?})

    if final? do
      state
      |> Map.put(:ledger, Transcript.add_caller(state.ledger, text, offset_ms))
      |> caller_turn(text, get_in(state, [:ptt_turn, :id]), offset_ms)
    else
      state
    end
  end

  defp model_event(state, {:output_transcript, text, final?}) when is_binary(text) do
    to_socket(state, {:voice_call, :transcript, :agent, text, final?})

    if final? do
      state
      |> Map.put(:ledger, Transcript.add_agent(state.ledger, text))
      |> agent_turn(text, nil)
    else
      state
    end
  end

  defp model_event(state, {:delegation, id, offset_ms}) when is_binary(id) do
    if state.phase != :live or Map.has_key?(state.delegations, id) do
      state
    else
      delegation = %{
        id: id,
        offset_ms: offset_ms,
        created_mono: now(),
        request: nil,
        context_id: nil,
        native_turn_id: nil,
        native_start_ms: nil,
        status: :pending,
        enqueued: false,
        accepted: false,
        task_pid: nil,
        waiting_for_context: false,
        timers: [
          Process.send_after(
            self(),
            {:progress, id, :thinking},
            state.timers.progress_thinking_ms
          ),
          Process.send_after(self(), {:progress, id, :apology}, state.timers.progress_apology_ms)
        ]
      }

      Process.send_after(self(), {:flush_delegation, id}, state.timers.delegation_settle_ms)
      electron_delegation(state, id, "pending")
      %{state | delegations: Map.put(state.delegations, id, delegation)}
    end
  end

  defp model_event(state, :speech_started) do
    to_socket(state, {:voice_call, :clear})
    state
  end

  defp model_event(state, {:closed, reason, usage}) do
    state =
      %{
        state
        | model_closed?: true,
          model_usage: if(is_map(usage), do: usage, else: %{}),
          model_transport_lost?: reason == "connection_lost"
      }
      |> mark_model_closed()

    if state.phase == :ending,
      do: maybe_finish_ending(state),
      else: end_call(state, model_close_reason(reason))
  end

  defp model_event(state, {:error, error}) do
    state = trace_record(state, "error", %{"class" => "model", "code" => safe_error_code(error)})

    if state.model_started_mono do
      Logger.warning("voice model command error call=#{state.call_id} reason=error")
      state
    else
      end_call(state, :model_error)
    end
  end

  defp model_event(state, _event), do: state

  defp mark_model_closed(%{model_closed_mono: nil} = state),
    do: %{state | model_closed_mono: now()}

  defp mark_model_closed(state), do: state

  defp model_close_reason("expired"), do: :max_duration
  defp model_close_reason("remote_hangup"), do: :caller_hangup
  defp model_close_reason(reason) when reason in ["content", "connection_lost"], do: :model_error
  defp model_close_reason(_reason), do: :completed

  defp model_send_audio(state, audio) do
    state.model_mod.send_audio(state.model_pid, audio)
    state
  end

  defp prebuffer(state, audio) do
    limit = div(SalixVoice.Carrier.bytes_per_second(state.audio_format) * @prebuffer_ms, 1000)
    queue = :queue.in(audio, state.prebuffer)

    trim_prebuffer(
      %{state | prebuffer: queue, prebuffer_bytes: state.prebuffer_bytes + byte_size(audio)},
      limit
    )
  end

  defp trim_prebuffer(%{prebuffer_bytes: bytes} = state, limit) when bytes <= limit, do: state

  defp trim_prebuffer(state, limit) do
    {{:value, oldest}, rest} = :queue.out(state.prebuffer)

    trim_prebuffer(
      %{state | prebuffer: rest, prebuffer_bytes: state.prebuffer_bytes - byte_size(oldest)},
      limit
    )
  end

  # -- Delegation bridge -------------------------------------------------------

  defp flush_delegation(state, id) do
    case state.delegations do
      %{^id => %{status: :pending, enqueued: false} = delegation} when state.phase == :live ->
        cond do
          state.mode == :push_to_talk and delegation[:context_id] == nil ->
            fail_unbound_ptt_delegation(state, id)

          state.mode == :push_to_talk and delegation.waiting_for_context ->
            state

          state.mode == :push_to_talk and
              System.convert_time_unit(now() - delegation.created_mono, :native, :millisecond) <
                state.timers.delegation_settle_ms ->
            state

          state.mode == :push_to_talk and
              not matching_complete_ptt_context?(state.ptt_context, delegation.context_id) ->
            fail_invalid_ptt_delegation(
              state,
              id,
              delegation.context_id,
              "The screen context for this request has expired. Ask the caller to press and hold to try again."
            )

          true ->
            {caller_text, ledger} = Transcript.take_caller(state.ledger, delegation.offset_ms)
            last_agent = Transcript.last_agent_sentence(ledger)
            state = %{state | ledger: ledger}

            request =
              if delegation[:request] in [nil, ""], do: caller_text, else: delegation.request

            {attachments, context_text, state} =
              if state.mode == :push_to_talk do
                %{attachments: atts, text: ctext} = state.ptt_context
                updated_context = %{state.ptt_context | attachments: []}
                {atts, ctext, %{state | ptt_context: updated_context}}
              else
                {[], nil, state}
              end

            delegation = %{delegation | enqueued: true, waiting_for_context: false}
            state = %{state | delegations: Map.put(state.delegations, id, delegation)}
            enqueue_delegation(state, id, request, last_agent, attachments, context_text)
        end

      _ ->
        state
    end
  end

  defp matching_complete_ptt_context?(%{id: cid, status: :complete}, context_id)
       when cid == context_id,
       do: true

  defp matching_complete_ptt_context?(_context, _context_id), do: false

  defp enqueue_delegation(state, id, caller_text, last_agent, attachments, context_text) do
    parent = self()
    router_attachments = Enum.map(attachments, &router_attachment/1)
    content = delegation_content(state, id, caller_text, last_agent, context_text)
    delegation = Map.fetch!(state.delegations, id)

    fields = %{
      "delegation_id" => id,
      "request" => caller_text,
      "content" => content,
      "context_id" => delegation.context_id,
      "context_text" => context_text,
      "native_turn_id" => delegation.native_turn_id,
      "attachments" => attachment_metadata(attachments)
    }

    state =
      state |> archive_voice(:tool_call, fields) |> trace_record("delegation_requested", fields)

    task_pid =
      enqueue_router_input(
        state,
        content,
        delegation_metadata(state, id),
        source_message_id(state, id),
        [trusted_source_text: caller_text, attachments: router_attachments],
        &send(parent, {:delegation_enqueued, id, &1})
      )

    case task_pid do
      pid when is_pid(pid) ->
        state =
          trace_record(state, "delegation_sent", %{
            "delegation_id" => id,
            "source_message_id" => source_message_id(state, id),
            "attachment_count" => length(attachments),
            "text_bytes" => byte_size(content)
          })

        case state.delegations do
          %{^id => delegation} ->
            updated = %{delegation | task_pid: pid}
            %{state | delegations: Map.put(state.delegations, id, updated)}

          _ ->
            state
        end

      nil ->
        delegation_enqueued(state, id, {:error, :task_start_failed})
    end
  end

  defp router_attachment(attachment) do
    path = attachment["path"] || attachment[:path]
    name = attachment["name"] || attachment[:name]
    mime = attachment["mime"] || attachment[:mime]

    %{
      "path" => path,
      "file_name" => name,
      "mime" => mime,
      "to_blob" => fn agent_id ->
        with {:ok, ref} <- SalixIM.Ports.AgentWorkspace.file_ref(agent_id, path) do
          {:ok,
           %{
             ref: ref,
             path: path,
             file_name: name,
             mime_type: mime,
             size: ref[:size] || ref["size"]
           }}
        end
      end
    }
  end

  # The call-start input has no message_id, so a `voice.say` that answers it
  # names no delegation and speaks as session context.
  defp enqueue_call_started(state) do
    parent = self()

    enqueue_router_input(
      state,
      call_started_content(state),
      call_metadata(state)
      |> Map.merge(%{"event_type" => "voice.call_started", "event_id" => state.call_id}),
      source_message_id(state, "start"),
      [],
      &send(parent, {:call_started_enqueued, &1})
    )
  end

  # Manual calls record their end; PTT hands off only accepted pending work.
  # The task logs its own failure if the actor stops before it finishes.
  defp enqueue_call_ended(%{mode: :push_to_talk, greeted: true} = state) do
    accepted_pending_ids =
      for {id, %{status: :pending, accepted: true}} <- state.delegations, do: id

    if accepted_pending_ids == [] do
      nil
    else
      call_id = state.call_id
      owner = self()

      metadata =
        call_metadata(state)
        |> Map.merge(%{
          "event_type" => "voice.delegation_handoff",
          "event_id" => call_id,
          "voice_pending_delegation_ids" => accepted_pending_ids
        })

      enqueue_router_input(
        state,
        delegation_handoff_content(accepted_pending_ids),
        metadata,
        source_message_id(state, "end"),
        [],
        fn result ->
          case result do
            {:ok, _} ->
              :ok

            _ ->
              Logger.warning(
                "voice delegation handoff ingress failed call=#{call_id} reason=error"
              )
          end

          send(owner, {:call_ended_enqueued, result})
        end
      )
    end
  end

  defp enqueue_call_ended(%{greeted: true} = state) do
    call_id = state.call_id
    owner = self()
    started_task = state.call_started_task

    metadata =
      call_metadata(state)
      |> Map.merge(%{"event_type" => "voice.call_ended", "event_id" => call_id})

    pending_count = Enum.count(state.delegations, fn {_id, d} -> d.status == :pending end)

    enqueue_router_input(
      state,
      call_ended_content(state, pending_count),
      metadata,
      source_message_id(state, "end"),
      [before: fn -> await_task(started_task, @call_started_wait_ms) end],
      fn result ->
        case result do
          {:ok, _} ->
            :ok

          _ ->
            Logger.warning("voice call end ingress failed call=#{call_id} reason=error")
        end

        send(owner, {:call_ended_enqueued, result})
      end
    )
  end

  defp enqueue_call_ended(_state), do: nil

  # Returns the task pid, or nil when the task could not start.
  defp enqueue_router_input(state, content, metadata, source_message_id, opts, on_result) do
    ingress = Application.get_env(:salix_voice, :ingress_mod, SalixIM.ProviderConnects)
    {before, opts} = Keyword.pop(opts, :before, fn -> :ok end)

    Task.Supervisor.start_child(SalixVoice.TaskSupervisor, fn ->
      before.()

      result =
        try do
          ingress.enqueue_group_router_im_provider_message(
            state.group_id,
            content,
            metadata,
            source_message_id,
            Keyword.put(opts, :session_name, "Voice call")
          )
        catch
          kind, reason -> {:error, {kind, reason}}
        end

      on_result.(result)
    end)
    |> case do
      {:ok, pid} -> pid
      _other -> nil
    end
  catch
    # The task supervisor is gone: the node is shutting down.
    :exit, _reason -> nil
  end

  defp await_task(pid, timeout_ms) when is_pid(pid) do
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    after
      timeout_ms ->
        Process.demonitor(ref, [:flush])
        :timeout
    end
  end

  defp await_task(_pid, _timeout_ms), do: :ok

  @doc false
  def source_message_id(state, delegation_id),
    do: "im_provider:voice:#{state.connect_id}:#{state.call_id}:#{delegation_id}"

  defp delegation_metadata(state, id) do
    state
    |> call_metadata()
    |> Map.merge(%{
      "message_id" => id,
      "event_type" => "voice.delegation",
      "event_id" => id,
      "voice_mode" => to_string(state.mode),
      "voice_call_id" => state.call_id,
      "voice_delegation_id" => id,
      "voice_caller_user_id" => state.caller["value"]
    })
  end

  defp call_metadata(state) do
    %{
      "provider" => "voice",
      "connect_id" => state.connect_id,
      "chat_id" => state.call_id,
      "chat_type" => "private",
      "from_user_id" => state.caller["value"],
      "from_username" => state.display_name || state.caller["value"],
      "source_sent_at_ms" => System.system_time(:millisecond),
      "source_actor_type" => "provider_user",
      "voice_mode" => to_string(state.mode),
      "voice_call_id" => state.call_id,
      "voice_caller_user_id" => state.caller["value"]
    }
    |> Map.merge(caller_authority(state))
  end

  # A WebSocket caller acts with its voice key creator's authority, like the
  # `api` provider; a phone caller is a provider user.
  defp caller_authority(%{caller: %{"kind" => "api_key"}, key_id: key_id} = state)
       when is_binary(key_id) do
    %{
      "from_user_id" => "api_key:" <> key_id,
      "api_key_id" => key_id,
      "api_key_name" => state.key_name,
      "api_key_principal" => state.principal,
      "source_actor_type" => "provider_system"
    }
  end

  defp caller_authority(%{caller: %{"kind" => "comma_user", "value" => user}}),
    do: %{"source_actor_type" => "user", "from_user_id" => user}

  defp caller_authority(_state), do: %{}

  defp delegation_content(state, id, caller_text, last_agent, context_text) do
    caller_line =
      case caller_text do
        "" -> "The caller's words were not transcribed yet."
        text -> "The caller said: \"#{text}\""
      end

    agent_line =
      case last_agent do
        nil -> []
        text -> ["The voice assistant last said: \"#{text}\""]
      end

    context_line =
      case context_text do
        text when is_binary(text) and text != "" ->
          ["Captured screen context: #{text}"]

        _ ->
          []
      end

    Enum.join(
      [
        "Live voice call (#{carrier_label(state.carrier)}). The caller is on the line now, " <>
          "and the voice assistant handed this request to you."
      ] ++
        [caller_line] ++
        agent_line ++
        context_line ++
        [
          "Answer with im_api.voice.say (call_id #{state.call_id}, delegation_id #{id}) in " <>
            "short spoken sentences. Use im_api.voice.note for quiet progress and " <>
            "im_api.voice.hang_up to end the call."
        ],
      "\n"
    )
  end

  defp call_started_content(state) do
    opening =
      "Live voice call (#{carrier_label(state.carrier)}). The caller just connected, and the " <>
        "voice assistant is greeting them. They have not asked anything yet."

    Enum.join(
      [
        opening,
        "If you have something the caller should hear now, such as a result or reminder they " <>
          "are waiting for, say it with im_api.voice.say (call_id #{state.call_id}) in short " <>
          "spoken sentences. Otherwise send nothing: the voice assistant hands you each " <>
          "request the caller makes."
      ],
      "\n"
    )
  end

  defp delegation_handoff_content(pending_ids) do
    "Shortcut speech turn ended with accepted requests still pending: " <>
      Jason.encode!(pending_ids) <>
      ". Finish accepted work in the Comma conversation; no new call is needed."
  end

  defp call_ended_content(state, pending) do
    seconds = ceil_seconds(state.ended_mono - state.started_mono)

    pending_line =
      case pending do
        0 -> []
        1 -> ["One caller request was still unanswered."]
        n -> ["#{n} caller requests were still unanswered."]
      end

    guidance =
      "The caller can no longer hear you. Do not use im_api.voice operations for this call. " <>
        "If something from the call still needs action or an answer, continue it in the " <>
        "Comma conversation. Otherwise send nothing."

    Enum.join(
      [
        "The live voice call (#{carrier_label(state.carrier)}, call_id #{state.call_id}) has " <>
          "ended after #{seconds} s: #{end_reason_label(state.end_reason)} " <>
          "(reason #{state.end_reason})."
      ] ++
        pending_line ++
        [guidance],
      "\n"
    )
  end

  defp end_reason_label(:caller_hangup), do: "the caller hung up"
  defp end_reason_label(:agent_hangup), do: "you ended the call"
  defp end_reason_label(:max_duration), do: "the call reached its time limit"
  defp end_reason_label(:revoked), do: "the caller's access was revoked"
  defp end_reason_label(:draining), do: "the voice service restarted"
  defp end_reason_label(:busy), do: "another call of this Group was active"
  defp end_reason_label(:model_error), do: "the voice model failed"
  defp end_reason_label(:carrier_error), do: "the call connection failed"
  defp end_reason_label(:completed), do: "the voice session completed"
  defp end_reason_label(_reason), do: "the call stopped"

  defp carrier_label(:twilio), do: "phone"
  defp carrier_label(:websocket), do: "voice app"
  defp carrier_label(other), do: to_string(other)

  defp delegation_enqueued(state, id, {:ok, _}) do
    state =
      trace_record(state, "delegation_acked", %{
        "delegation_id" => id,
        "source_message_id" => source_message_id(state, id),
        "status" => "queued"
      })

    state =
      case state.delegations do
        %{^id => delegation} ->
          updated = %{delegation | accepted: true, task_pid: nil}
          %{state | delegations: Map.put(state.delegations, id, updated)}

        _ ->
          state
      end

    if state.phase == :ending, do: maybe_finish_ending(state), else: state
  end

  defp delegation_enqueued(state, id, _result) do
    Logger.warning("voice delegation ingress failed call=#{state.call_id} reason=error")

    state =
      trace_record(state, "delegation_acked", %{
        "delegation_id" => id,
        "source_message_id" => source_message_id(state, id),
        "status" => "error"
      })

    state =
      case state.delegations do
        %{^id => %{status: :pending} = delegation} when state.phase == :live ->
          delegation = %{delegation | accepted: false, task_pid: nil}
          state = %{state | delegations: Map.put(state.delegations, id, delegation)}

          fail_delegation(state, id, nil)

        %{^id => delegation} ->
          updated = %{delegation | accepted: false, task_pid: nil}
          %{state | delegations: Map.put(state.delegations, id, updated)}

        _ ->
          state
      end

    if state.phase == :ending, do: maybe_finish_ending(state), else: state
  end

  defp in_flight_delegations?(state) do
    Enum.any?(state.delegations, fn {_id, d} -> is_pid(d[:task_pid]) end)
  end

  defp maybe_finish_ending(%{phase: :ending} = state) do
    cond do
      in_flight_delegations?(state) ->
        wait_for_ending(state)

      not state.call_ended_attempted? ->
        state |> emit_call_ended() |> maybe_finish_ending()

      is_pid(state.call_ended_task) ->
        wait_for_ending(state)

      state.model_pid != nil and not state.model_closed? ->
        state =
          if Map.has_key?(state.timer_refs, :model_close_wait),
            do: state,
            else:
              schedule(
                state,
                :model_close_wait,
                state.timers.model_close_wait_ms,
                :model_close_wait
              )

        wait_for_ending(state)

      true ->
        finish_trace(state)
    end
  end

  defp maybe_finish_ending(state), do: state

  defp wait_for_ending(state) do
    if Map.has_key?(state.timer_refs, :ending_deadline),
      do: state,
      else: schedule(state, :ending_deadline, ending_remaining_ms(state), :ending_deadline)
  end

  defp ending_remaining_ms(state) do
    budget = state.timers[:delegation_enqueue_wait_ms] || @delegation_enqueue_wait_ms
    elapsed = System.convert_time_unit(now() - state.ended_mono, :native, :millisecond)
    max(budget - elapsed, 0)
  end

  defp emit_call_ended(%{phase: :ending, call_ended_attempted?: false} = state) do
    task = enqueue_call_ended(state)

    if call_ended_required?(state) and not is_pid(task),
      do: Logger.warning("voice call end ingress could not start call=#{state.call_id}")

    %{state | call_ended_attempted?: true, call_ended_task: task}
  end

  defp emit_call_ended(state), do: state

  defp call_ended_required?(%{mode: :push_to_talk} = state) do
    Enum.any?(state.delegations, fn {_id, d} -> d.status == :pending and d.accepted end)
  end

  defp call_ended_required?(%{greeted: true}), do: true
  defp call_ended_required?(_state), do: false

  defp handle_ptt_delegation_request(state, id, request, native_turn_id) do
    context =
      case {state.ptt_turn, state.ptt_context} do
        {%{id: ^native_turn_id, context_id: context_id, start_ms: start_ms},
         %{id: context_id, status: status, native_start_ms: boundary} = context}
        when is_binary(native_turn_id) and status in [:pending, :complete] and
               (is_nil(boundary) or start_ms >= boundary) ->
          context

        _ ->
          nil
      end

    case context do
      %{id: context_id, status: status, native_start_ms: boundary} ->
        update_in(state.delegations[id], fn delegation ->
          %{
            delegation
            | request: request,
              context_id: context_id,
              native_start_ms: state.ptt_turn.start_ms,
              waiting_for_context: status == :pending or is_nil(boundary)
          }
        end)

      nil ->
        fail_unbound_ptt_delegation(state, id)
    end
  end

  defp apply_ptt_context(state, payload) when is_map(payload) do
    with {:ok, norm} <- normalize_ptt_payload(payload) do
      transition_ptt_context(state, norm)
    end
  end

  defp apply_ptt_context(_state, _), do: {:error, :invalid_input}

  defp normalize_ptt_payload(payload) do
    id = Map.get(payload, :context_id) || Map.get(payload, "context_id")
    status = Map.get(payload, :status) || Map.get(payload, "status")

    if is_integer(id) and id in 1..9_007_199_254_740_991 do
      case status do
        s when s in [:pending, "pending"] ->
          {:ok, %{context_id: id, status: :pending}}

        s when s in [:complete, "complete"] ->
          text = Map.get(payload, :text) || Map.get(payload, "text")
          attachments = Map.get(payload, :attachments) || Map.get(payload, "attachments") || []

          if is_binary(text) and byte_size(text) in 1..20_000 and String.valid?(text) and
               String.trim(text) != "" and is_list(attachments) and
               Enum.all?(attachments, &is_map/1) do
            {:ok, %{context_id: id, status: :complete, text: text, attachments: attachments}}
          else
            {:error, :invalid_input}
          end

        s when s in [:failed, "failed"] ->
          {:ok, %{context_id: id, status: :failed}}

        s when s in [:cancelled, "cancelled"] ->
          {:ok, %{context_id: id, status: :cancelled}}

        _ ->
          {:error, :invalid_input}
      end
    else
      {:error, :invalid_input}
    end
  end

  defp transition_ptt_context(state, %{status: :pending, context_id: id}) do
    cond do
      id < state.highest_context_id ->
        {:error, :invalid_input}

      id == state.highest_context_id ->
        case state.ptt_context do
          %{id: ^id, status: :pending} ->
            {:ok, %{accepted: true}, state}

          _ ->
            {:error, :invalid_input}
        end

      true ->
        state = cancel(state, :context_timeout)

        state =
          invalidate_waiting_delegations(
            state,
            "The screen context for this request was superseded. Ask the caller to try again."
          )

        state =
          schedule(
            state,
            :context_timeout,
            state.timers.context_timeout_ms,
            {:context_timeout, id}
          )

        context = %{
          id: id,
          status: :pending,
          native_start_ms: nil,
          text: nil,
          attachments: []
        }

        append(
          state,
          {:context, id},
          nil,
          "Screen and cursor context is pending for the next shortcut speech turn."
        )

        next_state = %{state | highest_context_id: id, ptt_context: context}
        next_state = context_trace(next_state, id, :pending, nil, [])
        {:ok, %{accepted: true}, next_state}
    end
  end

  defp transition_ptt_context(state, %{
         status: :complete,
         context_id: id,
         text: text,
         attachments: attachments
       }) do
    case state.ptt_context do
      %{id: ^id, status: :pending} = context ->
        state =
          if is_integer(context.native_start_ms), do: cancel(state, :context_timeout), else: state

        append(state, :thinking, nil, text)

        updated_context = %{
          context
          | status: :complete,
            text: text,
            attachments: attachments
        }

        state = %{state | ptt_context: updated_context}
        state = context_trace(state, id, :complete, text, attachments)
        state = flush_waiting_delegations(state, id)
        {:ok, %{accepted: true}, state}

      _ ->
        {:error, :invalid_input}
    end
  end

  defp transition_ptt_context(state, %{status: status, context_id: id})
       when status in [:failed, :cancelled] do
    cond do
      id < state.highest_context_id ->
        {:error, :invalid_input}

      id == state.highest_context_id ->
        case state.ptt_context do
          %{id: ^id, status: current_status} when current_status in [:pending, :complete] ->
            state = cancel(state, :context_timeout)

            updated_context = %{
              state.ptt_context
              | status: status,
                attachments: []
            }

            state = %{state | ptt_context: updated_context}
            state = context_trace(state, id, status, nil, [], to_string(status))

            state =
              fail_waiting_delegations(
                state,
                id,
                "The screen context could not be captured. Tell the caller briefly and ask them to try again."
              )

            to_socket(state, {:voice_call, :context_failed, id})
            {:ok, %{accepted: true}, state}

          %{id: ^id, status: ^status} ->
            {:ok, %{accepted: true}, state}

          _ ->
            {:error, :invalid_input}
        end

      true ->
        state = cancel(state, :context_timeout)

        state =
          invalidate_waiting_delegations(
            state,
            "The screen context for this request was superseded. Ask the caller to try again."
          )

        state =
          fail_waiting_delegations(
            state,
            id,
            "The screen context could not be captured. Tell the caller briefly and ask them to try again."
          )

        to_socket(state, {:voice_call, :context_failed, id})
        tombstone = %{id: id, status: status, text: nil, attachments: []}
        next_state = %{state | highest_context_id: id, ptt_context: tombstone}
        next_state = context_trace(next_state, id, status, nil, [], to_string(status))
        {:ok, %{accepted: true}, next_state}
    end
  end

  defp flush_waiting_delegations(
         %{ptt_context: %{id: context_id, status: :complete, native_start_ms: boundary}} = state,
         context_id
       )
       when is_integer(boundary) do
    Enum.reduce(state.delegations, state, fn
      {id,
       %{
         status: :pending,
         enqueued: false,
         context_id: ^context_id,
         waiting_for_context: true,
         native_start_ms: start_ms
       }},
      acc ->
        if start_ms >= boundary do
          delegation = %{Map.fetch!(acc.delegations, id) | waiting_for_context: false}
          acc = %{acc | delegations: Map.put(acc.delegations, id, delegation)}
          flush_delegation(acc, id)
        else
          fail_unbound_ptt_delegation(acc, id)
        end

      _, acc ->
        acc
    end)
  end

  defp flush_waiting_delegations(state, _context_id), do: state

  defp fail_waiting_delegations(state, context_id, reason_message) do
    Enum.reduce(state.delegations, state, fn
      {id,
       %{
         status: :pending,
         enqueued: false,
         context_id: ^context_id
       }},
      acc ->
        fail_delegation(acc, id, reason_message)

      _, acc ->
        acc
    end)
  end

  defp invalidate_waiting_delegations(state, reason_message) do
    Enum.reduce(state.delegations, state, fn
      {id, %{status: :pending, enqueued: false} = delegation}, acc ->
        if delegation[:context_id] do
          to_socket(acc, {:voice_call, :context_failed, delegation.context_id})
        end

        fail_delegation(acc, id, reason_message)

      _, acc ->
        acc
    end)
  end

  defp fail_delegation(state, id, reason_message) do
    case state.delegations do
      %{^id => %{status: :pending} = delegation} when state.phase == :live ->
        state =
          if delegation.enqueued do
            state
          else
            trace_record(state, "delegation_requested", %{
              "delegation_id" => id,
              "request" => delegation.request,
              "context_id" => delegation.context_id,
              "native_turn_id" => delegation.native_turn_id,
              "attachments" => []
            })
          end

        append(
          state,
          if(state.mode == :push_to_talk, do: :final, else: :instructions),
          id,
          reason_message ||
            "The assistant cannot take this request right now. Tell the caller briefly and offer to try again later."
        )

        electron_delegation(state, id, "failed")
        finish_delegation(state, id, "failed")

      _ ->
        state
    end
  end

  defp fail_unbound_ptt_delegation(state, id) do
    fail_delegation(
      state,
      id,
      "Screen context is not linked to this speech turn. Ask the user to try again."
    )
  end

  defp fail_invalid_ptt_delegation(state, id, context_id, msg) do
    to_socket(state, {:voice_call, :context_failed, context_id})
    fail_delegation(state, id, msg)
  end

  defp progress(state, id, stage) do
    case state.delegations do
      %{^id => %{status: :pending}} when state.phase == :live ->
        case stage do
          :thinking -> append(state, :thinking, id, @thinking_progress)
          :apology -> append(state, :commentary, id, @apology)
        end

        trace_record(state, "progress", %{"delegation_id" => id, "stage" => to_string(stage)})

      _ ->
        state
    end
  end

  defp answer_delegation(state, nil), do: state

  defp answer_delegation(state, id) do
    case state.delegations do
      %{^id => %{status: :pending}} ->
        electron_delegation(state, id, "answered")
        finish_delegation(state, id, "answered")

      _ ->
        state
    end
  end

  defp electron_delegation(%{carrier: :electron} = state, id, status),
    do: to_socket(state, {:voice_call, :delegation, id, status})

  defp electron_delegation(_state, _id, _status), do: :ok

  defp finish_delegation(state, id, outcome) do
    delegation = Map.fetch!(state.delegations, id)
    Enum.each(delegation.timers, &Process.cancel_timer/1)

    SalixVoice.Telemetry.delegation_stop(now() - delegation.created_mono, outcome)

    state =
      trace_record(state, "delegation_finished", %{
        "delegation_id" => id,
        "result" => outcome,
        "duration_ms" =>
          max(System.convert_time_unit(now() - delegation.created_mono, :native, :millisecond), 0)
      })

    %{
      state
      | delegations: Map.put(state.delegations, id, %{delegation | status: :done, timers: []})
    }
  end

  # -- Ending ------------------------------------------------------------------

  # Ask the model to tell the caller why the call ends, then end after the
  # notice audio goes quiet or `notice_max_ms`. Without audio flowing the call
  # ends at once.

  defp notice_then_end(%{phase: :live} = state, reason, notice) do
    cond do
      state.closing != nil ->
        state

      state.model_started_mono && state.socket ->
        append(state, :instructions, nil, notice)
        start_closing(state, reason, state.timers.notice_max_ms)

      true ->
        end_call(state, reason)
    end
  end

  defp notice_then_end(state, _reason, _notice), do: state

  defp start_closing(state, reason, max_ms) do
    %{state | closing: %{reason: reason}}
    |> schedule(:closing_max, max_ms, :closing_done)
  end

  defp end_call(state, reason), do: state |> begin_ending(reason) |> maybe_finish_ending()

  defp begin_ending(%{phase: :live} = state, reason) do
    state = state |> cancel_all() |> stop_profile()

    Enum.each(state.delegations, fn {_id, delegation} ->
      Enum.each(delegation.timers, &Process.cancel_timer/1)
    end)

    to_socket(state, {:voice_call, :end, reason})
    if state.group_monitor, do: :pg.demonitor(@pg, state.group_monitor)
    _ = :pg.leave(@pg, {:group_call, state.group_id}, self())
    if state.key_id, do: :pg.leave(@pg, {:voice_key, state.key_id}, self())
    if state.model_pid && not state.model_closed?, do: close_model(state)

    %{state | phase: :ending, end_reason: reason, ended_mono: now(), closing: nil}
  end

  defp begin_ending(state, _reason), do: state

  defp force_end(%{phase: :finalized} = state, _reason, _deadline), do: state

  defp force_end(state, reason, deadline) do
    state = state |> begin_ending(reason) |> emit_call_ended()

    remaining =
      min(ending_remaining_ms(state), max(deadline - System.monotonic_time(:millisecond), 0))

    if await_task(state.call_ended_task, remaining) == :timeout do
      Logger.warning(
        "voice call end ingress unconfirmed at shutdown deadline call=#{state.call_id}"
      )
    end

    state = begin_trace_finish(state)
    state = await_final_trace(state, deadline)
    finalize(state)
  end

  defp close_model(state) do
    state.model_mod.close(state.model_pid)
  catch
    _, _ -> :ok
  end

  defp finalize(%{phase: :ending} = state) do
    state = cancel_all(state)

    # A model that did not confirm its close within the wait is stopped, so
    # no session outlives its call.
    if is_pid(state.model_pid) and not state.model_closed?,
      do: Process.exit(state.model_pid, :kill)

    for {id, %{status: :pending}} <- state.delegations do
      SalixVoice.Telemetry.delegation_stop(
        now() - state.delegations[id].created_mono,
        "abandoned"
      )
    end

    SalixVoice.Telemetry.call_stop(
      state.ended_mono - state.started_mono,
      state.carrier,
      state.end_reason
    )

    meter(state)

    # Leave synchronously so the call is gone from `:pg` before the actor stops.
    _ = :pg.leave(@pg, {:call, state.call_id}, self())
    _ = :pg.leave(@pg, :calls, self())

    for {from, ref} <- state.drain_waiters, do: send(from, {:voice_drained, ref, state.call_id})

    %{state | phase: :finalized, drain_waiters: []}
  end

  defp finalize(state), do: state

  defp meter(state) do
    case Application.get_env(:salix_voice, :metering_mod) do
      nil ->
        :ok

      mod ->
        attrs = metering_attrs(state)

        if Enum.any?(attrs.components, &(&1.quantity > 0)) do
          group_directory =
            Application.get_env(:salix_voice, :group_directory_mod, SalixIM.GroupDirectory)

          Task.Supervisor.start_child(SalixVoice.TaskSupervisor, fn ->
            try do
              owner =
                case group_directory.get_group(state.group_id) do
                  {:ok, group} when is_map(group) -> group["billing_owner"]
                  _ -> nil
                end

              mod.charge(Map.put(attrs, :owner_snapshot, owner))
            catch
              kind, reason ->
                Logger.error(
                  "voice metering failed call=#{state.call_id} #{inspect({kind, reason})}"
                )
            end
          end)
        end
    end
  end

  @doc false
  def metering_attrs(state) do
    elapsed_model_seconds =
      if is_integer(state.model_started_mono),
        do:
          ceil_seconds((state.model_closed_mono || state.ended_mono) - state.model_started_mono),
        else: 0

    # A reported total is authoritative. After a transport loss the usage is
    # only the last snapshot, so the session's elapsed time is the floor.
    model_seconds =
      case state.model_usage do
        %{"seconds" => seconds} when is_number(seconds) and seconds >= 0 ->
          if state.model_transport_lost?,
            do: max(ceil(seconds), elapsed_model_seconds),
            else: ceil(seconds)

        _ ->
          elapsed_model_seconds
      end

    # Twilio bills the call from the answered webhook; a WebSocket session
    # counts only while its socket was attached.
    carrier_start = if state.carrier == :twilio, do: state.started_mono, else: state.attached_mono

    carrier_seconds =
      if is_integer(carrier_start), do: ceil_seconds(state.ended_mono - carrier_start), else: 0

    %{
      source_key: "voice:#{state.carrier}:#{state.carrier_call_id}",
      call_id: state.call_id,
      group_id: state.group_id,
      tenant_id: state.tenant_id,
      connect_id: state.connect_id,
      carrier: to_string(state.carrier),
      key_id: state.key_id,
      provider: "openai",
      sku: state.sku,
      components: [
        %{component: :model_seconds, meter_unit: :second, quantity: model_seconds},
        %{component: :carrier_seconds, meter_unit: :second, quantity: carrier_seconds}
      ],
      metered_at: DateTime.utc_now()
    }
  end

  defp ceil_seconds(native) do
    ms = System.convert_time_unit(max(native, 0), :native, :millisecond)
    div(ms + 999, 1000)
  end

  # Crash reports and `:sys.get_status/1` must not expose credentials or
  # conversation content retained by the call or its trace buffer.
  @impl GenServer
  def format_status(status) do
    Map.update(status, :state, nil, fn
      %{model_settings: settings} = state ->
        settings =
          if is_map(settings),
            do: Map.replace(settings, "openai_api_key", :redacted),
            else: settings

        state
        |> Map.put(:model_settings, settings)
        |> Map.put(:model_input, :redacted)
        |> Map.put(:trace, :redacted)
        |> Map.put(:ledger, :redacted)
        |> Map.put(:ptt_context, :redacted)
        |> Map.put(:delegations, :redacted)

      state ->
        state
    end)
    |> Map.update(:message, :redacted, fn _ -> :redacted end)
    |> Map.update(:reason, :redacted, fn _ -> :redacted end)
  end

  @impl GenServer
  def terminate(_reason, %{phase: :finalized}), do: :ok

  def terminate(_reason, state) do
    _ = force_end(state, :other, SalixVoice.Drain.force_deadline())
    :ok
  end

  # -- Helpers -----------------------------------------------------------------

  defp noreply(%{phase: :finalized} = state), do: {:stop, :normal, state}
  defp noreply(state), do: {:noreply, state}

  defp trace_record(state, type, fields),
    do: %{state | trace: CallTrace.record(state.trace, type, fields)}

  defp archive_identity(%{trace: nil}), do: nil

  defp archive_identity(state) do
    %{tenant_id: state.tenant_id, agent_id: state.trace.agent_id, session_id: state.call_id}
  end

  defp archive_voice(state, boundary, payload) do
    if identity = archive_identity(state) do
      case boundary do
        :delivery -> SalixAgent.EventArchive.Emit.voice_delivery(identity, payload)
        :tool_call -> SalixAgent.EventArchive.Emit.voice_tool_call(identity, payload)
        :tool_result -> SalixAgent.EventArchive.Emit.voice_tool_result(identity, payload)
      end
    end

    state
  end

  defp caller_turn(state, text, turn, offset_ms) do
    fields = %{"text" => text, "turn" => turn, "offset_ms" => offset_ms}

    state
    |> archive_voice(:delivery, Map.put(fields, "kind", "caller_turn"))
    |> trace_record("caller_turn", fields)
  end

  defp reserve_egress(%{egress_reservation: {turn, _}} = state, turn), do: state

  defp reserve_egress(state, turn) do
    reservation =
      if identity = archive_identity(state),
        do: SalixAgent.EventArchive.Emit.reserve_voice_egress(identity)

    %{state | egress_reservation: {turn, reservation}}
  end

  defp agent_turn(state, text, turn) do
    state = reserve_egress(state, turn)
    {_turn, reservation} = state.egress_reservation
    fields = %{"text" => text, "turn" => turn}

    if identity = archive_identity(state),
      do: SalixAgent.EventArchive.Emit.voice_egress(identity, fields, reservation)

    %{state | egress_reservation: nil} |> trace_record("agent_turn", fields)
  end

  defp router_reply(state, op, request, text, delegation_id) do
    fields = %{
      "operation" => to_string(op),
      "text" => text,
      "delegation_id" => delegation_id,
      "agent_id" => request["agent_id"],
      "session_id" => request["session_id"]
    }

    state |> archive_voice(:tool_result, fields) |> trace_record("router_reply", fields)
  end

  defp attachment_metadata(attachments) do
    Enum.map(attachments, fn attachment ->
      %{
        "name" => attachment["name"] || attachment[:name],
        "path" => attachment["path"] || attachment[:path],
        "mime" => attachment["mime"] || attachment[:mime],
        "bytes" =>
          attachment["bytes"] || attachment[:bytes] || attachment["size"] || attachment[:size]
      }
    end)
  end

  defp context_trace(state, context_id, status, text, attachments, reason \\ nil) do
    fields = %{
      "context_id" => context_id,
      "status" => to_string(status),
      "text" => text,
      "attachments" => attachment_metadata(attachments),
      "reason" => reason
    }

    state
    |> archive_voice(:delivery, Map.put(fields, "kind", "ptt_context"))
    |> trace_record("ptt_context", fields)
  end

  defp safe_error_code(code)
       when code in [
              :plan_limit,
              :sign_in_required,
              :invalid_answer,
              :subscription_access_unavailable
            ],
       do: Atom.to_string(code)

  defp safe_error_code(_), do: "other"

  defp begin_trace_finish(state) do
    fields = %{
      "reason" => to_string(state.end_reason),
      "duration_ms" =>
        max(
          System.convert_time_unit(state.ended_mono - state.started_mono, :native, :millisecond),
          0
        ),
      "usage" => state.model_usage
    }

    %{state | trace: CallTrace.finish(state.trace, fields)}
  end

  defp finish_trace(state) do
    state = begin_trace_finish(state)

    cond do
      CallTrace.finished?(state.trace) ->
        finalize(state)

      ending_remaining_ms(state) <= 0 ->
        %{state | trace: CallTrace.discard(state.trace)} |> finalize()

      true ->
        wait_for_ending(state)
    end
  end

  defp await_final_trace(state, deadline) do
    remaining =
      min(ending_remaining_ms(state), max(deadline - System.monotonic_time(:millisecond), 0))

    cond do
      CallTrace.finished?(state.trace) ->
        state

      remaining <= 0 ->
        %{state | trace: CallTrace.discard(state.trace)}

      state.trace.task != nil ->
        {task, _, _} = state.trace.task

        case Task.yield(task, remaining) do
          {:ok, result} ->
            %{state | trace: CallTrace.result(state.trace, task.ref, result)}
            |> await_final_trace(deadline)

          {:exit, _} ->
            %{state | trace: CallTrace.down(state.trace, task.ref)}
            |> await_final_trace(deadline)

          nil ->
            %{state | trace: CallTrace.discard(state.trace)}
        end

      true ->
        receive do
          :voice_trace_flush ->
            %{state | trace: CallTrace.on_timer(state.trace)} |> await_final_trace(deadline)
        after
          remaining -> %{state | trace: CallTrace.discard(state.trace)}
        end
    end
  end

  defp append(%{model_pid: pid} = state, kind, delegation_id, text) when is_pid(pid) do
    state.model_mod.append(pid, kind, delegation_id, text)
  catch
    _, _ -> :ok
  end

  defp append(_state, _kind, _delegation_id, _text), do: :ok

  defp to_socket(%{socket: socket}, message) when is_pid(socket), do: send(socket, message)
  defp to_socket(_state, _message), do: :ok

  defp busy_key(state), do: {state.started_at_ms, state.call_id}

  defp probe_busy(state, pids) do
    for pid <- pids, pid != self(), do: send(pid, {:voice_busy_probe, self(), busy_key(state)})
    :ok
  end

  defp call_info(state) do
    %{
      call_id: state.call_id,
      carrier: state.carrier,
      tenant_id: state.tenant_id,
      group_id: state.group_id,
      connect_id: state.connect_id,
      caller: state.caller,
      carrier_call_id: state.carrier_call_id,
      audio_format: state.audio_format,
      key_id: state.key_id,
      display_name: state.display_name,
      started_at_ms: state.started_at_ms,
      max_duration_s: div(state.max_call_ms, 1000)
    }
  end

  defp schedule(state, _name, nil, _event), do: state

  defp schedule(state, name, ms, event) do
    state = cancel(state, name)
    ref = Process.send_after(self(), {:timer, name, event}, max(ms, 0))
    %{state | timer_refs: Map.put(state.timer_refs, name, ref)}
  end

  defp schedule_expiry(state, nil), do: state

  defp schedule_expiry(state, %DateTime{} = expires_at),
    do: schedule_expiry(state, DateTime.to_unix(expires_at, :millisecond))

  defp schedule_expiry(state, expires_at_ms) when is_integer(expires_at_ms),
    do:
      schedule(state, :key_expiry, expires_at_ms - System.system_time(:millisecond), :key_expired)

  defp schedule_expiry(state, _other), do: state

  defp cancel(state, name) do
    case Map.pop(state.timer_refs, name) do
      {nil, _refs} ->
        state

      {ref, refs} ->
        Process.cancel_timer(ref)
        %{state | timer_refs: refs}
    end
  end

  defp cancel_all(state) do
    Enum.each(state.timer_refs, fn {_name, ref} -> Process.cancel_timer(ref) end)
    %{state | timer_refs: %{}}
  end

  defp clean_exit?(reason),
    do: reason in [:normal, :shutdown] or match?({:shutdown, _}, reason)

  defp now, do: System.monotonic_time()

  defp revoked_notice,
    do:
      "The caller's access was revoked. Tell the caller in one short sentence that the call must end now."

  defp draining_notice,
    do:
      "The service is restarting. Tell the caller in one short sentence that the call must end now and they can call back."

  defp max_notice,
    do:
      "The call reached its time limit. Tell the caller in one short sentence that the call must end now."
end
