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
      env =
        Map.take(System.get_env(), [
          "COMMA_ENVIRONMENT",
          "COMMA_DESKTOP_LOCAL",
          "COMMA_SUBSYSTEMS"
        ])

      previous = Application.get_all_env(:salix_store)
      subsystems = Application.get_env(:comma, :enabled_subsystems)
      Application.put_env(:comma, :enabled_subsystems, [:salix, :comma_product])
      System.put_env("COMMA_ENVIRONMENT", "local")
      System.put_env("COMMA_DESKTOP_LOCAL", "1")
      System.put_env("COMMA_SUBSYSTEMS", "salix,comma_product")
      Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)
      Application.put_env(:salix_store, :s3_endpoint, cfg.endpoint)

      if Process.whereis(SalixStore.S3.Fake),
        do: SalixStore.S3.Fake.reset(),
        else: start_supervised!(SalixStore.S3.Fake)

      unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
      Ecto.Adapters.SQL.Sandbox.mode(Comma.Repo, :auto)
      Ecto.Adapters.SQL.Sandbox.mode(BillingCore.Repo, :auto)

      on_exit(fn ->
        for key <- ["COMMA_ENVIRONMENT", "COMMA_DESKTOP_LOCAL", "COMMA_SUBSYSTEMS"] do
          if env[key], do: System.put_env(key, env[key]), else: System.delete_env(key)
        end

        for key <- [:s3_backend, :s3_endpoint] do
          if Keyword.has_key?(previous, key),
            do: Application.put_env(:salix_store, key, previous[key]),
            else: Application.delete_env(:salix_store, key)
        end

        Ecto.Adapters.SQL.Sandbox.mode(Comma.Repo, :manual)

        if Process.whereis(BillingCore.Repo),
          do: Ecto.Adapters.SQL.Sandbox.mode(BillingCore.Repo, :manual)

        if subsystems,
          do: Application.put_env(:comma, :enabled_subsystems, subsystems),
          else: Application.delete_env(:comma, :enabled_subsystems)
      end)

      :ok
    end

    test "boot enables missing voice settings and keeps enabling an existing install" do
      for _boot <- 1..2 do
        # The second boot represents an installed backend from before this default.
        SalixStore.S3.delete(SalixStore.Keys.ctl_system_voice())
        assert :ok = Comma.LocalInstall.run()
        assert {:ok, %{"enabled" => true}} = SalixVoice.Settings.get()
        assert {:error, :not_configured} = SalixVoice.readiness()

        assert {:error, :codex_account_required} =
                 SalixVoice.admit(%{
                   carrier: :electron,
                   tenant_id: "desktop-voice-test",
                   sdp: "offer"
                 })
      end
    end

    test "boot preserves an explicit disable" do
      assert {:ok, _} = SalixVoice.Settings.update(%{"enabled" => false})
      assert :ok = Comma.LocalInstall.run()
      assert {:ok, %{"enabled" => false}} = SalixVoice.Settings.get()
      assert {:error, :disabled} = SalixVoice.admit(%{carrier: :electron})
    end

    test "local boot without desktop mode retains disabled defaults" do
      System.delete_env("COMMA_DESKTOP_LOCAL")
      assert :ok = Comma.LocalInstall.run()
      assert {:ok, %{"enabled" => false}} = SalixVoice.Settings.get()
      assert {:error, :not_found} = SalixStore.S3.get(SalixStore.Keys.ctl_system_voice())
      assert {:error, :disabled} = SalixVoice.admit(%{carrier: :electron})
    end
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
