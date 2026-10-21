defmodule Salix.Bindings.AgentAudioTranscriberTest do
  use ExUnit.Case, async: true

  alias Salix.Bindings.AgentAudioTranscriber

  defmodule RecordingTranscriber do
    def transcribe_audio_stream_with_metadata(_cfg, stream, size, filename, prompt) do
      received = Enum.reduce(stream, 0, &(byte_size(&1) + &2))
      send(self(), {:transcribed, received, size, filename, prompt})

      {:ok,
       %{
         transcript: "[00:00:01] Speaker: streamed",
         duration_seconds: 11,
         chunks: [
           %{index: 0, offset_seconds: 0, transcript: "[00:00:01] Speaker: streamed"}
         ]
       }}
    end
  end

  test "streams a large normal workspace file into the shared transcriber" do
    size = 11 * 1024 * 1024

    stream_fun = fn %{agent_id: agent_id}, path ->
      send(self(), {:streamed, agent_id, path})

      stream =
        Stream.repeatedly(fn -> :binary.copy(<<0xA5>>, 256 * 1024) end)
        |> Stream.take(44)

      {:ok, stream, size}
    end

    assert {:ok, %{duration_seconds: 11}} =
             AgentAudioTranscriber.transcribe("agent-1", "/meetings/test/audio.ogg",
               config_fun: fn -> {:ok, %{}} end,
               stream_fun: stream_fun,
               transcriber: RecordingTranscriber
             )

    assert_receive {:streamed, "agent-1", "/meetings/test/audio.ogg"}
    assert_receive {:transcribed, ^size, ^size, "audio.ogg", _prompt}
  end

  test "rejects paths outside the normal agent-visible workspace" do
    opts = [config_fun: fn -> {:ok, %{}} end]

    assert {:error, :audio_path_not_absolute} =
             AgentAudioTranscriber.transcribe("agent-1", "relative.ogg", opts)

    assert {:error, :audio_path_not_visible} =
             AgentAudioTranscriber.transcribe(
               "agent-1",
               "/.runtime/compaction-recovery.md",
               opts
             )
  end

  test "recording uploads use the same configured transcription engine and prompt" do
    assert {:ok, %{duration_seconds: 11}} =
             AgentAudioTranscriber.transcribe_upload(["M4A"], 3, "recording.m4a",
               config_fun: fn -> {:ok, %{}} end,
               transcriber: RecordingTranscriber
             )

    assert_receive {:transcribed, 3, 3, "recording.m4a", _prompt}

    assert {:error, :asr_not_configured} =
             AgentAudioTranscriber.transcribe_upload([], 0, "recording.m4a",
               config_fun: fn -> {:error, :asr_not_configured} end
             )
  end

  test "rejects empty, invalid, and oversized streams before provider dispatch" do
    call = fn size ->
      AgentAudioTranscriber.transcribe("agent-1", "/audio.ogg",
        config_fun: fn -> {:ok, %{}} end,
        stream_fun: fn _ctx, _path -> {:ok, [], size} end,
        transcriber: RecordingTranscriber
      )
    end

    assert {:error, :asr_audio_empty} = call.(0)
    assert {:error, :asr_audio_size_invalid} = call.(-1)
    assert {:error, :asr_audio_too_large} = call.(64 * 1024 * 1024 + 1)
    refute_receive {:transcribed, _, _, _, _}

    assert {:ok, _result} = call.(64 * 1024 * 1024)
    assert_receive {:transcribed, 0, 67_108_864, "audio.ogg", _prompt}
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

  defp transcribe_with_helper(status, body) do
    id = make_ref()

    {:ok, server} =
      start_supervised(
        Supervisor.child_spec(
          {Bandit,
           plug: {HelperServer, {status, body}}, ip: {127, 0, 0, 1}, port: 0, startup_log: false},
          id: id
        )
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

    cfg = %{
      "protocol" => "audio_transcriptions",
      "base_url" => "http://127.0.0.1:#{port}/v1",
      "api_key" => "local-asr-token",
      "model" => "parakeet-tdt-0.6b-v3"
    }

    result =
      AgentAudioTranscriber.transcribe_upload(["M4A"], 3, "recording.m4a",
        config_fun: fn -> {:ok, cfg} end
      )

    stop_supervised!(id)
    result
  end

  test "a local ASR server without its model returns the missing-model reason" do
    assert {:error, :local_asr_model_not_installed} =
             transcribe_with_helper(409, %{
               "error" => %{"code" => "local_asr_model_not_installed", "message" => "Install it."}
             })
  end

  test "a cloud provider result keeps its provider, model and fallback" do
    assert {:ok, %{provider: "local", model: "parakeet-tdt-0.6b-v3", fallback: fallback}} =
             transcribe_with_helper(200, %{
               "text" => "Oi.",
               "duration" => 2.0,
               "segments" => [%{"start" => 1.0, "text" => "Oi.", "speaker" => "S1"}],
               "provider" => "local",
               "model" => "parakeet-tdt-0.6b-v3",
               "fallback" => %{"from" => "openai_compatible", "reason" => "cloud_unreachable"}
             })

    assert fallback == %{from: "openai_compatible", reason: "cloud_unreachable"}
  end

  test "cloud provider failures and missing prerequisites return their reasons" do
    assert {:error, {:cloud_asr_failed, "cloud_server_error"}} =
             transcribe_with_helper(502, %{
               "error" => %{
                 "code" => "cloud_asr_failed",
                 "reason" => "cloud_server_error",
                 "provider" => "groq",
                 "message" => "Upstream 503."
               }
             })

    assert {:error, {:cloud_asr_not_ready, "provider_unconfigured"}} =
             transcribe_with_helper(409, %{
               "error" => %{"code" => "cloud_asr_not_ready", "reason" => "provider_unconfigured"}
             })
  end
end
