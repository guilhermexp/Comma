defmodule SalixVoice.CallActorTest do
  use ExUnit.Case, async: false

  alias SalixStore.{Keys, S3}
  alias SalixVoice.Model.Fake
  alias SalixVoice.{Settings, TestStubs}

  @pg SalixVoice.PG

  setup do
    S3.delete(Keys.ctl_system_voice())

    {:ok, _} =
      Settings.update(%{
        "enabled" => true,
        "openai_api_key" => "sk-test",
        "max_calls_per_node" => 50
      })

    env = [
      model_mod: Fake,
      fake_model_observer: self(),
      test_pid: self(),
      test_admission: :ok,
      ingress_mod: TestStubs.Ingress,
      group_directory_mod: TestStubs.GroupDirectory,
      metering_mod: TestStubs.Metering,
      profile_decider_mod: TestStubs.ProfileDecider,
      test_profile_decision: {:error, "not_configured"},
      fake_model_seconds: 42,
      timers: [
        delegation_settle_ms: 20,
        progress_thinking_ms: 5_000,
        progress_apology_ms: 10_000,
        model_close_wait_ms: 300,
        notice_max_ms: 300,
        hangup_max_ms: 400,
        quiet_ms: 100
      ]
    ]

    previous = Enum.map(env, fn {key, _} -> {key, Application.fetch_env(:salix_voice, key)} end)
    Enum.each(env, fn {key, value} -> Application.put_env(:salix_voice, key, value) end)

    on_exit(fn ->
      for {key, value} <- previous do
        case value do
          {:ok, value} -> Application.put_env(:salix_voice, key, value)
          :error -> Application.delete_env(:salix_voice, key)
        end
      end

      SalixVoice.TestCalls.stop_all()
      S3.delete(Keys.ctl_system_voice())
      SalixCluster.NodeLifecycle.clear_draining()
    end)

    :ok
  end

  defp admit(overrides \\ %{}) do
    Map.merge(
      %{
        carrier: :websocket,
        tenant_id: "ten_1",
        group_id: "grp_" <> Integer.to_string(System.unique_integer([:positive])),
        connect_id: "conn_voice",
        caller: %{"kind" => "api_key", "value" => "key_1"},
        carrier_call_id: nil,
        audio_format: :pcmu_8k,
        key_id: "key_1",
        key_name: "Desk phone",
        principal: "api_key:key_1:usr_creator",
        display_name: "Ada"
      },
      overrides
    )
    |> SalixVoice.admit()
  end

  test "insufficient credits refuses admission before a call or model is started" do
    Application.put_env(
      :salix_voice,
      :test_admission,
      {:error,
       {:billing_unavailable,
        struct!(BillingCore.FeeControl.Decision, allowed?: false, reason: "insufficient_credits")}}
    )

    group = "grp_credit_denied"

    assert {:error,
            %{
              "error_class" => "billing_unavailable",
              "reason" => "insufficient_credits",
              "retryable" => false
            }} = admit(%{group_id: group})

    refute SalixVoice.group_busy?(group)
    refute_receive {:fake_model, _, {:started, _}}, 20
    Application.put_env(:salix_voice, :test_admission, :ok)
    assert {:ok, %{call_id: call}} = admit(%{group_id: group})
    assert is_pid(SalixVoice.whereis(call))
  end

  # Admit and attach the test process as the carrier socket; returns the call
  # pid, its info and the fake model pid.
  defp live_call(overrides \\ %{}, opts \\ []) do
    {:ok, %{call_id: call_id, token: token}} = admit(overrides)

    {:ok, call, info} =
      if token,
        do: SalixVoice.attach(token, self(), carrier_call_id: overrides[:carrier_call_id]),
        else: SalixVoice.attach(call_id, self())

    assert_receive {:fake_model, model, {:started, model_opts}}
    assert model_opts.audio_format == info.audio_format

    if Keyword.get(opts, :start_model, true) do
      emit(model, call, {:started, "sess_1"})
      assert_receive {:fake_model, ^model, {:append, :instructions, nil, _greeting}}
      assert_receive {:ingress, _, _, %{"event_type" => "voice.call_started"}, _, _}, 1_000
    end

    {call, info, model}
  end

  # Deliver a model event and wait until the call has handled it.
  defp emit(model, call, event) do
    Fake.emit(model, event)
    _ = :sys.get_state(model)
    _ = :sys.get_state(call)
    :ok
  end

  defp request(info, extra) do
    Map.merge(
      %{
        "group_id" => info.group_id,
        "connect_id" => info.connect_id,
        "agent_id" => "agt_router",
        "delegation_id" => nil,
        "text" => nil
      },
      extra
    )
  end

  defp provider(call, op, info, extra),
    do: GenServer.call(call, {:voice_provider, op, request(info, extra)})

  defp await_end(call, reason) do
    ref = Process.monitor(call)
    assert_receive {:voice_call, :end, ^reason}, 2_000
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 2_000
  end

  for first <- [:model, :carrier] do
    @tag :voice_greeting
    test "greets a silent caller once when #{first} is ready first" do
      {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
      [call] = :pg.get_members(@pg, {:call, id})
      assert_receive {:fake_model, model, {:started, _}}

      case unquote(first) do
        :model ->
          emit(model, call, {:started, "greeting-session"})
          refute_receive {:fake_model, ^model, {:append, _, _, _}}, 50
          assert {:ok, ^call, _} = SalixVoice.attach(id, self())

        :carrier ->
          assert {:ok, ^call, _} = SalixVoice.attach(id, self())
          refute_receive {:fake_model, ^model, {:append, _, _, _}}, 50
          emit(model, call, {:started, "greeting-session"})
      end

      assert_receive {:fake_model, ^model, {:append, :instructions, nil, greeting}}
      assert is_binary(greeting) and byte_size(greeting) > 0
      refute_received {:fake_model, ^model, {:audio, _}}
      emit(model, call, {:audio, <<1, 2, 3>>})
      assert_receive {:voice_call, :audio, <<1, 2, 3>>}

      emit(model, call, {:started, "greeting-session"})
      assert {:error, :already_attached} = SalixVoice.attach(id, self())
      refute_receive {:fake_model, ^model, {:append, _, _, _}}, 50
    end
  end

  defp answer(choice, probability_bp),
    do: %{"choice" => choice, "probabilities_bp" => %{choice => probability_bp}}

  defp put_timer(name, ms) do
    timers = Application.fetch_env!(:salix_voice, :timers)
    Application.put_env(:salix_voice, :timers, Keyword.put(timers, name, ms))
  end

  test "confident profile fields reach the model instructions and the greeting" do
    Application.put_env(
      :salix_voice,
      :test_profile_decision,
      {:ok,
       %{
         "answers" => %{
           "language" => answer("es", 9_000),
           "small_talk" => answer("skip", 9_000),
           "units" => answer("metric", 6_000),
           "formality" => answer("unknown", 9_500),
           "reply_length" => answer("short", 9_000)
         }
       }}
    )

    {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
    [call] = :pg.get_members(@pg, {:call, id})

    assert_receive {:profile_decide, _group_id, questions, opts}
    assert opts[:entrypoint] == "voice_profile"
    assert is_integer(opts[:admission_deadline])
    assert Map.has_key?(questions, "language")

    assert_receive {:fake_model, model, {:started, model_opts}}
    base = SalixVoice.CallActor.instructions()
    assert String.starts_with?(model_opts.instructions, base <> "\n\n")
    profile = String.replace_prefix(model_opts.instructions, base, "")

    # Above-threshold choices render; a low probability, unknown, or an
    # option that matches the base instructions adds nothing.
    assert profile =~ "Spanish"
    assert profile =~ "small talk"
    refute profile =~ "metric"
    refute profile =~ "tone"
    assert length(String.split(String.trim(profile), "\n- ")) == 3

    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    emit(model, call, {:started, "profile-session"})
    assert_receive {:fake_model, ^model, {:append, :instructions, nil, greeting}}
    assert greeting =~ "Spanish"
  end

  test "a slow profile gives way to the base instructions at its deadline" do
    put_timer(:profile_ms, 100)

    Application.put_env(
      :salix_voice,
      :test_profile_decision,
      {:sleep, 2_000, {:ok, %{"answers" => %{}}}}
    )

    {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
    [call] = :pg.get_members(@pg, {:call, id})
    refute_receive {:fake_model, _, {:started, _}}, 50

    assert_receive {:fake_model, model, {:started, model_opts}}, 1_000
    assert model_opts.instructions == SalixVoice.CallActor.instructions()

    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    emit(model, call, {:started, "late-profile-session"})
    assert_receive {:fake_model, ^model, {:append, :instructions, nil, greeting}}
    assert greeting =~ "English"
  end

  test "credits exhausted after admission stop the call before model startup" do
    put_timer(:profile_ms, 1_000)

    Application.put_env(
      :salix_voice,
      :test_profile_decision,
      {:sleep, 200, {:ok, %{"answers" => %{}}}}
    )

    {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
    call = SalixVoice.whereis(id)
    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    assert_receive {:profile_decide, _, _, _}

    Application.put_env(
      :salix_voice,
      :test_admission,
      {:error,
       {:billing_unavailable,
        struct!(BillingCore.FeeControl.Decision, allowed?: false, reason: "insufficient_credits")}}
    )

    await_end(call, :billing_unavailable)
    refute_receive {:fake_model, _, {:started, _}}, 20
  end

  test "a call that ends while its profile is pending never starts the model" do
    put_timer(:profile_ms, 5_000)

    Application.put_env(
      :salix_voice,
      :test_profile_decision,
      {:sleep, 2_000, {:ok, %{"answers" => %{}}}}
    )

    {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
    [call] = :pg.get_members(@pg, {:call, id})
    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    assert_receive {:profile_decide, _, _, _}

    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)
    refute_receive {:fake_model, _, {:started, _}}, 100
  end

  test "the Router gets one call-start input when the call is ready, and can speak first" do
    {:ok, %{call_id: id}} = admit(%{carrier: :signal, key_id: nil})
    [call] = :pg.get_members(@pg, {:call, id})
    assert_receive {:fake_model, model, {:started, _}}
    assert {:ok, ^call, info} = SalixVoice.attach(id, self())
    refute_receive {:ingress, _, _, _, _, _}, 50

    emit(model, call, {:started, "sess_start"})

    assert_receive {:ingress, group_id, content, metadata, source_id, opts}, 1_000
    assert group_id == info.group_id
    assert source_id == "im_provider:voice:conn_voice:#{id}:start"
    assert opts[:session_name] == "Voice call"
    refute Keyword.has_key?(opts, :trusted_source_text)
    assert content =~ "The caller just connected"
    assert content =~ "im_api.voice.say (call_id #{id})"

    assert %{
             "provider" => "voice",
             "connect_id" => "conn_voice",
             "chat_id" => ^id,
             "chat_type" => "private",
             "from_user_id" => "key_1",
             "event_type" => "voice.call_started",
             "event_id" => ^id,
             "source_actor_type" => "provider_user"
           } = metadata

    # No message_id: a reply to this input names no delegation.
    refute Map.has_key?(metadata, "message_id")

    # A repeated model start neither greets nor announces the call again.
    emit(model, call, {:started, "sess_start"})
    refute_receive {:ingress, _, _, _, _, _}, 50

    assert {:ok, %{"delivered" => true, "delegation_id" => nil}} =
             provider(call, :say, info, %{"text" => "Your build finished."})

    assert_receive {:fake_model, ^model, {:append, :commentary, nil, "Your build finished."}}
  end

  test "the Router gets one call-end input with the reason and unanswered requests" do
    {call, info, model} = live_call()
    emit(model, call, {:delegation, "dlg_open", 500})
    assert_receive {:ingress, _, _, %{"event_type" => "voice.delegation"}, _, _}, 1_000

    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)

    assert_receive {:ingress, group_id, content, metadata, source_id, opts}, 1_000
    assert group_id == info.group_id
    assert source_id == "im_provider:voice:conn_voice:#{info.call_id}:end"
    assert opts[:session_name] == "Voice call"
    assert content =~ "the caller hung up (reason caller_hangup)"
    assert content =~ "One caller request was still unanswered."

    assert %{"event_type" => "voice.call_ended", "chat_id" => chat_id} = metadata
    assert chat_id == info.call_id
    refute Map.has_key?(metadata, "message_id")
    refute_receive {:ingress, _, _, _, _, _}, 50
  end

  test "the call-end input follows a slow call-start input" do
    Application.put_env(:salix_voice, :test_ingress_delays, %{"voice.call_started" => 200})
    on_exit(fn -> Application.delete_env(:salix_voice, :test_ingress_delays) end)

    {:ok, %{call_id: id}} = admit()
    [call] = :pg.get_members(@pg, {:call, id})
    assert_receive {:fake_model, model, {:started, _}}
    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    emit(model, call, {:started, "sess_order"})
    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)

    assert_receive {:ingress, _, _, %{"event_type" => first}, _, _}, 1_000
    assert_receive {:ingress, _, _, %{"event_type" => second}, _, _}, 1_000
    assert [first, second] == ["voice.call_started", "voice.call_ended"]
  end

  test "a call that never became ready sends the Router nothing" do
    {:ok, %{call_id: id}} = admit()
    [call] = :pg.get_members(@pg, {:call, id})
    assert {:ok, ^call, _} = SalixVoice.attach(id, self())
    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)
    refute_receive {:ingress, _, _, _, _, _}, 100
  end

  test "a failed call-start input leaves the call live" do
    Application.put_env(:salix_voice, :test_ingress_result, {:error, :router_unavailable})
    on_exit(fn -> Application.delete_env(:salix_voice, :test_ingress_result) end)

    {call, info, model} = live_call()
    _ = :sys.get_state(call)

    assert {:ok, %{"delivered" => true}} = provider(call, :say, info, %{"text" => "Hello."})
    assert_receive {:fake_model, ^model, {:append, :commentary, nil, "Hello."}}
  end

  test "caller audio before the model starts keeps the newest 2 s, then flows both ways" do
    {call, _info, model} = live_call(%{}, start_model: false)

    # 30 frames of 100 ms (800 bytes of mu-law) before the model is ready.
    for i <- 1..30, do: send(call, {:voice_carrier, :audio, :binary.copy(<<i>>, 800)})
    _ = :sys.get_state(call)
    refute_received {:fake_model, ^model, {:audio, _}}

    Fake.emit(model, {:started, "sess_1"})

    for i <- 11..30 do
      frame = :binary.copy(<<i>>, 800)
      assert_receive {:fake_model, ^model, {:audio, ^frame}}
    end

    refute_received {:fake_model, ^model, {:audio, _}}

    send(call, {:voice_carrier, :audio, <<99>>})
    assert_receive {:fake_model, ^model, {:audio, <<99>>}}

    Fake.emit(model, {:audio, <<1, 2, 3>>})
    assert_receive {:voice_call, :audio, <<1, 2, 3>>}

    Fake.emit(model, :speech_started)
    assert_receive {:voice_call, :clear}

    Fake.emit(model, {:input_transcript, "Hello", true, 100})
    assert_receive {:voice_call, :transcript, :caller, "Hello", true}
    Fake.emit(model, {:output_transcript, "Hi there.", true})
    assert_receive {:voice_call, :transcript, :agent, "Hi there.", true}
  end

  test "a delegation becomes Router provider input with the caller's words up to its offset" do
    {_call, info, model} = live_call()

    Fake.emit(model, {:output_transcript, "Hello, how can I help? ", true})
    Fake.emit(model, {:output_transcript, "Tell me more.", true})
    Fake.emit(model, {:input_transcript, "What's the weather", true, 1_000})
    Fake.emit(model, {:input_transcript, "in Paris?", true, 1_400})
    Fake.emit(model, {:input_transcript, "Also book", true, 3_000})
    Fake.emit(model, {:delegation, "dlg_1", 2_000})

    expected_call_id = info.call_id

    assert_receive {:ingress, group_id, content, %{"chat_id" => ^expected_call_id} = metadata,
                    source_id, opts},
                   1_000

    assert group_id == info.group_id
    assert source_id == "im_provider:voice:conn_voice:#{info.call_id}:dlg_1"
    assert opts[:trusted_source_text] == "What's the weather in Paris?"
    assert opts[:session_name] == "Voice call"
    assert content =~ "What's the weather in Paris?"
    assert content =~ "Tell me more."
    refute content =~ "Also book"

    assert %{
             "provider" => "voice",
             "connect_id" => "conn_voice",
             "chat_id" => chat_id,
             "chat_type" => "private",
             "message_id" => "dlg_1",
             "from_user_id" => "api_key:key_1",
             "from_username" => "Ada",
             "event_type" => "voice.delegation",
             "event_id" => "dlg_1",
             "source_actor_type" => "provider_system",
             "api_key_id" => "key_1",
             "api_key_name" => "Desk phone",
             "api_key_principal" => "api_key:key_1:usr_creator",
             "source_sent_at_ms" => sent_at
           } = metadata

    assert chat_id == info.call_id
    assert is_integer(sent_at)

    # The next delegation carries only the words after the previous one.
    Fake.emit(model, {:delegation, "dlg_2", 4_000})
    assert_receive {:ingress, _, _content, _, _, opts}, 1_000
    assert opts[:trusted_source_text] == "Also book"
  end

  for carrier <- [:twilio, :websocket] do
    test "#{carrier} does not receive Electron delegation status" do
      {call, info, model} = live_call(%{carrier: unquote(carrier), carrier_call_id: "CA_status"})
      emit(model, call, {:delegation, "dlg_private", 500})
      assert_receive {:ingress, _, _, %{"event_type" => "voice.delegation"}, _, _}, 1_000
      assert {:ok, _} = provider(call, :say, info, %{"text" => "Done."})
      assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_private", "Done."}}
      refute_receive {:voice_call, :delegation, _, _}, 30
    end
  end

  test "voice.say speaks through commentary in chunks and answers the oldest delegation" do
    {call, info, model} = live_call()
    emit(model, call, {:delegation, "dlg_1", 500})
    emit(model, call, {:delegation, "dlg_2", 900})
    assert_receive {:ingress, _, _, _, _, _}, 1_000
    assert_receive {:ingress, _, _, _, _, _}, 1_000

    sentence = String.duplicate("word ", 60) |> String.trim() |> Kernel.<>(".")
    long = Enum.map_join(1..8, " ", fn _ -> sentence end)

    assert {:ok, %{"delivered" => true, "chunks" => chunks, "delegation_id" => "dlg_1"}} =
             provider(call, :say, info, %{"text" => long})

    assert chunks > 1

    appended =
      for _ <- 1..chunks do
        assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_1", text}}
        assert String.length(text) <= 1_800
        text
      end

    assert Enum.join(appended, " ") == long

    assert {:ok, %{"delegation_id" => "dlg_2", "chunks" => 1}} =
             provider(call, :say, info, %{"text" => "Paris is sunny."})

    assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_2", "Paris is sunny."}}

    assert {:ok, %{"delegation_id" => "dlg_2"}} =
             provider(call, :say, info, %{"text" => "Anything else?", "delegation_id" => "dlg_2"})

    assert {:ok, %{"chunks" => 1}} =
             provider(call, :note, info, %{"text" => "Checking the calendar."})

    assert_receive {:fake_model, ^model, {:append, :thinking, nil, "Checking the calendar."}}
  end

  test "provider calls for another Group or connect are forbidden; bad input is rejected" do
    {call, info, model} = live_call()
    emit(model, call, {:delegation, "dlg_1", 500})
    assert_receive {:ingress, _, _, _, _, _}, 1_000

    assert {:error, :forbidden} =
             GenServer.call(
               call,
               {:voice_provider, :say,
                request(info, %{"group_id" => "grp_other", "text" => "hi"})}
             )

    assert {:error, :forbidden} =
             GenServer.call(
               call,
               {:voice_provider, :say,
                request(info, %{"connect_id" => "conn_other", "text" => "hi"})}
             )

    assert {:error, {:bad_request, _}} = provider(call, :say, info, %{"text" => "  "})

    assert {:error, {:bad_request, _}} =
             provider(call, :say, info, %{"text" => "hi", "delegation_id" => "dlg_x"})

    assert {:error, {:bad_request, _}} = provider(call, :transfer, info, %{"text" => "hi"})
    refute_received {:fake_model, ^model, {:append, _, _, _}}
  end

  test "an unanswered delegation gets one thinking update and one spoken apology" do
    Application.put_env(:salix_voice, :timers,
      delegation_settle_ms: 10,
      progress_thinking_ms: 60,
      progress_apology_ms: 150,
      model_close_wait_ms: 300
    )

    {call, info, model} = live_call()
    emit(model, call, {:delegation, "dlg_slow", 500})
    emit(model, call, {:delegation, "dlg_fast", 700})

    assert {:ok, %{"delegation_id" => "dlg_slow"}} =
             provider(call, :say, info, %{"text" => "Done.", "delegation_id" => "dlg_slow"})

    assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_slow", "Done."}}

    assert_receive {:fake_model, ^model,
                    {:append, :thinking, "dlg_fast", "The assistant is still working on it."}},
                   1_000

    assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_fast", "Sorry" <> _}}, 1_000
    Process.sleep(200)
    refute_received {:fake_model, ^model, {:append, _, "dlg_slow", "The assistant" <> _}}
    refute_received {:fake_model, ^model, {:append, _, _, _}}
  end

  test "voice.hang_up speaks the farewell, ends the call and bills it" do
    handler = attach_telemetry()

    {call, info, model} =
      live_call(%{
        carrier: :twilio,
        carrier_call_id: "CA_hangup",
        caller: %{"kind" => "e164", "value" => "+15551234567"},
        key_id: nil
      })

    # A phone caller is a provider user identified by the E.164 number.
    emit(model, call, {:delegation, "dlg_phone", 100})
    assert_receive {:ingress, _, _, metadata, _, _}, 1_000
    assert metadata["source_actor_type"] == "provider_user"
    assert metadata["from_user_id"] == "+15551234567"
    refute Map.has_key?(metadata, "api_key_principal")

    assert {:ok, %{"ending" => true}} =
             provider(call, :hang_up, info, %{
               "text" => "Goodbye!",
               "delegation_id" => "dlg_phone"
             })

    assert_receive {:fake_model, ^model, {:append, :commentary, "dlg_phone", "Goodbye!"}}
    Fake.emit(model, {:audio, <<1>>})
    assert_receive {:voice_call, :audio, <<1>>}

    await_end(call, :agent_hangup)
    assert_receive {:fake_model, ^model, :close}

    # A call another test ended may bill after this test starts; match this one.
    assert_receive {:metered, %{source_key: "voice:twilio:CA_hangup"} = attrs}, 1_000
    assert attrs.group_id == info.group_id
    assert attrs.tenant_id == "ten_1"
    assert attrs.owner_snapshot["billing_account_id"] == "ba_voice"
    assert attrs.provider == "openai"
    assert attrs.sku == "gpt-live-1"

    assert [
             %{component: :model_seconds, meter_unit: :second, quantity: 42},
             %{component: :carrier_seconds, meter_unit: :second, quantity: carrier_seconds}
           ] = attrs.components

    assert carrier_seconds >= 1
    # Other tests' calls may end while this handler is attached; this is the
    # only Twilio call.
    assert_receive {:telemetry, [:salix, :voice, :call, :stop], %{duration: _},
                    %{transport: "twilio"} = meta}

    assert meta == %{transport: "twilio", reason: "agent_hangup"}
    :telemetry.detach(handler)
  end

  test "voice.hang_up without text ends at once; a late provider call finds no call" do
    {call, info, _model} = live_call()
    assert {:ok, %{"ending" => true}} = provider(call, :hang_up, info, %{})
    await_end(call, :agent_hangup)
    assert SalixVoice.whereis(info.call_id) == nil
  end

  test "one active call per Group: admission refuses a second call and a race ends the later one" do
    group_id = "grp_busy"
    {:ok, _} = admit(%{group_id: group_id})
    assert {:error, :busy} = admit(%{group_id: group_id})

    # Two calls that both passed admission: the later {started_at_ms, call_id} ends.
    settings = elem(Settings.get(), 1)

    args = fn call_id, started ->
      %{
        call_id: call_id,
        carrier: :websocket,
        tenant_id: "ten_1",
        group_id: "grp_race",
        connect_id: "conn_voice",
        caller: %{"kind" => "api_key", "value" => "key_1"},
        carrier_call_id: nil,
        audio_format: :pcmu_8k,
        settings: settings,
        started_at_ms: started
      }
    end

    {:ok, early} =
      DynamicSupervisor.start_child(
        SalixVoice.CallSupervisor,
        {SalixVoice.CallActor, args.("vc_EARLY", 1_000)}
      )

    {:ok, late} =
      DynamicSupervisor.start_child(
        SalixVoice.CallSupervisor,
        {SalixVoice.CallActor, args.("vc_LATE", 2_000)}
      )

    late_ref = Process.monitor(late)
    assert_receive {:DOWN, ^late_ref, :process, ^late, :normal}, 2_000
    assert Process.alive?(early)
    assert :pg.get_members(@pg, {:group_call, "grp_race"}) == [early]
  end

  test "a Group call that becomes visible only after this call started still ends the later one" do
    # `:pg` propagates a remote join asynchronously. Two nodes can admit calls
    # for one Group within that window (or across a healed partition), and then
    # neither call saw the other in `get_members` at its start. `remote` stands
    # in for such a remote CallActor: it joins after this call started and
    # answers a busy probe with an earlier `{started_at_ms, call_id}`.
    {call, info, _model} = live_call()
    test = self()

    remote =
      spawn(fn ->
        :ok = :pg.join(@pg, {:group_call, info.group_id}, self())
        send(test, :remote_joined)

        receive do
          {:voice_busy_probe, pid, key} ->
            send(test, {:remote_probed, pid, key})
            send(pid, {:voice_busy_probe_reply, self(), {0, "vc_REMOTE_EARLIER"}})
        end

        Process.sleep(:infinity)
      end)

    assert_receive :remote_joined
    assert_receive {:remote_probed, ^call, {_started_at_ms, call_id}}, 1_000
    assert call_id == info.call_id
    await_end(call, :busy)
    assert :pg.get_members(@pg, {:group_call, info.group_id}) == [remote]
    Process.exit(remote, :kill)
  end

  test "node cap, disabled voice and a missing model key refuse admission" do
    {:ok, _} = Settings.update(%{"max_calls_per_node" => 1})
    {:ok, _} = admit()
    assert {:error, :node_full} = admit()

    {:ok, _} = Settings.update(%{"enabled" => false})
    assert {:error, :disabled} = admit()

    {:ok, _} = Settings.update(%{"enabled" => true, "clear_secrets" => ["openai_api_key"]})
    assert {:error, :not_configured} = admit()
  end

  test "a revoked voice key plays a notice and ends the call as revoked" do
    {call, _info, model} = live_call(%{key_id: "key_revoked"})

    for pid <- :pg.get_members(@pg, {:voice_key, "key_revoked"}),
        do: send(pid, {:voice_key_revoked, "key_revoked"})

    assert_receive {:fake_model, ^model, {:append, :instructions, nil, _notice}}
    await_end(call, :revoked)
  end

  test "an expiring voice key ends the call at its expiry" do
    expires = System.system_time(:millisecond) + 150
    {call, _info, _model} = live_call(%{key_id: "key_expiring", key_expires_at: expires})
    await_end(call, :revoked)
  end

  test "drain tells callers the call must end, ends every local call and refuses new ones" do
    {call, _info, model} = live_call()
    {:ok, %{call_id: waiting}} = admit()

    SalixCluster.NodeLifecycle.mark_draining()
    assert {:error, :draining} = admit()

    assert :ok = SalixVoice.Drain.drain()
    assert_receive {:fake_model, ^model, {:append, :instructions, nil, _notice}}
    assert_receive {:voice_call, :end, :draining}
    refute Process.alive?(call)
    assert SalixVoice.whereis(waiting) == nil
  end

  test "the call deadline ends the call" do
    Application.put_env(:salix_voice, :timers, max_call_ms: 100, notice_max_ms: 100, quiet_ms: 50)
    handler = attach_telemetry()
    {call, _info, model} = live_call()
    assert_receive {:fake_model, ^model, {:append, :instructions, nil, _notice}}, 1_000
    await_end(call, :max_duration)
    assert_receive {:telemetry, [:salix, :voice, :call, :stop], _, %{reason: "timeout"}}
    :telemetry.detach(handler)
  end

  test "Twilio attach needs the stream token, the admitted CallSid and a single socket" do
    {:ok, %{call_id: call_id, token: token}} =
      admit(%{
        carrier: :twilio,
        carrier_call_id: "CA_attach",
        caller: %{"kind" => "e164", "value" => "+15551234567"}
      })

    assert is_binary(token)
    assert {:error, :token_required} = SalixVoice.attach(call_id, self())

    assert {:error, :carrier_call_mismatch} =
             SalixVoice.attach(token, self(), carrier_call_id: "CA_other")

    # A `start` frame without a callSid does not skip the binding check.
    assert {:error, :carrier_call_mismatch} = SalixVoice.attach(token, self())

    assert {:ok, _call, info} = SalixVoice.attach(token, self(), carrier_call_id: "CA_attach")
    assert info.carrier_call_id == "CA_attach"

    other = spawn(fn -> Process.sleep(:infinity) end)

    assert {:error, :already_attached} =
             SalixVoice.attach(token, other, carrier_call_id: "CA_attach")

    assert {:error, :invalid_token} = SalixVoice.attach("forged.token", other)
  end

  test "a call whose carrier never attaches ends; a lost socket ends the call" do
    Application.put_env(:salix_voice, :timers, attach_websocket_ms: 100, model_close_wait_ms: 100)
    {:ok, %{call_id: call_id}} = admit()
    call = SalixVoice.whereis(call_id)
    ref = Process.monitor(call)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 1_000

    {:ok, %{call_id: call_id}} = admit()
    socket = spawn(fn -> receive do: (:stop -> exit(:crash)) end)
    {:ok, call, _info} = SalixVoice.attach(call_id, socket)
    ref = Process.monitor(call)
    handler = attach_telemetry()
    send(socket, :stop)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 1_000
    assert_receive {:telemetry, [:salix, :voice, :call, :stop], _, %{reason: "carrier_error"}}
    :telemetry.detach(handler)
  end

  test "a stale attach timeout does not end an attached call" do
    {call, _info, _model} = live_call()

    # The timer fired just before the attach cancelled it.
    send(call, {:timer, :attach, :attach_timeout})
    _ = :sys.get_state(call)
    assert Process.alive?(call)
    refute_received {:voice_call, :end, _}
  end

  test "the call keeps no platform secrets in its state or status" do
    {call, _info, _model} = live_call()

    refute inspect(:sys.get_state(call)) =~ "sk-test"
    refute inspect(:sys.get_status(call)) =~ "sk-test"

    # Before the model starts, a crash report redacts the key.
    status = %{state: %{model_settings: %{"openai_api_key" => "sk-test"}}}
    refute inspect(SalixVoice.CallActor.format_status(status)) =~ "sk-test"
  end

  test "after a model transport loss the elapsed session time is the billing floor" do
    {call, info, model} = live_call()
    Process.sleep(20)

    # The last usage snapshot is older than the session.
    Fake.emit(model, {:closed, "connection_lost", %{"seconds" => 0}})
    await_end(call, :model_error)

    source_key = "voice:websocket:#{info.call_id}"
    assert_receive {:metered, %{source_key: ^source_key} = attrs}, 1_000

    assert [%{component: :model_seconds, quantity: model_seconds}, _carrier] = attrs.components
    assert model_seconds >= 1
  end

  test "removing a caller number ends that number's phone call as revoked" do
    {call, info, model} =
      live_call(%{
        carrier: :twilio,
        carrier_call_id: "CA_removed",
        caller: %{"kind" => "e164", "value" => "+15557654321"},
        key_id: nil
      })

    assert :ok = SalixVoice.revoke_caller(info.group_id, "+15550000000")
    _ = :sys.get_state(call)
    refute_received {:voice_call, :end, _}

    assert :ok = SalixVoice.revoke_caller(info.group_id, "+15557654321")
    assert_receive {:fake_model, ^model, {:append, :instructions, nil, _notice}}
    await_end(call, :revoked)
  end

  test "a model that fails before starting ends the call as a model error" do
    {:ok, %{call_id: call_id}} = admit()
    {:ok, call, _info} = SalixVoice.attach(call_id, self())
    assert_receive {:fake_model, model, {:started, _}}
    Fake.emit(model, {:error, %{"code" => "invalid_api_key"}})
    await_end(call, :model_error)
  end

  defp attach_telemetry do
    handler = "voice-test-#{System.unique_integer([:positive])}"
    parent = self()

    :telemetry.attach_many(
      handler,
      [[:salix, :voice, :call, :stop], [:salix, :voice, :delegation, :stop]],
      fn event, measurements, meta, _ ->
        send(parent, {:telemetry, event, measurements, meta})
      end,
      nil
    )

    handler
  end

  # -- Push-to-talk causal consumer & authority regressions --------------------

  defmodule CausalTestIngress do
    @moduledoc false
    def enqueue_group_router_im_provider_message(group, content, metadata, source, opts) do
      event_type = metadata["event_type"]
      test_pid = Application.get_env(:salix_voice, :causal_test_pid)

      if is_pid(test_pid) do
        send(test_pid, {:ingress_call, event_type, metadata, source})
      end

      interceptor = Application.get_env(:salix_voice, :causal_ingress_interceptor)

      result =
        if is_function(interceptor, 2) do
          interceptor.(event_type, fn ->
            SalixIM.ProviderConnects.enqueue_group_router_im_provider_message(
              group,
              content,
              metadata,
              source,
              opts
            )
          end)
        else
          SalixIM.ProviderConnects.enqueue_group_router_im_provider_message(
            group,
            content,
            metadata,
            source,
            opts
          )
        end

      if is_pid(test_pid) do
        send(test_pid, {:ingress, group, content, metadata, source, opts})
      end

      result
    end
  end

  defmodule LostNotification do
    @moduledoc false
    def notify_conversation(_, _), do: :ok
  end

  defp setup_causal_ptt_fixture(opts \\ %{}) do
    alias SalixStore.{Ids, CasRecord}

    case Process.whereis(SalixStore.S3.Fake) do
      nil -> start_supervised!(SalixStore.S3.Fake)
      _ -> :ok
    end

    SalixAgent.TestSupport.configure_control_fixtures!()

    test_pid = self()

    timers = [
      delegation_settle_ms: Map.get(opts, :settle_ms, 20),
      delegation_enqueue_wait_ms: Map.get(opts, :enqueue_wait_ms, 1_000),
      progress_thinking_ms: 5_000,
      progress_apology_ms: 10_000,
      model_close_wait_ms: 300,
      notice_max_ms: 300,
      hangup_max_ms: 400,
      quiet_ms: 100,
      context_timeout_ms: 2_000
    ]

    overrides = [
      {:salix_voice, :ingress_mod, CausalTestIngress},
      {:salix_voice, :causal_test_pid, test_pid},
      {:salix_voice, :causal_ingress_interceptor, Map.get(opts, :interceptor)},
      {:salix_voice, :test_pid, test_pid},
      {:salix_voice, :metering_mod, TestStubs.Metering},
      {:salix_voice, :group_directory_mod, TestStubs.GroupDirectory},
      {:salix_voice, :timers, timers},
      {:salix_agent, :im_provider_mod, SalixIM.Provider},
      {:salix_im, :agent_delivery_mod, LostNotification},
      {:salix_im, :agent_workspace_mod, Salix.Bindings.IMAgentWorkspace}
    ]

    previous =
      for {app, key, value} <- overrides do
        old = Application.fetch_env(app, key)
        Application.put_env(app, key, value)
        {app, key, old}
      end

    on_exit(fn ->
      for {app, key, old} <- previous do
        case old do
          {:ok, value} -> Application.put_env(app, key, value)
          :error -> Application.delete_env(app, key)
        end
      end
    end)

    {:ok, _} =
      Settings.update(%{
        "enabled" => true,
        "openai_api_key" => "sk-test",
        "max_calls_per_node" => 50
      })

    tenant = Ids.new_tenant_id()
    group = Ids.new_group_id(tenant)
    SalixAgent.TestSupport.create_control_group!(group)

    router =
      SalixAgent.TestSupport.create_control_agent_in_group!(tenant, group, %{
        "role" => "router",
        "name" => "Router",
        "runtime_config" => %{"kind" => "internal"}
      })

    {:ok, _} =
      CasRecord.update(Keys.ctl_group(group), &Map.put(&1, "router_agent_id", router["agent_id"]))

    {:ok, connect} = SalixIM.VoiceConnects.ensure_voice_im_connect(tenant, group)
    {:ok, conversation} = SalixIM.RouterConversationInput.ensure(group)

    admit_params = %{
      carrier: :websocket,
      mode: :push_to_talk,
      tenant_id: tenant,
      group_id: group,
      connect_id: connect["connect_id"],
      caller: %{"kind" => "comma_user", "value" => "owner"},
      principal: "comma_user:#{tenant}:owner"
    }

    {:ok, %{call_id: call_id, token: token}} = admit(admit_params)

    {:ok, call, info} =
      if token,
        do: SalixVoice.attach(token, self()),
        else: SalixVoice.attach(call_id, self())

    assert_receive {:fake_model, model, {:started, _}}, 1_000
    emit(model, call, {:started, "sess_ptt"})
    assert_receive {:ingress, ^group, _, %{"event_type" => "voice.call_started"}, _, _}, 1_000

    %{
      tenant: tenant,
      group: group,
      router: router,
      connect: connect,
      conversation: conversation,
      call: call,
      info: info,
      model: model,
      call_id: call_id
    }
  end

  defp execute_late_voice_tool(fixture, ended_msg, delegation_id, text \\ "Done") do
    {:ok, binding} =
      SalixIM.ConversationSource.binding(fixture.router["agent_id"], %{
        group_id: fixture.group,
        conversation_id: fixture.conversation["conversation_id"],
        participant_id: fixture.conversation["router_participant_id"]
      })

    {:ok, entry} = SalixIM.ConversationSource.entry(binding, ended_msg)

    tool_ctx = %{
      agent_id: fixture.router["agent_id"],
      group_id: fixture.group,
      tenant_id: fixture.tenant,
      role: "router",
      runtime_kind: :internal,
      llm_tool_envelope: true,
      visible_reply_phase: :clean,
      source_message_id: entry.source_message_id,
      source_message_ids: [entry.source_message_id],
      trusted_origin: entry.payload.trusted_origin,
      trusted_origins: [entry.payload.trusted_origin]
    }

    entries = SalixAgent.Tools.ImRouter.dynamic_disclosure_entries(tool_ctx)
    tool_ctx = Map.put(tool_ctx, :tool_disclosure, %{"tools" => entries})

    params = %{
      "connect_id" => fixture.connect["connect_id"],
      "delegation_id" => delegation_id,
      "text" => text
    }

    [result] =
      SalixAgent.Tools.execute(
        [
          %{
            id: "late-voice-result",
            name: "call",
            args: %{"tool" => "im_api.voice.say", "params" => params}
          }
        ],
        tool_ctx
      )

    result
  end

  defp get_ended_conversation_message(fixture) do
    {:ok, messages} =
      SalixIM.Conversations.list_group_conversation_messages(
        fixture.group,
        fixture.conversation["conversation_id"],
        limit: 10
      )

    Enum.find(messages, &(get_in(&1, ["metadata", "event_type"]) == "voice.call_ended"))
  end

  @tag :ptt_causal_regressions
  test "push_to_talk hangup while context is pending never treats delegation as accepted or authorizes late voice.say" do
    fixture = setup_causal_ptt_fixture()
    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Context 1 begins in pending state
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 1, status: :pending}})

    # Delegation emitted while context is pending
    emit(model, call, {:delegation, "del_pending_ctx", 100, "[ptt-context:1] Summarize screen"})

    # Caller hangs up while context is still pending
    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)

    assert_receive {:ingress, ^group, ended_content,
                    %{"event_type" => "voice.call_ended"} = ended_meta, _, _},
                   2_000

    pending_ids = Map.get(ended_meta, "voice_pending_delegation_ids", [])
    refute "del_pending_ctx" in pending_ids
    refute String.contains?(ended_content, "del_pending_ctx")

    # Canonical consumer authority: late voice.say must reject unaccepted pending-context delegation
    ended_msg = get_ended_conversation_message(fixture)
    assert ended_msg
    result = execute_late_voice_tool(fixture, ended_msg, "del_pending_ctx")
    assert result.error
  end

  @tag :ptt_causal_regressions
  test "push_to_talk hangup during settle never treats unforwarded delegation as accepted or authorizes late voice.say" do
    # 200ms settle window to reliably hang up before flush
    fixture = setup_causal_ptt_fixture(%{settle_ms: 200})
    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Context 2: begin pending FIRST, then complete (valid API precondition)
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 2, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 2,
                  status: :complete,
                  text: "Active screen content",
                  attachments: []
                }}
             )

    # Delegation emitted into settle window
    emit(model, call, {:delegation, "del_settle", 100, "[ptt-context:2] Summarize screen"})

    # Hang up immediately during settle
    send(call, {:voice_carrier, :hangup, :normal})
    await_end(call, :caller_hangup)

    assert_receive {:ingress, ^group, ended_content,
                    %{"event_type" => "voice.call_ended"} = ended_meta, _, _},
                   2_000

    # Never forwarded to Router, must not masquerade as accepted
    pending_ids = Map.get(ended_meta, "voice_pending_delegation_ids", [])
    refute "del_settle" in pending_ids
    refute String.contains?(ended_content, "del_settle")

    # Canonical consumer authority: late voice.say rejected
    ended_msg = get_ended_conversation_message(fixture)
    assert ended_msg
    result = execute_late_voice_tool(fixture, ended_msg, "del_settle")
    assert result.error
  end

  @tag :ptt_causal_regressions
  test "push_to_talk forwarding in flight rejects un-ACKed delegation when Router enqueue fails" do
    parent = self()

    interceptor = fn
      "voice.delegation", _proceed ->
        send(parent, {:delegation_in_flight, self()})

        receive do
          :release_with_failure ->
            {:error, :router_unavailable}
        end

      _other, proceed ->
        proceed.()
    end

    fixture = setup_causal_ptt_fixture(%{settle_ms: 10, interceptor: interceptor})
    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Context 3: begin pending, then complete
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 3, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 3,
                  status: :complete,
                  text: "Active screen content",
                  attachments: []
                }}
             )

    emit(model, call, {:delegation, "del_flight_failed", 100, "[ptt-context:3] Summarize screen"})

    # Wait until forwarding is in flight at the Router boundary
    assert_receive {:delegation_in_flight, task_pid}, 1_000

    # Caller hangs up while forwarding is in flight
    send(call, {:voice_carrier, :hangup, :normal})
    # Media close signal emitted immediately to caller socket
    assert_receive {:voice_call, :end, :caller_hangup}, 1_000

    # Release Router enqueue with failure
    send(task_pid, :release_with_failure)

    ref = Process.monitor(call)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 2_000

    assert_receive {:ingress, ^group, ended_content,
                    %{"event_type" => "voice.call_ended"} = ended_meta, _, _},
                   2_000

    pending_ids = Map.get(ended_meta, "voice_pending_delegation_ids", [])
    refute "del_flight_failed" in pending_ids
    refute String.contains?(ended_content, "del_flight_failed")

    # Canonical consumer authority: un-ACKed delegation cannot be authorized for late voice.say
    ended_msg = get_ended_conversation_message(fixture)
    assert ended_msg
    result = execute_late_voice_tool(fixture, ended_msg, "del_flight_failed")
    assert result.error
  end

  @tag :ptt_causal_regressions
  test "push_to_talk forwarding in flight preserves accepted work upon delayed successful Router ACK with bounded termination" do
    parent = self()

    interceptor = fn
      "voice.delegation", proceed ->
        send(parent, {:delegation_in_flight, self()})

        receive do
          :release_with_success ->
            proceed.()
        end

      _other, proceed ->
        proceed.()
    end

    fixture = setup_causal_ptt_fixture(%{settle_ms: 10, interceptor: interceptor})
    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Context 4: begin pending, then complete
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 4, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 4,
                  status: :complete,
                  text: "Active screen content",
                  attachments: []
                }}
             )

    emit(model, call, {:delegation, "del_flight_ok", 100, "[ptt-context:4] Summarize screen"})

    assert_receive {:delegation_in_flight, task_pid}, 1_000

    # Hang up while in flight
    send(call, {:voice_carrier, :hangup, :normal})
    # Media close signal emitted immediately to caller socket
    assert_receive {:voice_call, :end, :caller_hangup}, 1_000

    # While Router ACK is held, assert NO premature call-ended ingress call is initiated (premature handoff defect)
    refute_receive {:ingress_call, "voice.call_ended", _, _}, 200

    # Release successful Router ACK
    send(task_pid, :release_with_success)

    # Actor reaches clean bounded termination
    ref = Process.monitor(call)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 2_000

    assert_receive {:ingress, ^group, ended_content,
                    %{"event_type" => "voice.call_ended"} = ended_meta, _, _},
                   2_000

    # Actual accepted work survives in ended handoff metadata and content
    pending_ids = Map.get(ended_meta, "voice_pending_delegation_ids", [])
    assert "del_flight_ok" in pending_ids
    assert String.contains?(ended_content, "del_flight_ok")

    # Canonical consumer authority: late voice.say is authorized for actual accepted work
    ended_msg = get_ended_conversation_message(fixture)
    assert ended_msg
    result = execute_late_voice_tool(fixture, ended_msg, "del_flight_ok")
    refute result.error
  end

  @tag :ptt_causal_regressions
  test "push_to_talk in-flight forwarding bounds actor termination and never marks stalled enqueue as accepted" do
    parent = self()

    interceptor = fn
      "voice.delegation", _proceed ->
        send(parent, {:delegation_in_flight, self()})
        # Stalls indefinitely
        Process.sleep(10_000)
        {:ok, :queued}

      _other, proceed ->
        proceed.()
    end

    fixture = setup_causal_ptt_fixture(%{settle_ms: 10, interceptor: interceptor})
    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Context 5: begin pending, then complete
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 5, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 5,
                  status: :complete,
                  text: "Active screen content",
                  attachments: []
                }}
             )

    emit(model, call, {:delegation, "del_stalled", 100, "[ptt-context:5] Summarize screen"})

    assert_receive {:delegation_in_flight, _task_pid}, 1_000

    # Hang up while in flight
    send(call, {:voice_carrier, :hangup, :normal})
    assert_receive {:voice_call, :end, :caller_hangup}, 1_000

    # CallActor must terminate in a bounded timeframe (e.g. within 2.5s), NOT wait 10 seconds
    ref = Process.monitor(call)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 2_500

    assert_receive {:ingress, ^group, ended_content,
                    %{"event_type" => "voice.call_ended"} = ended_meta, _, _},
                   2_500

    # Because it stalled past bounded termination, it was never accepted before shutdown
    pending_ids = Map.get(ended_meta, "voice_pending_delegation_ids", [])
    refute "del_stalled" in pending_ids
    refute String.contains?(ended_content, "del_stalled")

    ended_msg = get_ended_conversation_message(fixture)
    assert ended_msg
    result = execute_late_voice_tool(fixture, ended_msg, "del_stalled")
    assert result.error
  end

  @tag :ptt_causal_regressions
  @tag timeout: 15_000
  test "push_to_talk actor mailbox responds ended promptly to voice.say for accepted work while subsequent forwarding is held" do
    parent = self()
    {:ok, blocker} = Agent.start_link(fn -> false end)

    interceptor = fn
      "voice.delegation", proceed ->
        if Agent.get(blocker, & &1) do
          send(parent, {:second_delegation_in_flight, self()})

          receive do
            :release_second_delegation -> proceed.()
          end
        else
          proceed.()
        end

      _other, proceed ->
        proceed.()
    end

    # Enqueue wait of 6_000ms exceeds the 5_000ms VoiceProvider GenServer.call timeout
    fixture =
      setup_causal_ptt_fixture(%{settle_ms: 10, enqueue_wait_ms: 6_000, interceptor: interceptor})

    call = fixture.call
    model = fixture.model
    group = fixture.group

    # Gesture 1: context 1 (pending -> complete)
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 1, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 1,
                  status: :complete,
                  text: "Screen for first request",
                  attachments: []
                }}
             )

    # Delegation 1 emitted -> flushes -> enqueued to Router -> ACKed immediately
    emit(model, call, {:delegation, "del_first_acked", 100, "[ptt-context:1] First task"})

    assert_receive {:ingress, ^group, _,
                    %{"event_type" => "voice.delegation", "message_id" => "del_first_acked"}, _,
                    _},
                   1_000

    # Retrieve canonical original voice.delegation conversation message for del_first_acked
    {:ok, messages} =
      SalixIM.Conversations.list_group_conversation_messages(
        group,
        fixture.conversation["conversation_id"],
        limit: 10
      )

    first_delegation_msg =
      Enum.find(messages, &(get_in(&1, ["metadata", "message_id"]) == "del_first_acked"))

    assert first_delegation_msg

    # Now signal interceptor to block the next delegation
    Agent.update(blocker, fn _ -> true end)

    # Gesture 2: context 2 (pending -> complete)
    assert {:ok, %{accepted: true}} =
             GenServer.call(call, {:context, %{context_id: 2, status: :pending}})

    assert {:ok, %{accepted: true}} =
             GenServer.call(
               call,
               {:context,
                %{
                  context_id: 2,
                  status: :complete,
                  text: "Screen for second request",
                  attachments: []
                }}
             )

    # Delegation 2 emitted -> forwarding starts and hits interceptor barrier
    emit(model, call, {:delegation, "del_second_held", 200, "[ptt-context:2] Second task"})
    assert_receive {:second_delegation_in_flight, second_task_pid}, 1_000

    # Caller hangs up while second delegation forwarding is in flight
    send(call, {:voice_carrier, :hangup, :normal})
    assert_receive {:voice_call, :end, :caller_hangup}, 1_000

    # Canonical consumer authority: Tools/ImRouter voice.say for the accepted first delegation
    # while second ACK is still held must succeed without hitting the 5s provider timeout or voice_outcome_unknown
    result =
      execute_late_voice_tool(
        fixture,
        first_delegation_msg,
        "del_first_acked",
        "Answering first accepted task."
      )

    refute result.error

    # Final text must be persisted in the conversation
    {:ok, final_messages} =
      SalixIM.Conversations.list_group_conversation_messages(
        group,
        fixture.conversation["conversation_id"],
        limit: 20
      )

    reply_msg =
      Enum.find(final_messages, fn msg ->
        msg["actor_type"] == "agent" and
          get_in(msg, ["metadata", "voice_delegation_id"]) == "del_first_acked"
      end)

    assert reply_msg
    assert [%{"text" => "Answering first accepted task."}] = reply_msg["content"]

    # Release second delegation ACK so actor finishes bounded finalization
    send(second_task_pid, :release_second_delegation)

    ref = Process.monitor(call)
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 2_000
  end
end
