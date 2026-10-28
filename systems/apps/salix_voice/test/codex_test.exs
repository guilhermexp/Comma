defmodule SalixVoice.Model.CodexTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  alias SalixVoice.Model.Codex

  defmodule Accounts do
    def select(_tenant),
      do: Application.get_env(:salix_voice, :codex_test_selection, {:ok, "account_fixture"})

    def access(_tenant, _id, revision) do
      send(Application.fetch_env!(:salix_voice, :codex_test_pid), {:access, revision})

      {:ok,
       %{
         "access_token" => if(revision, do: "secret-renewed", else: "secret-original"),
         "chatgpt_account_id" => "acct_fixture",
         "credential_revision" => "revision_fixture"
       }}
    end
  end

  defmodule LostNotification do
    def notify_conversation(_, _), do: :ok
  end

  defmodule ObservedIngress do
    def enqueue_group_router_im_provider_message(group, content, metadata, source, opts) do
      observer = Application.get_env(:salix_voice, :codex_test_pid)

      result =
        SalixIM.ProviderConnects.enqueue_group_router_im_provider_message(
          group,
          content,
          metadata,
          source,
          opts
        )

      if is_pid(observer) do
        send(observer, {:ingress, group, content, metadata, source, opts})
      end

      result
    end
  end

  defmodule Socket do
    @behaviour WebSock
    def init(state) do
      send(state.test, {:socket, self()})
      {:ok, state}
    end

    def handle_in({data, [opcode: :text]}, state) do
      send(state.test, {:sent, Jason.decode!(data)})
      {:ok, state}
    end

    def handle_info({:push, event}, state), do: {:push, {:text, Jason.encode!(event)}, state}
    def terminate(_, _), do: :ok
  end

  defmodule Endpoint do
    import Plug.Conn
    def init(opts), do: opts

    def call(conn, test: test) do
      send(
        test,
        {:headers, conn.method, conn.request_path, conn.query_string, Map.new(conn.req_headers)}
      )

      if conn.method == "POST" do
        {:ok, body, conn} = read_body(conn)
        send(test, {:offer, Jason.decode!(body)})
        status = Application.get_env(:salix_voice, :codex_test_status, 201)

        status =
          if status == 401 and Application.get_env(:salix_voice, :codex_test_renewal_works, true) and
               get_req_header(conn, "authorization") == ["Bearer secret-renewed"],
             do: 201,
             else: status

        if status == 201 do
          conn
          |> put_resp_header("location", "/realtime/calls/rtc_fixture")
          |> send_resp(201, "answer-sdp")
        else
          send_resp(
            conn,
            status,
            ~s({"error":{"message":"secret-original","code":"provider_failure"}})
          )
        end
      else
        conn |> WebSockAdapter.upgrade(Socket, %{test: test}, timeout: 30_000) |> halt()
      end
    end
  end

  setup do
    env = [
      codex_accounts_mod: Accounts,
      codex_test_pid: self(),
      codex_test_status: 201,
      codex_test_renewal_works: true,
      codex_test_selection: {:ok, "account_fixture"}
    ]

    old = Enum.map(env, fn {k, _} -> {k, Application.fetch_env(:salix_voice, k)} end)
    Enum.each(env, fn {k, v} -> Application.put_env(:salix_voice, k, v) end)

    listener =
      start_supervised!(
        {Bandit, plug: {Endpoint, test: self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(listener)

    Application.put_env(:salix_voice, :codex,
      signaling_url: "http://127.0.0.1:#{port}/realtime/calls",
      sideband_url: "ws://127.0.0.1:#{port}/v1/live",
      version: "9.9.9"
    )

    on_exit(fn ->
      Application.delete_env(:salix_voice, :codex)

      Enum.each(old, fn
        {k, {:ok, v}} -> Application.put_env(:salix_voice, k, v)
        {k, :error} -> Application.delete_env(:salix_voice, k)
      end)
    end)

    :ok
  end

  defp model do
    ref = make_ref()

    pid =
      start_supervised!(
        Supervisor.child_spec(
          {Codex,
           %{
             owner: self(),
             ref: ref,
             audio_format: :pcm16_24k,
             instructions: "Be brief.",
             settings: %{},
             input: %{tenant_id: "tenant", account_id: "account_fixture", sdp: "offer-sdp"}
           }},
          restart: :temporary
        )
      )

    {pid, ref}
  end

  test "relays SDP, keeps Desktop headers on server, normalizes captions and splits UTF8 context" do
    {pid, ref} = model()
    assert_receive {:access, nil}, 2_000
    assert_receive {:headers, "POST", "/realtime/calls", query, h}, 2_000
    assert query == "intent=quicksilver&architecture=avas"
    assert h["authorization"] == "Bearer secret-original"
    assert h["chatgpt-account-id"] == "acct_fixture"
    assert h["openai-alpha"] == "quicksilver=v2"
    assert h["user-agent"] == "Codex Desktop/9.9.9"
    assert h["originator"] == "Codex Desktop"
    assert h["version"] == "9.9.9"
    assert h["session-id"] == h["thread-id"]
    assert h["x-session-id"] != h["session-id"]
    assert_receive {:offer, %{"sdp" => "offer-sdp", "session" => session}}

    assert session == %{
             "model" => "gpt-live-1-codex",
             "instructions" => "Be brief.",
             "audio" => %{"output" => %{"voice" => "cove"}},
             "delegation" => %{"type" => "client"}
           }

    assert_receive {:headers, "GET", "/v1/live/rtc_fixture", "", side_headers}, 2_000

    auth_headers =
      ~w(authorization chatgpt-account-id openai-alpha user-agent originator version x-session-id session-id thread-id)

    assert Map.take(side_headers, auth_headers) == Map.take(h, auth_headers)
    assert_receive {:socket, server}
    assert_receive {:voice_model, ^ref, {:signaled, "answer-sdp"}}
    refute inspect(:sys.get_state(pid)) =~ "secret-"
    refute inspect(:sys.get_status(pid)) =~ "secret-"
    send(server, {:push, %{"type" => "session.started", "session" => %{"id" => "rtc_fixture"}}})
    assert_receive {:voice_model, ^ref, {:started, "rtc_fixture"}}

    for event <- [
          %{"type" => "input_transcript.added", "item" => %{"text" => "Remind me"}},
          %{"type" => "turn.done", "turn" => %{"role" => "user", "transcript" => "Remind me"}},
          %{"type" => "turn.done", "turn" => %{"role" => "user", "transcript" => "Remind me"}}
        ],
        do: send(server, {:push, event})

    assert_receive {:voice_model, ^ref, {:caption, :caller, 1, "Remind me", false}}
    assert_receive {:voice_model, ^ref, {:caption, :caller, 1, "Remind me", true}}
    refute_receive {:voice_model, ^ref, {:caption, _, _, _, _}}, 30

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_1",
           "content" => [%{"type" => "input_text", "text" => "tomorrow at nine"}]
         }
       }}
    )

    assert_receive {:voice_model, ^ref, {:delegation, "del_1", nil, "tomorrow at nine"}}
    text = String.duplicate("é😀", 180)
    Codex.append(pid, :commentary, "del_1", text)

    chunks =
      for _ <- 1..3 do
        assert_receive {:sent,
                        %{
                          "type" => "delegation.context.append",
                          "delegation_item_id" => "del_1",
                          "channel" => "commentary",
                          "content" => [%{"type" => "input_text", "text" => chunk}]
                        }},
                       1_000

        assert byte_size(chunk) <= 500
        assert String.valid?(chunk)
        chunk
      end

    assert Enum.join(chunks) == text
    Codex.close(pid)
    assert_receive {:sent, %{"type" => "session.close"}}
    send(server, {:push, %{"type" => "session.closed"}})
    assert_receive {:voice_model, ^ref, {:closed, "closed", %{}}}
  end

  test "401 renews exactly once" do
    Application.put_env(:salix_voice, :codex_test_status, 401)
    {_pid, ref} = model()
    assert_receive {:access, nil}, 2_000
    assert_receive {:access, "revision_fixture"}, 2_000
    assert_receive {:voice_model, ^ref, {:signaled, "answer-sdp"}}, 2_000
    refute_receive {:access, _}, 30
  end

  test "a second 401 fails safely without another renewal" do
    Application.put_env(:salix_voice, :codex_test_status, 401)
    Application.put_env(:salix_voice, :codex_test_renewal_works, false)
    {_pid, ref} = model()
    assert_receive {:access, nil}, 2_000
    assert_receive {:access, "revision_fixture"}, 2_000
    assert_receive {:voice_model, ^ref, {:fatal_error, :sign_in_required}}, 2_000
    refute_receive {:access, _}, 30
  end

  test "sideband usage limits close with a safe plan error" do
    {_pid, ref} = model()
    assert_receive {:socket, socket}, 2_000
    assert_receive {:voice_model, ^ref, {:signaled, _}}, 2_000

    send(
      socket,
      {:push,
       %{
         "type" => "error",
         "error" => %{"code" => "usage_limit_reached", "message" => "secret-original"}
       }}
    )

    assert_receive {:voice_model, ^ref, {:fatal_error, :plan_limit}}, 2_000
  end

  test "429 and provider bodies cannot leak into events or logs" do
    Application.put_env(:salix_voice, :codex_test_status, 429)

    log =
      capture_log(fn ->
        {_pid, ref} = model()
        assert_receive {:voice_model, ^ref, {:fatal_error, :plan_limit}}, 2_000
        refute_receive {:voice_model, ^ref, {:signaled, _}}, 30
      end)

    refute log =~ "secret-original"
  end

  test "Electron admission needs no API key, bridges into the Router Conversation, and closes with captions" do
    alias SalixStore.{S3, Keys, Ids, CasRecord}
    alias SalixVoice.{Settings, TestStubs}
    alias SalixVoice.Carrier.Electron
    start_supervised!(S3.Fake)
    SalixAgent.TestSupport.configure_control_fixtures!()

    overrides = [
      {:salix_im, :agent_delivery_mod, LostNotification},
      {:salix_voice, :profile_decider_mod, TestStubs.ProfileDecider},
      {:salix_voice, :test_pid, self()},
      {:salix_voice, :metering_mod, TestStubs.Metering},
      {:salix_voice, :group_directory_mod, TestStubs.GroupDirectory}
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

    {:ok, _} = Settings.update(%{"enabled" => true, "clear_secrets" => ["openai_api_key"]})
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

    attrs = %{
      carrier: :electron,
      tenant_id: tenant,
      group_id: group,
      connect_id: connect["connect_id"],
      caller: %{"kind" => "comma_user", "value" => "owner"},
      audio_format: :pcm16_24k,
      sdp: "offer-sdp"
    }

    assert {:ok, answer} = Electron.start(attrs)
    assert Map.keys(answer) |> Enum.sort() == [:call_id, :sdp]
    refute inspect(answer) =~ "secret-"
    assert answer.sdp == "answer-sdp"
    assert_receive {:socket, server}, 2_000
    send(server, {:push, %{"type" => "session.started", "session" => %{"id" => "rtc_fixture"}}})
    assert_receive {:sent, %{"type" => "session.context.append"}}, 2_000

    send(
      server,
      {:push,
       %{
         "type" => "turn.done",
         "turn" => %{"role" => "user", "transcript" => "Create a reminder"}
       }}
    )

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_call",
           "content" => [
             %{"type" => "input_text", "text" => "Create a reminder tomorrow at nine"}
           ]
         }
       }}
    )

    {:ok, conversation} = SalixIM.RouterConversationInput.ensure(group)
    messages = wait_messages(group, conversation["conversation_id"], 50, "del_call")

    delegation =
      Enum.find(
        messages,
        &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
            "del_call")
      )

    assert delegation["delivery_filter"]["participant_ids"] == [
             conversation["router_participant_id"]
           ]

    input = delegation["agent_input"]
    assert input["content"] =~ "Create a reminder tomorrow at nine"
    assert input["trusted_origin"]["principal_ref"]["namespace"] == "comma_user"
    assert input["trusted_origin"]["principal_ref"]["subject_id"] == "owner"
    scope = {tenant, group, "owner"}
    assert {:ok, %{events: pending_events}} = Electron.events(answer.call_id, scope, 0)

    assert Enum.filter(pending_events, &(Map.get(&1, :type) == "delegation")) == [
             %{type: "delegation", id: "del_call", status: "pending"}
           ]

    text = String.duplicate("é😀", 180)

    assert {:ok, _} =
             SalixIM.Provider.call_api(router["agent_id"], "voice", "voice.say", %{
               "connect_id" => connect["connect_id"],
               "params" => %{
                 "call_id" => answer.call_id,
                 "delegation_id" => "del_call",
                 "text" => text
               }
             })

    chunks =
      for _ <- 1..3 do
        assert_receive {:sent,
                        %{
                          "type" => "delegation.context.append",
                          "delegation_item_id" => "del_call",
                          "content" => [%{"text" => chunk}]
                        } = event},
                       2_000

        refute Map.has_key?(event, "channel")
        assert byte_size(chunk) <= 500
        chunk
      end

    assert Enum.join(chunks) == text
    scope = {tenant, group, "owner"}

    assert {:error, :call_not_found} =
             Electron.events(answer.call_id, {tenant, group, "other"}, 0)

    assert {:ok, %{events: events}} = Electron.events(answer.call_id, scope, 0)

    assert Enum.any?(
             events,
             &(Map.get(&1, :kind) == "caption" and &1.text == "Create a reminder")
           )

    assert Enum.filter(events, &(Map.get(&1, :type) == "delegation")) == [
             %{type: "delegation", id: "del_call", status: "pending"},
             %{type: "delegation", id: "del_call", status: "answered"}
           ]

    assert {:ok, _} = Electron.hang_up(answer.call_id, scope)
    assert_receive {:sent, %{"type" => "session.close"}}, 2_000
    send(server, {:push, %{"type" => "session.closed"}})
    assert_receive {:metered, %{carrier: "electron", sku: "gpt-live-1-codex"}}, 2_000
    assert {:ok, %{events: events}} = Electron.events(answer.call_id, scope, 0)
    assert Enum.any?(events, &(Map.get(&1, :kind) == "closed"))
    Application.put_env(:salix_voice, :codex_test_selection, {:error, :codex_account_required})
    assert {:error, :codex_account_required} = Electron.start(attrs)
    assert {:error, :not_configured} = SalixVoice.admit(%{attrs | carrier: :websocket})
  end

  test "a push_to_talk Electron call runs with 600s ceiling, skips profile/greeting, delegates to Router, and ingests context" do
    alias SalixVoice.Carrier.Electron
    %{tenant: tenant, group: group, router: router, connect: connect} = ptt_fixture()

    image =
      Base.decode64!(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
      )

    path = "/uploads/abcdefghijklmnopqrstuv-screen.png"
    {:ok, write} = SalixAgent.AgentWorkspace.prepare_write(router["agent_id"], path, image)

    {:ok, :seeded} =
      SalixAgent.AgentWorkspace.seed_operation(router["agent_id"], "ptt-upload", :seeded, [write])

    attrs = %{
      carrier: :electron,
      mode: :push_to_talk,
      tenant_id: tenant,
      group_id: group,
      connect_id: connect["connect_id"],
      caller: %{"kind" => "comma_user", "value" => "owner"},
      audio_format: :pcm16_24k,
      sdp: "offer-sdp"
    }

    scope = {tenant, group, "owner"}
    assert {:ok, answer} = Electron.start(attrs)
    assert_receive {:offer, %{"session" => _session}}, 2_000
    assert {:ok, %{max_duration_s: 600}} = SalixVoice.info(answer.call_id)
    assert_receive {:socket, server}, 2_000

    # Starts without greeting append or waiting for profile resolution
    send(server, {:push, %{"type" => "session.started", "session" => %{"id" => "rtc_fixture"}}})
    refute_received {:profile_decide, _, _, _}

    # Emits voice.call_started to the Router
    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.call_started"}, _, _},
                   2_000

    # Context can be ingested during the call
    context_text = "Foreground app: Safari. Cursor: 100, 200."

    attachments = [
      %{"path" => path, "name" => "screen.png", "mime" => "image/png"}
    ]

    # Unauthorized scope requests fail and do not send context
    assert {:error, :call_not_found} =
             Electron.context(
               answer.call_id,
               {tenant, group, "other"},
               %{context_id: 1, status: :pending}
             )

    assert {:error, :call_not_found} =
             Electron.context(
               answer.call_id,
               {tenant, "other_group", "owner"},
               %{context_id: 1, status: :pending}
             )

    assert {:error, :call_not_found} =
             Electron.context(
               answer.call_id,
               {"other_tenant", group, "owner"},
               %{context_id: 1, status: :pending}
             )

    refute_receive {:sent, %{"type" => "session.context.append"}}, 100

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 1, status: :pending})

    assert_receive {:sent,
                    %{
                      "type" => "session.context.append",
                      "channel" => "commentary",
                      "content" => [%{"type" => "input_text", "text" => pending_append}]
                    }},
                   2_000

    assert String.contains?(pending_append, "[ptt-context:1]")
    assert String.starts_with?(pending_append, "Quiet context, do not speak: ")

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{
               context_id: 1,
               status: :complete,
               text: context_text,
               attachments: attachments
             })

    assert_receive {:sent,
                    %{
                      "type" => "session.context.append",
                      "channel" => "commentary",
                      "content" => [%{"type" => "input_text", "text" => complete_append}]
                    }},
                   2_000

    assert String.contains?(complete_append, context_text)
    assert String.starts_with?(complete_append, "Quiet context, do not speak: ")

    # When delegation happens, pending attachments are passed to Router ingress once
    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_ptt_1",
           "content" => [
             %{"type" => "input_text", "text" => "[ptt-context:1] Look at this screenshot"}
           ]
         }
       }}
    )

    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _source_id,
                    _opts},
                   2_000

    {:ok, conversation} = SalixIM.RouterConversationInput.ensure(group)
    messages = wait_messages(group, conversation["conversation_id"], 50, "del_ptt_1")

    delegation =
      Enum.find(
        messages,
        &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
            "del_ptt_1")
      )

    blocks = Jason.decode!(delegation["agent_input"]["content"])

    assert [
             %{
               "type" => "image",
               "file_ref" => %{"environment_id" => "vfs", "path" => ^path},
               "file_name" => "screen.png",
               "mime_type" => "image/png",
               "size" => size
             }
           ] =
             Enum.filter(blocks, &(&1["type"] == "image"))

    assert size == byte_size(image)
    assert {:ok, ^image} = SalixAgent.AgentWorkspace.read(router["agent_id"], path)

    # Second delegation does NOT receive the same attachments again
    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_ptt_2",
           "content" => [%{"type" => "input_text", "text" => "[ptt-context:1] Second question"}]
         }
       }}
    )

    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _source_id,
                    _opts2},
                   2_000

    second =
      wait_messages(group, conversation["conversation_id"], 50, "del_ptt_2")
      |> Enum.find(
        &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
            "del_ptt_2")
      )

    refute String.contains?(second["agent_input"]["content"], path)

    [actor] = :pg.get_members(SalixVoice.PG, {:call, answer.call_id})

    assert {:ok, _} =
             GenServer.call(
               actor,
               {:voice_provider, :say,
                %{
                  "group_id" => group,
                  "connect_id" => connect["connect_id"],
                  "delegation_id" => "del_ptt_1",
                  "text" => "I checked the screenshot."
                }}
             )

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_ptt_1",
                      "content" => [
                        %{"type" => "input_text", "text" => "I checked the screenshot."}
                      ]
                    }},
                   2_000

    # End call emits voice.call_ended
    assert {:ok, _} = Electron.hang_up(answer.call_id, scope)
    assert_receive {:sent, %{"type" => "session.close"}}, 2_000
    send(server, {:push, %{"type" => "session.closed"}})

    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.call_ended"} = ended, _,
                    _},
                   2_000

    assert ended["voice_mode"] == "push_to_talk"
    assert ended["voice_pending_delegation_ids"] == ["del_ptt_2"]
  end

  test "push_to_talk correlated context regressions: delegation before upload, invalid/stale markers, superseding gestures, and failure/cancel handling" do
    alias SalixVoice.Carrier.Electron

    previous_timers = Application.get_env(:salix_voice, :timers)

    on_exit(fn ->
      if previous_timers,
        do: Application.put_env(:salix_voice, :timers, previous_timers),
        else: Application.delete_env(:salix_voice, :timers)
    end)

    Application.put_env(
      :salix_voice,
      :timers,
      Map.merge(Map.new(previous_timers || []), %{
        delegation_settle_ms: 10,
        context_timeout_ms: 2_000
      })
    )

    %{tenant: tenant, group: group, router: router, connect: connect} = ptt_fixture()

    image =
      Base.decode64!(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
      )

    path = "/uploads/abcdefghijklmnopqrstuv-regression.png"
    size = byte_size(image)
    {:ok, write} = SalixAgent.AgentWorkspace.prepare_write(router["agent_id"], path, image)

    {:ok, :seeded} =
      SalixAgent.AgentWorkspace.seed_operation(router["agent_id"], "ptt-reg-upload", :seeded, [
        write
      ])

    attrs = %{
      carrier: :electron,
      mode: :push_to_talk,
      tenant_id: tenant,
      group_id: group,
      connect_id: connect["connect_id"],
      caller: %{"kind" => "comma_user", "value" => "owner"},
      audio_format: :pcm16_24k,
      sdp: "offer-sdp"
    }

    scope = {tenant, group, "owner"}
    assert {:ok, answer} = Electron.start(attrs)
    assert_receive {:offer, %{"session" => _session}}, 2_000
    assert_receive {:socket, server}, 2_000

    send(server, {:push, %{"type" => "session.started", "session" => %{"id" => "rtc_reg"}}})

    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.call_started"}, _, _},
                   2_000

    [actor] = :pg.get_members(SalixVoice.PG, {:call, answer.call_id})

    # --- 1. Regression: native delegation BEFORE upload retains delegation then delivers real VFS image ---
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 10, status: :pending})

    assert_receive {:sent,
                    %{
                      "type" => "session.context.append",
                      "content" => [%{"text" => quiet_10}]
                    }},
                   2_000

    assert String.contains?(quiet_10, "[ptt-context:10]")

    # GPT Live sends delegation while upload is still in progress
    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_before_upload",
           "content" => [
             %{
               "type" => "input_text",
               "text" => "[ptt-context:10] Check screenshot before upload"
             }
           ]
         }
       }}
    )

    # Delegation is retained, NOT enqueued to Router yet
    refute_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _, _}, 100

    # Now upload completes and posts context complete
    attachments = [%{"path" => path, "name" => "screen.png", "mime" => "image/png"}]

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{
               context_id: 10,
               status: :complete,
               text: "App: Terminal",
               attachments: attachments
             })

    # Router ingress receives the retained delegation with attachments
    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _source_id,
                    opts},
                   2_000

    assert opts[:trusted_source_text] == "Check screenshot before upload"

    {:ok, conversation} = SalixIM.RouterConversationInput.ensure(group)
    messages = wait_messages(group, conversation["conversation_id"], 50, "del_before_upload")

    del_msg =
      Enum.find(
        messages,
        &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
            "del_before_upload")
      )

    blocks = Jason.decode!(del_msg["agent_input"]["content"])

    assert [
             %{
               "type" => "image",
               "file_ref" => %{"environment_id" => "vfs", "path" => ^path},
               "file_name" => "screen.png",
               "mime_type" => "image/png",
               "size" => ^size
             }
           ] = Enum.filter(blocks, &(&1["type"] == "image"))

    assert {:ok, ^image} = SalixAgent.AgentWorkspace.read(router["agent_id"], path)

    # --- 2. Missing or malformed marker fails closed without Router ingress ---
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 20, status: :pending})

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_missing_marker",
           "content" => [%{"type" => "input_text", "text" => "Request without context marker"}]
         }
       }}
    )

    refute_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _, _}, 100

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_missing_marker"
                    } = missing_response},
                   2_000

    refute Map.has_key?(missing_response, "channel")

    # --- 3. Stale marker fails closed ---
    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_stale_marker",
           "content" => [
             %{"type" => "input_text", "text" => "[ptt-context:15] Stale marker request"}
           ]
         }
       }}
    )

    refute_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _, _}, 100

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_stale_marker"
                    } = stale_response},
                   2_000

    refute Map.has_key?(stale_response, "channel")

    # --- 4. New gesture invalidates older waiting delegations; admitted Router work survives ---
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 30, status: :pending})

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_superseded",
           "content" => [
             %{"type" => "input_text", "text" => "[ptt-context:30] Old gesture request"}
           ]
         }
       }}
    )

    # Next gesture arrives before context 30 completes
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 31, status: :pending})

    # The waiting delegation for context 30 is invalidated with explicit failure
    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_superseded"
                    } = superseded_response},
                   2_000

    refute Map.has_key?(superseded_response, "channel")

    # Context 31 completes
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{
               context_id: 31,
               status: :complete,
               text: "App: Notes",
               attachments: []
             })

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_admitted",
           "content" => [%{"type" => "input_text", "text" => "[ptt-context:31] Valid request"}]
         }
       }}
    )

    # Admitted to Router
    assert_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _, _},
                   2_000

    # Even if another gesture arrives now, the already admitted Router work is preserved
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 32, status: :pending})

    # Provider say for del_admitted succeeds
    assert {:ok, _} =
             GenServer.call(
               actor,
               {:voice_provider, :say,
                %{
                  "group_id" => group,
                  "connect_id" => connect["connect_id"],
                  "delegation_id" => "del_admitted",
                  "text" => "Admitted work finished."
                }}
             )

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_admitted",
                      "content" => [
                        %{"type" => "input_text", "text" => "Admitted work finished."}
                      ]
                    }},
                   2_000

    # --- 5. Context cancellation fails waiting delegation explicitly without Router ingress ---
    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_cancelled",
           "content" => [
             %{"type" => "input_text", "text" => "[ptt-context:32] Cancelled gesture"}
           ]
         }
       }}
    )

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 32, status: :cancelled})

    refute_receive {:ingress, ^group, _content, %{"event_type" => "voice.delegation"}, _, _}, 100

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_cancelled"
                    } = cancelled_response},
                   2_000

    refute Map.has_key?(cancelled_response, "channel")

    # --- 6. Tombstone prevents delayed pending or complete revival ---
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 50, status: :cancelled})

    # Delayed pending for tombstoned context rejects
    assert {:error, :invalid_input} =
             Electron.context(answer.call_id, scope, %{context_id: 50, status: :pending})

    # Delayed complete for tombstoned context rejects
    assert {:error, :invalid_input} =
             Electron.context(answer.call_id, scope, %{
               context_id: 50,
               status: :complete,
               text: "Late text",
               attachments: []
             })

    # Stale lower context rejects
    assert {:error, :invalid_input} =
             Electron.context(answer.call_id, scope, %{context_id: 49, status: :pending})

    # --- 7. Duplicate pending is accepted but does not extend deadline or fail ---
    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 60, status: :pending})

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_context_timeout",
           "content" => [%{"type" => "input_text", "text" => "[ptt-context:60] Wait for print"}]
         }
       }}
    )

    refute_receive {:sent, %{"delegation_item_id" => "del_context_timeout"}}, 1_200

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 60, status: :pending})

    assert_receive {:sent,
                    %{
                      "type" => "delegation.context.append",
                      "delegation_item_id" => "del_context_timeout"
                    } = timeout_response},
                   1_000

    refute Map.has_key?(timeout_response, "channel")

    assert {:error, :invalid_input} =
             Electron.context(answer.call_id, scope, %{
               context_id: 60,
               status: :complete,
               text: "Late screenshot after timeout",
               attachments: attachments
             })

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{context_id: 61, status: :pending})

    assert {:ok, %{accepted: true}} =
             Electron.context(answer.call_id, scope, %{
               context_id: 61,
               status: :complete,
               text: "App: Notes, no screenshot",
               attachments: []
             })

    send(
      server,
      {:push,
       %{
         "type" => "delegation.created",
         "item" => %{
           "target" => "client",
           "id" => "del_after_timeout",
           "content" => [%{"type" => "input_text", "text" => "[ptt-context:61] Current request"}]
         }
       }}
    )

    assert_receive {:ingress, ^group, _content,
                    %{"event_type" => "voice.delegation", "message_id" => "del_after_timeout"},
                    _source_id, _opts},
                   2_000

    current_messages =
      wait_messages(group, conversation["conversation_id"], 50, "del_after_timeout")

    current_message =
      Enum.find(
        current_messages,
        &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
            "del_after_timeout")
      )

    assert String.contains?(current_message["agent_input"]["content"], "Current request")
    refute String.contains?(current_message["agent_input"]["content"], path)

    # Clean up call
    assert {:ok, _} = Electron.hang_up(answer.call_id, scope)
    assert_receive {:sent, %{"type" => "session.close"}}, 2_000
    send(server, {:push, %{"type" => "session.closed"}})
  end

  defp ptt_fixture do
    alias SalixStore.{S3, Ids, Keys, CasRecord}
    alias SalixVoice.{Settings, TestStubs}

    start_supervised!(S3.Fake)
    SalixAgent.TestSupport.configure_control_fixtures!()

    overrides = [
      {:salix_voice, :ingress_mod, ObservedIngress},
      {:salix_voice, :profile_decider_mod, TestStubs.ProfileDecider},
      {:salix_voice, :test_pid, self()},
      {:salix_voice, :metering_mod, TestStubs.Metering},
      {:salix_voice, :group_directory_mod, TestStubs.GroupDirectory},
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

    {:ok, _} = Settings.update(%{"enabled" => true, "clear_secrets" => ["openai_api_key"]})
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
    %{tenant: tenant, group: group, router: router, connect: connect}
  end

  defp wait_messages(group, conversation, remaining, delegation_id) do
    {:ok, messages} = SalixIM.Conversations.list_group_conversation_messages(group, conversation)

    if remaining > 0 and
         not Enum.any?(
           messages,
           &(get_in(&1, ["agent_input", "trusted_origin", "provider_context", "message_id"]) ==
               delegation_id)
         ) do
      Process.sleep(20)
      wait_messages(group, conversation, remaining - 1, delegation_id)
    else
      messages
    end
  end
end
