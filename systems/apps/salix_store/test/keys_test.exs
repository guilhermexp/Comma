defmodule SalixStore.TriageKeysTest do
  use ExUnit.Case, async: true

  alias SalixStore.{Crypto, TriageKeys}

  test "triage engine state uses a dedicated PostgreSQL address family" do
    logical_namespace = "staging-triage"
    engine_hash = Crypto.hex("engine-v2:" <> logical_namespace)

    assert TriageKeys.ctl_im_triage_buckets_prefix(logical_namespace) ==
             "triage/engine-v2/#{engine_hash}/buckets/"

    for key <- [
          TriageKeys.ctl_im_triage_projection_marker(logical_namespace, "receipt"),
          TriageKeys.ctl_im_triage_bucket_seals_prefix(logical_namespace),
          TriageKeys.ctl_im_triage_ledger_runs_prefix(logical_namespace),
          TriageKeys.ctl_im_triage_replay(logical_namespace, "run"),
          TriageKeys.ctl_im_triage_receipt_recovery_lease(logical_namespace)
        ] do
      assert String.starts_with?(key, "triage/engine-v2/#{engine_hash}/")
    end
  end
end

defmodule SalixStore.VoiceCallKeysTest do
  use ExUnit.Case, async: true

  test "voice call segments have an isolated, validated call prefix" do
    call_id = "vc_" <> String.duplicate("0", 26)

    assert SalixStore.Keys.agent_voice_call_segments_prefix("router", call_id) ==
             "agents/router/voice_calls/76635f#{String.duplicate("30", 26)}/segments/"

    for invalid <- ["", "../other", "vc_invalid", nil] do
      assert_raise ArgumentError, fn ->
        SalixStore.Keys.agent_voice_call_segments_prefix("router", invalid)
      end
    end
  end
end
