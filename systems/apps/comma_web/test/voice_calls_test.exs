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
          {:post, base <> "/vc_other/context"},
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

  test "call context validates text and image references before dispatch", c do
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls"

    unknown_mode = request(:post, base, c.token, %{"sdp" => "v=0", "mode" => "karaoke"})
    assert unknown_mode.status == 400
    assert Jason.decode!(unknown_mode.resp_body)["error"] == "invalid_input"

    for body <- [
          %{},
          %{"context_id" => "bad", "status" => "pending"},
          %{"context_id" => 0, "status" => "pending"},
          %{"context_id" => -1, "status" => "pending"},
          %{"context_id" => 9_007_199_254_740_992, "status" => "pending"},
          %{"context_id" => 1, "status" => "unknown"},
          %{"context_id" => 1, "status" => "complete", "text" => "  "},
          %{"context_id" => 1, "status" => "complete", "text" => 42},
          %{"context_id" => 1, "status" => "complete", "text" => String.duplicate("x", 20_001)},
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Screen",
            "attachments" => "not-a-list"
          },
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Screen",
            "attachments" => [
              %{"path" => "/etc/passwd", "name" => "screen.png", "mime" => "image/png"}
            ]
          },
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Screen",
            "attachments" => [%{"path" => "/uploads/screen.png", "mime" => "image/png"}]
          },
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Screen",
            "attachments" => [%{"path" => 42, "name" => "screen.png", "mime" => "image/png"}]
          },
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Screen",
            "attachments" => [
              %{
                "path" => "/uploads/abcdefghijklmnopqrstuv-screen.png",
                "name" => "screen.png",
                "mime" => "image/png",
                "file_id" => "bad_id"
              }
            ]
          }
        ] do
      response = request(:post, base <> "/vc_missing/context", c.token, body)
      assert response.status == 400
      assert Jason.decode!(response.resp_body)["error"] == "invalid_input"
    end

    for body <- [
          %{"context_id" => 1, "status" => "pending"},
          %{"context_id" => 1, "status" => "complete", "text" => "App: Editor; cursor: 20,30"},
          %{
            "context_id" => 1,
            "status" => "complete",
            "text" => "Print: screen.png",
            "attachments" => [
              %{
                "path" => "/uploads/abcdefghijklmnopqrstuv-screen.png",
                "name" => "screen.png",
                "mime" => "image/png"
              }
            ]
          },
          %{"context_id" => 1, "status" => "failed"},
          %{"context_id" => 1, "status" => "cancelled"}
        ] do
      missing = request(:post, base <> "/vc_missing/context", c.token, body)
      assert missing.status == 404
      assert Jason.decode!(missing.resp_body)["error"] == "call_not_found"
      assert get_resp_header(missing, "cache-control") == ["no-store"]
    end
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
    assert request(:post, base <> "/vc_other/context", token, %{"text" => "x"}).status == 403
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
