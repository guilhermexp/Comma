defmodule CommaWeb.VoiceCallsTest do
  use Comma.DataCase, async: false
  import Plug.Conn
  import Plug.Test

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)
    old = Application.get_env(:salix_store, :s3_backend)
    admin = Application.get_env(:comma_web, :api_token)
    Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)
    Application.put_env(:comma_web, :api_token, "voice-test-admin")

    if Process.whereis(SalixStore.S3.Fake),
      do: SalixStore.S3.Fake.reset(),
      else: start_supervised!(SalixStore.S3.Fake)

    on_exit(fn ->
      Ecto.Adapters.SQL.Sandbox.stop_owner(billing)
      Application.put_env(:salix_store, :s3_backend, old)
      Application.put_env(:comma_web, :api_token, admin)
    end)

    {:ok, user} =
      Comma.Accounts.create_user(%{
        "email" => "voice-owner-#{System.unique_integer([:positive])}@comma.test"
      })

    {:ok, outsider} =
      Comma.Accounts.create_user(%{
        "email" => "voice-other-#{System.unique_integer([:positive])}@comma.test"
      })

    {:ok, session} = Comma.Accounts.create_session(user["id"])
    {:ok, other_session} = Comma.Accounts.create_session(outsider["id"])
    workspace = create_ready_workspace!(user)
    %{user: user, token: session["token"], other: other_session["token"], workspace: workspace}
  end

  test "call routes enforce app session and workspace ownership before admission", c do
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls"

    for {method, path} <- [
          {:post, base},
          {:get, base <> "/vc_other/events"},
          {:post, base <> "/vc_other/say"},
          {:delete, base <> "/vc_other"}
        ] do
      assert request(method, path, nil).status == 401
      assert request(method, path, c.other).status == 403
    end

    admitted = request(:post, base, c.token)
    assert admitted.status == 400
    assert Jason.decode!(admitted.resp_body)["error"] == "invalid_input"
    assert get_resp_header(admitted, "cache-control") == ["no-store"]
    assert request(:get, base <> "/vc_missing/events", c.token).status == 404
    assert request(:delete, base <> "/vc_missing", c.token).status == 404
  end

  test "read-aloud calls validate their mode and text before reaching a call", c do
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls"

    unknown_mode = request(:post, base, c.token, %{"sdp" => "v=0", "mode" => "karaoke"})
    assert unknown_mode.status == 400
    assert Jason.decode!(unknown_mode.resp_body)["error"] == "invalid_input"

    for body <- [%{}, %{"text" => "  "}, %{"text" => 42}] do
      response = request(:post, base <> "/vc_missing/say", c.token, body)
      assert response.status == 400
      assert Jason.decode!(response.resp_body)["error"] == "invalid_input"
    end

    missing = request(:post, base <> "/vc_missing/say", c.token, %{"text" => "Olá."})
    assert missing.status == 404
    assert Jason.decode!(missing.resp_body)["error"] == "call_not_found"
    assert get_resp_header(missing, "cache-control") == ["no-store"]
  end

  test "restricted workspace sessions cannot start, read or end calls", c do
    response =
      request(:post, "/v1/comma/admin/users/#{c.user["id"]}/sessions", "voice-test-admin", %{
        "restricted" => true,
        "workspace_id" => c.workspace["id"],
        "budget" => 3,
        "tool_allowlist" => ["echo"]
      })

    assert response.status == 201
    token = Jason.decode!(response.resp_body)["token"]
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls"
    assert request(:post, base, token).status == 403
    assert request(:get, base <> "/vc_other/events", token).status == 403
    assert request(:post, base <> "/vc_other/say", token, %{"text" => "x"}).status == 403
    assert request(:delete, base <> "/vc_other", token).status == 403
  end

  defp request(method, path, token, body \\ %{"sdp" => ""}) do
    conn =
      conn(method, path, Jason.encode!(body))
      |> put_req_header("content-type", "application/json")

    conn = if token, do: put_req_header(conn, "authorization", "Bearer " <> token), else: conn
    CommaWeb.Router.call(conn, CommaWeb.Router.init([]))
  end
end
