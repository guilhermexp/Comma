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

  defmodule HelperServer do
    @moduledoc false
    import Plug.Conn

    def init(response), do: response

    def call(conn, {status, body}) do
      {:ok, _body, conn} = read_body(conn, length: 1_000_000)

      conn
      |> put_resp_content_type("application/json")
      |> send_resp(status, Jason.encode!(body))
    end
  end

  # Runs the SSE route through the real binding and SalixLlm.Transcribe
  # against a local helper that answers with the given status and body.
  defp transcribe_with_helper(status, body) do
    {:ok, server} =
      start_supervised(
        Supervisor.child_spec(
          {Bandit,
           plug: {HelperServer, {status, body}}, ip: {127, 0, 0, 1}, port: 0, startup_log: false},
          id: make_ref()
        )
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

    cfg = %{
      "protocol" => "audio_transcriptions",
      "base_url" => "http://127.0.0.1:#{port}/v1",
      "api_key" => "local-asr-token",
      "model" => "parakeet-tdt-0.6b-v3"
    }

    request = conn(:post, "/", "M4A") |> put_req_header("content-type", "audio/mp4")

    response =
      CommaWeb.RecordingTranscription.call(request,
        transcribe: fn stream, size, filename ->
          Salix.Bindings.AgentAudioTranscriber.transcribe_upload(stream, size, filename,
            config_fun: fn -> {:ok, cfg} end
          )
        end
      )

    [_, data] = Regex.run(~r/event: transcription\ndata: (.+)\n\n/, response.resp_body)
    Jason.decode!(data)
  end

  test "the ready result carries the helper provider, model and fallback" do
    segments = [%{"id" => 0, "start" => 1.0, "end" => 2.0, "text" => "Oi.", "speaker" => "S1"}]

    assert %{"status" => "ready", "result" => result} =
             transcribe_with_helper(200, %{
               "text" => "Oi.",
               "duration" => 2.0,
               "segments" => segments,
               "provider" => "groq",
               "model" => "whisper-large-v3-turbo"
             })

    assert %{
             "transcript" => "[00:00:01] Speaker 1: Oi.",
             "provider" => "groq",
             "model" => "whisper-large-v3-turbo"
           } = result

    refute Map.has_key?(result, "fallback")

    assert %{"status" => "ready", "result" => result} =
             transcribe_with_helper(200, %{
               "text" => "Oi.",
               "duration" => 2.0,
               "segments" => segments,
               "provider" => "local",
               "model" => "parakeet-tdt-0.6b-v3",
               "fallback" => %{"from" => "groq", "reason" => "cloud_timeout"}
             })

    assert %{
             "provider" => "local",
             "model" => "parakeet-tdt-0.6b-v3",
             "fallback" => %{"from" => "groq", "reason" => "cloud_timeout"}
           } = result
  end

  test "reports a cloud provider failure with its reason" do
    assert transcribe_with_helper(502, %{
             "error" => %{
               "code" => "cloud_asr_failed",
               "reason" => "cloud_quota",
               "provider" => "groq",
               "message" => "Quota exhausted."
             }
           }) == %{"status" => "error", "reason" => "cloud_asr_failed:cloud_quota"}

    assert_receive {:asr_observed, _, %{surface: "comma", outcome: "unavailable"}}
  end

  test "reports a cloud provider without prerequisites with its reason" do
    assert transcribe_with_helper(409, %{
             "error" => %{"code" => "cloud_asr_not_ready", "reason" => "diarization_missing"}
           }) == %{"status" => "error", "reason" => "cloud_asr_not_ready:diarization_missing"}

    assert_receive {:asr_observed, _, %{surface: "comma", outcome: "unavailable"}}
  end

  test "keeps the local missing-model reason through the real helper mapping" do
    assert transcribe_with_helper(409, %{
             "error" => %{"code" => "local_asr_model_not_installed", "message" => "Install it."}
           }) == %{"status" => "error", "reason" => "local_asr_model_not_installed"}
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
