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
end
