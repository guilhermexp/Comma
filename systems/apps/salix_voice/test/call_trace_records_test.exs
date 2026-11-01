defmodule SalixVoice.CallTraceRecordsTest do
  use ExUnit.Case, async: false

  alias SalixStore.ULID
  alias SalixVoice.CallTraceRecords

  test "records survive reload, deduplicate and page backwards without gaps" do
    agent = "router_#{System.unique_integer([:positive])}"
    call_id = SalixVoice.new_call_id()
    first_id = ULID.generate()
    second_id = ULID.generate(first_id)
    third_id = ULID.generate(second_id)

    first = %{
      "id" => first_id,
      "type" => "call_started",
      "at" => "2026-01-01T00:00:00Z",
      "t_ms" => 0
    }

    second = %{
      "id" => second_id,
      "type" => "caller_turn",
      "at" => "2026-01-01T00:00:01Z",
      "t_ms" => 1
    }

    third = %{
      "id" => third_id,
      "type" => "call_ended",
      "at" => "2026-01-01T00:00:02Z",
      "t_ms" => 2
    }

    assert {:ok, cache} = CallTraceRecords.load(agent, call_id)

    assert {:ok, cache, [:committed, :committed, :committed]} =
             CallTraceRecords.append(agent, call_id, cache, [first, second, third])

    assert {:ok, cache, [:duplicate]} = CallTraceRecords.append(agent, call_id, cache, [second])

    assert {:error, :voice_call_record_conflict} =
             CallTraceRecords.append(agent, call_id, cache, [Map.put(second, "t_ms", 99)])

    assert {:ok, reloaded} = CallTraceRecords.load(agent, call_id)

    assert {:ok, [^second, ^third], true, ^second_id} =
             CallTraceRecords.tail(agent, call_id, reloaded, 2, nil)

    assert {:ok, [^first], false, nil} =
             CallTraceRecords.tail(agent, call_id, reloaded, 2, second_id)
  end

  test "summary remains stable when reading an older page" do
    agent = "router_#{System.unique_integer([:positive])}"
    call_id = SalixVoice.new_call_id()
    id = ULID.generate()
    next_id = ULID.generate(id)

    started = %{
      "id" => id,
      "type" => "call_started",
      "at" => "2026-01-01T00:00:00Z",
      "t_ms" => 0,
      "tenant_id" => "tenant",
      "group_id" => "group",
      "caller" => %{"kind" => "comma_user", "value" => "caller"},
      "mode" => "push_to_talk",
      "carrier" => "electron"
    }

    ended = %{
      "id" => next_id,
      "type" => "call_ended",
      "at" => "2026-01-01T00:00:01Z",
      "t_ms" => 1000,
      "reason" => "caller_hangup",
      "duration_ms" => 1000
    }

    assert {:ok, cache} = CallTraceRecords.load(agent, call_id)
    assert {:ok, _, _} = CallTraceRecords.append(agent, call_id, cache, [started, ended])
    assert {:ok, trace} = CallTraceRecords.read_trace(agent, call_id, limit: 1)
    assert trace["ended"] == true
    assert trace["end_reason"] == "caller_hangup"
    assert trace["duration_ms"] == 1000
    assert trace["has_more"] == true
    assert trace["next_before"] == next_id

    assert {:ok, previous} =
             CallTraceRecords.read_trace(agent, call_id, limit: 1, before: next_id)

    assert previous["events"] == [started]
    assert previous["ended"] == true
    assert previous["caller"] == started["caller"]
  end

  test "limits a requested page to 500 records without losing older records" do
    agent = "router_#{System.unique_integer([:positive])}"
    call_id = SalixVoice.new_call_id()

    {records, _} =
      Enum.map_reduce(0..500, nil, fn n, previous ->
        id = ULID.generate(previous)
        {%{"id" => id, "type" => "caller_turn", "at" => "2026-01-01T00:00:00Z", "t_ms" => n}, id}
      end)

    assert {:ok, cache} = CallTraceRecords.load(agent, call_id)
    assert {:ok, cache, _} = CallTraceRecords.append(agent, call_id, cache, records)
    assert {:ok, page, true, cursor} = CallTraceRecords.tail(agent, call_id, cache, 600, nil)
    assert page == Enum.drop(records, 1)
    assert {:ok, [first], false, nil} = CallTraceRecords.tail(agent, call_id, cache, 500, cursor)
    assert first == hd(records)
  end
end
