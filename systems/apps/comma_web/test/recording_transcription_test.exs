defmodule CommaWeb.RecordingTranscriptionTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  setup do
    owner = self()
    id = {__MODULE__, make_ref()}

    :ok =
      :telemetry.attach(
        id,
        [:salix, :operation, :stop],
        fn _event, measurements, metadata, _ ->
          if self() == owner and metadata.operation == "meeting_asr" do
            send(owner, {:asr_observed, measurements, metadata})
          end
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(id) end)
  end

  test "streams an uploaded M4A into the shared ASR boundary and returns text with source timing" do
    owner = self()

    result = %{
      transcript: "[00:01] Speaker: 会议开始。",
      duration_seconds: 840,
      chunks: [%{index: 0, offset_seconds: 0, transcript: "[00:01] Speaker: 会议开始。"}]
    }

    request =
      conn(:post, "/v1/comma/me/recordings/transcribe", "M4A fixture")
      |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        transcribe: fn stream, size, filename ->
          send(owner, {:upload, Enum.join(stream), size, filename})
          {:ok, result}
        end
      )

    assert_receive {:upload, "M4A fixture", 11, "recording.m4a"}
    assert response.status == 200
    assert response.resp_body =~ "event: transcription"
    assert response.resp_body =~ Jason.encode!(%{status: "ready", result: result})
    assert_receive {:asr_observed, %{duration: duration}, %{surface: "comma", outcome: "ok"}}
    assert duration >= 0
    refute_receive {:asr_observed, _, _}
  end

  test "accepts a 64 MiB recording and dispatches it to ASR" do
    owner = self()
    size = 64 * 1024 * 1024

    request =
      conn(:post, "/", :binary.copy(<<0>>, size)) |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        transcribe: fn _stream, received, _filename ->
          send(owner, {:dispatched, received})
          {:error, :asr_failed}
        end
      )

    assert response.status == 200
    assert_receive {:dispatched, ^size}
  end

  test "rejects empty and oversized inputs before ASR dispatch" do
    owner = self()

    for {body, status} <- [{"", 400}, {:binary.copy(<<0>>, 64 * 1024 * 1024 + 1), 413}] do
      request = conn(:post, "/", body) |> put_req_header("content-type", "audio/mp4")

      response =
        CommaWeb.RecordingTranscription.call(request,
          transcribe: fn _, _, _ -> send(owner, :unexpected) end
        )

      assert response.status == status
    end

    refute_receive :unexpected
  end

  test "reports missing ASR configuration without claiming a transcript" do
    request = conn(:post, "/", "M4A") |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        transcribe: fn _, _, _ -> {:error, :asr_not_configured} end
      )

    assert response.resp_body =~ "not configured"
    refute response.resp_body =~ ~s("status":"ready")
    assert_receive {:asr_observed, _, %{surface: "comma", outcome: "unavailable"}}
  end

  test "reports the missing local transcription model as its own reason" do
    request = conn(:post, "/", "M4A") |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        transcribe: fn _, _, _ -> {:error, :local_asr_model_not_installed} end
      )

    assert response.resp_body =~
             Jason.encode!(%{status: "error", reason: "local_asr_model_not_installed"})

    assert_receive {:asr_observed, _, %{surface: "comma", outcome: "unavailable"}}
  end

  test "bounds a stalled ASR and terminates the upload worker" do
    owner = self()
    request = conn(:post, "/", "M4A") |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        timeout_ms: 20,
        transcribe: fn _, _, _ ->
          send(owner, {:worker, self()})
          Process.sleep(:infinity)
        end
      )

    assert response.resp_body =~ "timed out"
    assert_receive {:worker, pid}
    refute Process.alive?(pid)
    assert_receive {:asr_observed, _, %{surface: "comma", outcome: "unavailable"}}
  end
end
