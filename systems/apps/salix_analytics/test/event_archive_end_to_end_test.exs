defmodule SalixAnalytics.EventArchiveEndToEndTest do
  @moduledoc """
  The whole path, end to end: a boundary fact goes in, and the `age` CLI reads
  the agent's raw payload back out of the row that lands in the sink.

  This is the test that would catch an archive which is encrypted, well-formed,
  and unopenable by anyone — the failure mode that a write-only pipeline hides
  until the day someone actually needs to read it.
  """

  use ExUnit.Case, async: false

  alias SalixAnalytics.EventArchive
  alias SalixAnalytics.EventArchive.{Completeness, Item, Recipients, Sequence, Worker}
  alias SalixStore.Age

  defmodule CapturingWriter do
    @moduledoc false
    def start, do: Agent.start_link(fn -> [] end, name: __MODULE__)

    def write(rows) do
      Agent.update(__MODULE__, &(&1 ++ rows))
      :ok
    end

    def rows, do: Agent.get(__MODULE__, & &1)
  end

  setup do
    directory =
      Path.join(System.tmp_dir!(), "salix_archive_e2e_#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)

    {recipient, identity} = Age.generate_keypair()

    previous = Application.get_env(:salix_analytics, :event_archive)

    Application.put_env(:salix_analytics, :event_archive,
      enabled: true,
      recipients: [%{key_id: "e2e", public_key: recipient}]
    )

    Recipients.reset()
    Sequence.create_table()
    :ets.delete_all_objects(Sequence)

    start_supervised!({Worker, writer: CapturingWriter, flush_ms: 10_000, batch_size: 1_000})
    CapturingWriter.start()

    on_exit(fn ->
      File.rm_rf(directory)

      if previous,
        do: Application.put_env(:salix_analytics, :event_archive, previous),
        else: Application.delete_env(:salix_analytics, :event_archive)

      Recipients.reset()
    end)

    %{directory: directory, identity: identity, recipient: recipient}
  end

  test "an agent's raw prompt survives the round trip and opens with the age CLI",
       %{directory: directory, identity: identity} do
    secret = "PATIENT RECORD 12345 — do not disclose"

    assert :ok =
             EventArchive.record(%{
               boundary: :llm_request,
               direction: :out,
               payload: %{
                 "messages" => [%{"role" => "user", "content" => secret}],
                 "tool_specs" => [%{"name" => "search"}]
               },
               tenant_id: "tnt_e2e",
               agent_id: "agt_e2e",
               session_id: "ses_e2e",
               round_id: "rnd_1",
               app_revision: "deadbeef",
               ts: "2026-08-25T12:00:00Z"
             })

    Worker.flush()

    [row] = CapturingWriter.rows()

    # The secret must not be recoverable from the row itself — which is what
    # ClickHouse stores, and what anyone with SELECT on the table can read.
    encoded = Jason.encode!(row)
    refute encoded =~ secret
    refute encoded =~ "PATIENT"

    # The header columns must be usable without any key.
    assert row["tenant_id"] == "tnt_e2e"
    assert row["boundary"] == "llm_request"
    assert row["seq"] == 1
    assert row["key_ids"] == ["e2e"]
    assert row["event_date"] == "2026-08-25"
    assert row["writer"] == Sequence.writer()

    # And the payload must open — with our own reader...
    {:ok, parsed_identity} = Age.parse_identity(identity)
    assert {:ok, _header, payload, :verified} = Item.open(row, parsed_identity)
    assert [%{"content" => ^secret}] = payload["messages"]

    # ...and with the real age binary, via the documented one-liner.
    case System.find_executable("age") do
      nil ->
        :ok

      _ ->
        key_path = Path.join(directory, "key.txt")
        File.write!(key_path, identity <> "\n")

        age_file = Base.decode64!(row["e"], padding: false)
        age_path = Path.join(directory, "item.age")
        File.write!(age_path, age_file)

        {output, status} =
          System.cmd("age", ["-d", "-i", key_path, age_path], stderr_to_stdout: true)

        assert status == 0, "age could not open the archived item: #{output}"
        assert output =~ secret
        assert Jason.decode!(output)["p"]["messages"] |> hd() |> Map.get("content") == secret
    end
  end

  test "a full session's boundaries land in one stream with a contiguous run" do
    fact = fn boundary, payload ->
      %{
        boundary: boundary,
        direction: :out,
        payload: payload,
        tenant_id: "tnt_e2e",
        agent_id: "agt_e2e",
        session_id: "ses_run",
        ts: "2026-08-25T12:00:00Z"
      }
    end

    EventArchive.record(fact.(:llm_request, %{"messages" => []}))
    EventArchive.record(fact.(:llm_response, %{"kind" => "assistant"}))
    EventArchive.record(fact.(:tool_call, %{"calls" => [%{"name" => "x"}]}))
    EventArchive.record(fact.(:tool_result, %{"results" => [%{"ok" => true}]}))
    EventArchive.record(fact.(:egress, %{"content" => "done"}))

    Worker.flush()

    rows = CapturingWriter.rows()
    report = Completeness.analyze(rows)

    assert report.items == 5
    assert report.streams == 1
    assert report.runs == 1
    assert report.missing_total == 0
    assert report.findings == []

    boundaries = rows |> Enum.sort_by(& &1["seq"]) |> Enum.map(& &1["boundary"])

    assert boundaries == ["llm_request", "llm_response", "tool_call", "tool_result", "egress"]
  end

  test "voice boundaries seal under both existing streams and open with the call identity", %{
    identity: identity
  } do
    old = Application.get_env(:salix_agent, :event_archive_mod)
    Application.put_env(:salix_agent, :event_archive_mod, EventArchive)

    on_exit(fn ->
      if old,
        do: Application.put_env(:salix_agent, :event_archive_mod, old),
        else: Application.delete_env(:salix_agent, :event_archive_mod)
    end)

    voice = %{
      tenant_id: "tenant_voice",
      agent_id: "agent_router",
      session_id: "vc_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    }

    secret = "private voice fixture"
    assert :ok = SalixAgent.EventArchive.Emit.voice_delivery(voice, %{"speech" => secret})
    assert :ok = SalixAgent.EventArchive.Emit.voice_tool_call(voice, %{"request" => secret})
    assert :ok = SalixAgent.EventArchive.Emit.voice_tool_result(voice, %{"reply" => secret})
    assert :ok = SalixAgent.EventArchive.Emit.voice_egress(voice, %{"speech" => secret})
    Worker.flush()
    rows = Enum.filter(CapturingWriter.rows(), &(&1["session_id"] == voice.session_id))
    assert length(rows) == 4

    assert Enum.map(rows, & &1["stream"]) == [
             "agent:agent_router:inbox",
             "session:#{voice.session_id}:loop",
             "session:#{voice.session_id}:loop",
             "session:#{voice.session_id}:loop"
           ]

    refute Jason.encode!(rows) =~ secret
    assert Enum.all?(rows, &(&1["session_id"] == voice.session_id))
    {:ok, parsed} = Age.parse_identity(identity)

    opened =
      Enum.map(rows, fn row ->
        assert {:ok, _, payload, :verified} = Item.open(row, parsed)
        payload
      end)

    assert opened == [
             %{"speech" => secret},
             %{"request" => secret},
             %{"reply" => secret},
             %{"speech" => secret}
           ]

    session_report =
      rows |> Enum.reject(&(&1["boundary"] == "delivery")) |> Completeness.analyze()

    assert session_report.missing_total == 0
  end

  test "voice emission produces no archive rows when the archive is disabled" do
    previous = Application.fetch_env(:salix_agent, :event_archive_mod)
    Application.put_env(:salix_agent, :event_archive_mod, EventArchive)
    Application.put_env(:salix_analytics, :event_archive, enabled: false, recipients: [])
    Recipients.reset()

    on_exit(fn ->
      case previous do
        {:ok, value} -> Application.put_env(:salix_agent, :event_archive_mod, value)
        :error -> Application.delete_env(:salix_agent, :event_archive_mod)
      end
    end)

    call_id = "vc_disabled_#{System.unique_integer([:positive])}"
    voice = %{tenant_id: "tenant_disabled", agent_id: "agent_disabled", session_id: call_id}
    payload = %{"text" => "private disabled archive fixture"}
    assert :ok = SalixAgent.EventArchive.Emit.voice_delivery(voice, payload)
    assert :ok = SalixAgent.EventArchive.Emit.voice_tool_call(voice, payload)
    assert :ok = SalixAgent.EventArchive.Emit.voice_tool_result(voice, payload)
    assert :ok = SalixAgent.EventArchive.Emit.voice_egress(voice, payload)
    Worker.flush()
    refute Enum.any?(CapturingWriter.rows(), &(&1["session_id"] == call_id))
  end

  test "a live call writes its trace and seals the real voice boundaries", %{identity: identity} do
    old_archive = Application.fetch_env(:salix_agent, :event_archive_mod)
    Application.put_env(:salix_agent, :event_archive_mod, EventArchive)
    tenant = SalixStore.Ids.new_tenant_id()
    group = SalixStore.Ids.new_group_id(tenant)
    router = SalixStore.Ids.new_agent_id(group)
    session = SalixStore.Ids.new_session_id()
    settings_key = SalixStore.Keys.ctl_system_voice()
    old_settings = SalixStore.S3.get(settings_key)

    env = [
      model_mod: SalixVoice.Model.Fake,
      fake_model_observer: self(),
      test_pid: self(),
      test_admission: :ok,
      ingress_mod: SalixVoice.TestStubs.Ingress,
      group_directory_mod: SalixVoice.TestStubs.GroupDirectory,
      metering_mod: SalixVoice.TestStubs.Metering,
      profile_decider_mod: SalixVoice.TestStubs.ProfileDecider,
      test_profile_decision: {:error, "not_configured"},
      test_router_agent_id: router,
      timers: [delegation_settle_ms: 10, model_close_wait_ms: 300]
    ]

    previous = Enum.map(env, fn {key, _} -> {key, Application.fetch_env(:salix_voice, key)} end)
    Enum.each(env, fn {key, value} -> Application.put_env(:salix_voice, key, value) end)

    on_exit(fn ->
      case old_settings do
        {:ok, %{body: body}} -> SalixStore.S3.put(settings_key, body)
        {:error, :not_found} -> SalixStore.S3.delete(settings_key)
      end

      SalixVoice.TestCalls.stop_all()

      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:salix_voice, key, value)
        {key, :error} -> Application.delete_env(:salix_voice, key)
      end)

      case old_archive do
        {:ok, value} -> Application.put_env(:salix_agent, :event_archive_mod, value)
        :error -> Application.delete_env(:salix_agent, :event_archive_mod)
      end
    end)

    {:ok, _} = SalixVoice.Settings.update(%{"enabled" => true, "openai_api_key" => "sk-test"})

    attrs = %{
      carrier: :websocket,
      tenant_id: tenant,
      group_id: group,
      connect_id: "voice-test-connect",
      caller: %{"kind" => "api_key", "value" => "test-caller"},
      carrier_call_id: nil,
      audio_format: :pcmu_8k
    }

    assert {:ok, %{call_id: call_id}} = SalixVoice.admit(attrs)
    assert {:ok, call, info} = SalixVoice.attach(call_id, self())
    assert_receive {:fake_model, model, {:started, _}}, 2_000
    SalixVoice.Model.Fake.emit(model, {:started, "model-test"})
    assert_receive {:ingress, ^group, _, %{"event_type" => "voice.call_started"}, _, _}, 2_000
    secret = "sensitive caller request"
    SalixVoice.Model.Fake.emit(model, {:input_transcript, secret, true, 100})
    SalixVoice.Model.Fake.emit(model, {:delegation, "dlg-archive", 100})
    assert_receive {:ingress, ^group, _, %{"event_type" => "voice.delegation"}, _, _}, 2_000

    assert {:ok, _} =
             GenServer.call(
               call,
               {:voice_provider, :say,
                %{
                  "group_id" => group,
                  "connect_id" => info.connect_id,
                  "agent_id" => router,
                  "session_id" => session,
                  "delegation_id" => "dlg-archive",
                  "text" => "The Router answered"
                }}
             )

    SalixVoice.Model.Fake.emit(model, {:caption, :agent, 1, "interrupted fragment", false})
    SalixVoice.Model.Fake.emit(model, {:caption, :agent, 2, "spoken response", true})
    _ = :sys.get_state(model)
    _ = :sys.get_state(call)
    ref = Process.monitor(call)
    send(call, {:voice_carrier, :hangup, :normal})
    assert_receive {:DOWN, ^ref, :process, ^call, :normal}, 3_000

    assert {:ok, trace} = SalixVoice.CallTraceRecords.read_trace(router, call_id)
    assert trace["ended"]

    assert Enum.any?(
             trace["events"],
             &(&1["type"] == "router_reply" and &1["session_id"] == session)
           )

    Worker.flush()
    rows = Enum.filter(CapturingWriter.rows(), &(&1["session_id"] == call_id))

    assert Enum.all?(
             rows,
             &(&1["tenant_id"] == tenant and &1["agent_id"] == router and
                 &1["session_id"] == call_id)
           )

    refute Jason.encode!(rows) =~ secret

    assert Enum.any?(
             rows,
             &(&1["stream"] == "agent:#{router}:inbox" and &1["boundary"] == "delivery")
           )

    for boundary <- ~w(tool_call tool_result egress),
        do:
          assert(
            Enum.any?(
              rows,
              &(&1["stream"] == "session:#{call_id}:loop" and &1["boundary"] == boundary)
            )
          )

    session_rows = Enum.filter(rows, &(&1["stream"] == "session:#{call_id}:loop"))
    assert Completeness.analyze(session_rows).missing_total == 1

    {:ok, parsed} = Age.parse_identity(identity)

    opened =
      Enum.map(rows, fn row ->
        assert {:ok, _, payload, :verified} = Item.open(row, parsed)
        payload
      end)

    assert Enum.any?(opened, &(Map.get(&1, "text") == secret))
    assert Enum.any?(opened, &(Map.get(&1, "request") == secret))

    assert {:ok, %{call_id: ptt_id}} = SalixVoice.admit(Map.put(attrs, :mode, :push_to_talk))
    assert {:ok, ptt, _} = SalixVoice.attach(ptt_id, self())
    assert_receive {:fake_model, ptt_model, {:started, _}}, 2_000
    SalixVoice.Model.Fake.emit(ptt_model, {:started, "ptt-model"})
    _ = :sys.get_state(ptt_model)
    _ = :sys.get_state(ptt)
    assert {:ok, _} = GenServer.call(ptt, {:context, %{context_id: 42, status: :pending}})

    for event <- [
          {:context_started, 42, 0},
          {:user_turn_started, "turn-A", 1},
          {:delegation, "dlg-delayed", 10, "Inspect the screen", "turn-A"},
          {:user_turn_started, "turn-B", 2}
        ] do
      SalixVoice.Model.Fake.emit(ptt_model, event)
    end

    _ = :sys.get_state(ptt_model)
    _ = :sys.get_state(ptt)

    assert {:ok, _} =
             GenServer.call(
               ptt,
               {:context, %{context_id: 42, status: :complete, text: "Screen", attachments: []}}
             )

    assert_receive {:ingress, ^group, _, %{"event_type" => "voice.delegation"}, _, _}, 2_000
    ptt_ref = Process.monitor(ptt)
    send(ptt, {:voice_carrier, :hangup, :normal})
    assert_receive {:DOWN, ^ptt_ref, :process, ^ptt, :normal}, 3_000

    Worker.flush()

    tool_call =
      CapturingWriter.rows()
      |> Enum.find(&(&1["session_id"] == ptt_id and &1["boundary"] == "tool_call"))

    assert tool_call
    assert {:ok, _, payload, :verified} = Item.open(tool_call, parsed)
    assert payload["native_turn_id"] == "turn-A"
    assert {:ok, ptt_trace} = SalixVoice.CallTraceRecords.read_trace(router, ptt_id)
    requested = Enum.find(ptt_trace["events"], &(&1["type"] == "delegation_requested"))
    assert requested["native_turn_id"] == "turn-A"
  end

  describe "completeness reporting" do
    test "reports a gap with its size and position" do
      rows = for seq <- [1, 2, 5, 6], do: header_row("session:s:loop", seq)

      report = Completeness.analyze(rows)

      assert report.missing_total == 2
      assert [%{kind: :gap, after_seq: 2, before_seq: 5, missing: 2}] = report.findings
    end

    test "reports missing head-of-stream items" do
      rows = for seq <- [4, 5], do: header_row("session:s:loop", seq)
      report = Completeness.analyze(rows)

      assert [%{kind: :gap, after_seq: 0, before_seq: 4, missing: 3}] = report.findings
    end

    test "a restart is an observed second writer, not a guess from a repeated seq 1" do
      # The object-storage version INFERRED a reset from seq 1 appearing twice
      # and then had to excuse the repeated low seqs as a "restart span". With
      # the writer epoch on every row the restart is simply visible, and the
      # heuristic — which hid real duplicates and miscalled restarts that lost
      # their first item — is gone.
      rows =
        for(seq <- [1, 2, 3], do: header_row("session:s:loop", seq, "w-first")) ++
          for seq <- [1, 2], do: header_row("session:s:loop", seq, "w-second")

      report = Completeness.analyze(rows)

      assert [%{kind: :reset, stream: "session:s:loop", writers: 2}] = report.findings
      assert report.runs == 2
      assert report.streams == 1
      assert report.missing_total == 0
    end

    test "a restart that lost its first item is still reported as a gap" do
      # Exactly the case the old heuristic got wrong: seq 1 never lands twice,
      # so it was reported as a plain gap with no indication a node restarted.
      rows =
        for(seq <- [1, 2], do: header_row("session:s:loop", seq, "w-first")) ++
          for seq <- [2, 3], do: header_row("session:s:loop", seq, "w-second")

      report = Completeness.analyze(rows)

      assert Enum.any?(report.findings, &(&1.kind == :reset))

      assert [%{kind: :gap, writer: "w-second", after_seq: 0, before_seq: 2, missing: 1}] =
               Enum.filter(report.findings, &(&1.kind == :gap))
    end

    test "a duplicate inside one run is reported rather than excused" do
      # Under the old restart-span carve-out, a genuine duplicate at a low seq
      # on a stream that had also restarted was silently forgiven.
      rows =
        [header_row("session:s:loop", 1, "w1"), header_row("session:s:loop", 1, "w1")] ++
          [header_row("session:s:loop", 2, "w1")]

      report = Completeness.analyze(rows)

      assert Enum.any?(report.findings, &(&1.kind == :duplicate))
    end

    test "a duplicate names the seq that actually repeats" do
      # The finding used to report `min_seq` — whatever the run happened to
      # start at — so an operator was sent to look at the wrong item.
      rows = [
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 2, "w1"),
        header_row("session:s:loop", 2, "w1")
      ]

      report = Completeness.analyze(rows)

      assert [%{kind: :duplicate, seq: 2, count: 2}] =
               Enum.filter(report.findings, &(&1.kind == :duplicate))
    end

    test "two repeating seqs are two findings, each with its own count" do
      # The old count was `items - distinct + 1` on a single finding, which is
      # only ever right when exactly one seq repeats exactly twice. Here it
      # would have claimed one seq had four copies.
      rows = [
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 2, "w1"),
        header_row("session:s:loop", 2, "w1")
      ]

      report = Completeness.analyze(rows)

      assert [%{seq: 1, count: 3}, %{seq: 2, count: 2}] =
               Enum.filter(report.findings, &(&1.kind == :duplicate))
    end

    test "duplicates are attributed to their own run, not merged across writers" do
      rows = [
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 1, "w1"),
        header_row("session:s:loop", 1, "w2")
      ]

      report = Completeness.analyze(rows)

      assert [%{writer: "w1", seq: 1, count: 2}] =
               Enum.filter(report.findings, &(&1.kind == :duplicate))
    end

    test "analyzes streams independently" do
      rows =
        for(seq <- [1, 2], do: header_row("agent:a:inbox", seq)) ++
          for seq <- [1, 4], do: header_row("session:s:loop", seq)

      report = Completeness.analyze(rows)

      assert report.streams == 2
      assert [%{stream: "session:s:loop", missing: 2}] = report.findings
    end

    test "parses the string-encoded UInt64s ClickHouse returns" do
      # ClickHouse renders UInt64 as a JSON string so values above 2^53 survive
      # the trip. Treating those as integers silently produced empty runs.
      rows = [
        %{"stream" => "s", "writer" => "w", "seq" => "1"},
        %{"stream" => "s", "writer" => "w", "seq" => "3"}
      ]

      report = Completeness.analyze(rows)

      assert report.items == 2
      assert [%{kind: :gap, after_seq: 1, before_seq: 3, missing: 1}] = report.findings
    end
  end

  defp header_row(stream, seq, writer \\ "w1") do
    %{"stream" => stream, "writer" => writer, "seq" => seq, "boundary" => "llm_request"}
  end
end
