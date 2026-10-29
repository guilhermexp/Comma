defmodule Comma.LocalInstallTest do
  # async: false — one test changes COMMA_ENVIRONMENT.
  use ExUnit.Case, async: false

  defmodule FakeStorage do
    @moduledoc false
    import Plug.Conn

    def init(test_pid), do: test_pid

    def call(conn, test_pid) do
      send(test_pid, {:storage_request, conn.method, conn.request_path, conn.req_headers})

      case :persistent_term.get({__MODULE__, conn.port}, 200) do
        200 ->
          send_resp(conn, 200, "")

        409 ->
          send_resp(
            conn,
            409,
            "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>"
          )

        403 ->
          send_resp(conn, 403, "<Error><Code>AccessDenied</Code></Error>")
      end
    end
  end

  setup do
    {:ok, server} =
      start_supervised(
        {Bandit, plug: {FakeStorage, self()}, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)

    cfg = %SalixStore.Config{
      endpoint: "http://127.0.0.1:#{port}",
      region: "us-east-1",
      bucket: "comma-local",
      access_key_id: "local-access",
      secret_access_key: "local-secret",
      addressing: :path,
      atomic_operations: :s3
    }

    on_exit(fn -> :persistent_term.erase({FakeStorage, port}) end)
    %{cfg: cfg, port: port}
  end

  test "creates the storage bucket with a signed request", %{cfg: cfg} do
    assert :ok = Comma.LocalInstall.ensure_bucket(cfg)

    assert_received {:storage_request, "PUT", "/comma-local", headers}

    assert {"authorization", "AWS4-HMAC-SHA256 Credential=local-access/" <> _} =
             List.keyfind(headers, "authorization", 0)
  end

  test "accepts a bucket this installation already created", %{cfg: cfg, port: port} do
    :persistent_term.put({FakeStorage, port}, 409)
    assert :ok = Comma.LocalInstall.ensure_bucket(cfg)
  end

  test "fails with the storage error when the bucket cannot be created", %{cfg: cfg, port: port} do
    :persistent_term.put({FakeStorage, port}, 403)

    assert {:error, {:bucket_create_failed, 403, "AccessDenied"}} =
             Comma.LocalInstall.ensure_bucket(cfg)
  end

  test "refuses to run outside the local environment" do
    previous = System.get_env("COMMA_ENVIRONMENT")
    System.put_env("COMMA_ENVIRONMENT", "production")

    try do
      assert_raise RuntimeError, ~r/restricted to COMMA_ENVIRONMENT=local/, fn ->
        Comma.LocalInstall.run()
      end
    after
      if previous,
        do: System.put_env("COMMA_ENVIRONMENT", previous),
        else: System.delete_env("COMMA_ENVIRONMENT")
    end
  end

  describe "desktop voice boot defaults" do
    setup %{cfg: cfg} do
      prefix = "desktop_voice_#{System.unique_integer([:positive])}"

      # A real boot runs migrations on multiple connections. Isolate its
      # databases and VM so it cannot change the suite's schema or app state.
      for {repo, index} <- Enum.with_index([Comma.Repo, BillingCore.Repo, SalixStore.Repo]) do
        config = Keyword.put(repo.config(), :database, "#{prefix}_#{index}")
        :ok = Ecto.Adapters.Postgres.storage_up(config)
        on_exit(fn -> :ok = Ecto.Adapters.Postgres.storage_down(config) end)
      end

      %{boot_prefix: prefix, endpoint: cfg.endpoint}
    end

    test "boot enables missing voice settings and keeps enabling an existing install", context do
      assert [fresh, existing] = voice_boot("missing", context)

      for result <- [fresh, existing] do
        assert result == %{
                 "enabled" => true,
                 "readiness" => "not_configured",
                 "admit" => "not_configured"
               }
      end
    end

    test "boot preserves an explicit disable", context do
      assert [%{"enabled" => false, "readiness" => "disabled", "admit" => "disabled"}] =
               voice_boot("disabled", context)
    end

    test "local boot without desktop mode retains disabled defaults", context do
      assert [
               %{
                 "enabled" => false,
                 "readiness" => "disabled",
                 "admit" => "disabled",
                 "stored" => false
               }
             ] =
               voice_boot("non_desktop", context)
    end
  end

  defp voice_boot(mode, context) do
    {output, status} =
      System.cmd(
        "mix",
        [
          "run",
          "--no-start",
          "--no-compile",
          "apps/comma_core/test/support/local_install_voice_boot.exs",
          mode
        ],
        cd: Path.expand("../../../..", __DIR__),
        env: [
          {"MIX_ENV", "test"},
          {"COMMA_SUBSYSTEMS", "salix,comma_product"},
          {"COMMA_ENVIRONMENT", "local"},
          {"COMMA_DESKTOP_LOCAL", "1"},
          {"VOICE_TEST_DB_PREFIX", context.boot_prefix},
          {"VOICE_TEST_STORAGE_ENDPOINT", context.endpoint}
        ],
        stderr_to_stdout: true
      )

    assert status == 0, output
    [_, result] = Regex.run(~r/^VOICE_BOOT_RESULT=(.+)$/m, output)
    Jason.decode!(result)
  end

  describe "local meeting ASR template" do
    setup do
      previous_backend = Application.get_env(:salix_store, :s3_backend)
      Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)

      if Process.whereis(SalixStore.S3.Fake),
        do: SalixStore.S3.Fake.reset(),
        else: start_supervised!(SalixStore.S3.Fake)

      on_exit(fn ->
        if previous_backend,
          do: Application.put_env(:salix_store, :s3_backend, previous_backend),
          else: Application.delete_env(:salix_store, :s3_backend)
      end)

      :ok
    end

    test "upserts one global template that follows the newest local ASR port" do
      for port <- [41_001, 41_002] do
        assert {:ok, _template} =
                 Comma.LocalInstall.ensure_meeting_asr_template(%{
                   "base_url" => "http://127.0.0.1:#{port}/v1",
                   "api_key" => "token-#{port}"
                 })
      end

      assert [%{"template_id" => "local-meeting-asr"}] =
               Enum.filter(
                 SalixAgent.Templates.list_admin(),
                 &(&1["name"] == "local-meeting-asr")
               )

      assert {:ok, llm} = SalixAgent.Templates.resolve_llm_for_template_ref("local-meeting-asr")
      assert llm["protocol"] == "audio_transcriptions"
      assert llm["base_url"] == "http://127.0.0.1:41002/v1"
      assert llm["api_key"] == "token-41002"
      assert llm["model"] == "parakeet-tdt-0.6b-v3"
    end

    test "creates no template without meetings.local_asr" do
      assert :skip = Comma.LocalInstall.ensure_meeting_asr_template(nil)
      assert {:error, :not_found} = SalixAgent.Templates.get("local-meeting-asr")
    end
  end
end
