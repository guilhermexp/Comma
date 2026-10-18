defmodule CommaWeb.LocalAdminLoopbackTest do
  # async: false — the admin token and the environment live in application config.
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  @opts CommaWeb.Router.init([])
  @admin_token "local-admin-token"

  setup do
    owner = CommaWeb.TestRepoSandbox.start_owner!(:transaction)
    previous_api_token = Application.get_env(:comma_web, :api_token)
    previous_environment = Application.get_env(:comma_core, :environment)
    Application.put_env(:comma_web, :api_token, @admin_token)

    on_exit(fn ->
      CommaWeb.TestRepoSandbox.stop_owner(owner)
      restore_env(:comma_web, :api_token, previous_api_token)
      restore_env(:comma_core, :environment, previous_environment)
    end)

    :ok
  end

  defp restore_env(app, key, nil), do: Application.delete_env(app, key)
  defp restore_env(app, key, value), do: Application.put_env(app, key, value)

  defp admin_get(remote_ip) do
    conn(:get, "/v1/comma/admin/users?limit=1")
    |> Map.put(:remote_ip, remote_ip)
    |> put_req_header("authorization", "Bearer #{@admin_token}")
    |> CommaWeb.Router.call(@opts)
  end

  defp admin_create_user(remote_ip) do
    conn(:post, "/v1/comma/admin/users", Jason.encode!(%{"email" => "owner@local.comma"}))
    |> Map.put(:remote_ip, remote_ip)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer #{@admin_token}")
    |> CommaWeb.Router.call(@opts)
  end

  describe "with COMMA_ENVIRONMENT=local" do
    setup do
      Application.put_env(:comma_core, :environment, "local")
      :ok
    end

    test "refuses the admin token from a non-loopback address" do
      for remote_ip <- [{192, 168, 1, 20}, {10, 0, 0, 7}, {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}] do
        conn = admin_get(remote_ip)
        assert conn.status == 403
        assert Jason.decode!(conn.resp_body) == %{"error" => "forbidden"}
      end

      assert admin_create_user({192, 168, 1, 20}).status == 403
    end

    test "accepts the admin token from loopback" do
      for remote_ip <- [
            {127, 0, 0, 1},
            {0, 0, 0, 0, 0, 0, 0, 1},
            {0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 1}
          ] do
        assert admin_get(remote_ip).status == 200
      end
    end
  end

  test "outside the local environment the admin token is not bound to loopback" do
    Application.put_env(:comma_core, :environment, "production")
    assert admin_get({192, 168, 1, 20}).status == 200
  end
end
