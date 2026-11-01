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

    %{
      user: user,
      token: session["token"],
      other: other_session["token"],
      other_user: outsider,
      workspace: workspace
    }
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
    assert request(:get, base <> "/vc_other/trace", token).status == 403
    assert request(:post, base <> "/vc_other/context", token, %{"text" => "x"}).status == 403
    assert request(:delete, base <> "/vc_other", token).status == 403
  end

  test "only the recorded caller reads an ended trace with cursor pagination", c do
    call_id = SalixVoice.new_call_id()
    router = c.workspace["router_agent_id"]
    first_id = SalixStore.ULID.generate()
    last_id = SalixStore.ULID.generate(first_id)

    started = %{
      "id" => first_id,
      "type" => "call_started",
      "at" => "2026-01-01T00:00:00Z",
      "t_ms" => 0,
      "tenant_id" => c.workspace["salix_tenant_id"],
      "group_id" => c.workspace["default_group_id"],
      "mode" => "conversation",
      "carrier" => "electron",
      "caller" => %{"kind" => "comma_user", "value" => c.user["id"]}
    }

    ended = %{
      "id" => last_id,
      "type" => "call_ended",
      "at" => "2026-01-01T00:00:01Z",
      "t_ms" => 1000,
      "reason" => "caller_hangup",
      "duration_ms" => 1000
    }

    assert {:ok, cache} = SalixVoice.CallTraceRecords.load(router, call_id)

    assert {:ok, _, _} =
             SalixVoice.CallTraceRecords.append(router, call_id, cache, [started, ended])

    path = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls/#{call_id}/trace"
    response = request(:get, path <> "?limit=1", c.token)
    assert response.status == 200
    assert get_resp_header(response, "cache-control") == ["no-store"]
    page = Jason.decode!(response.resp_body)
    assert page["ended"] == true
    assert page["events"] == [ended]
    assert page["next_before"] == last_id
    previous = request(:get, path <> "?limit=1&before=#{last_id}", c.token)
    assert Jason.decode!(previous.resp_body)["events"] == [started]

    hidden = request(:get, path, c.other)
    assert hidden.status == 404

    for token <- [nil, "invalid-token"] do
      anonymous = request(:get, path, token)
      assert anonymous.status == 404
      assert Jason.decode!(anonymous.resp_body)["error"] == "call_not_found"
      assert get_resp_header(anonymous, "cache-control") == ["no-store"]
    end

    assert Jason.decode!(hidden.resp_body)["error"] == "call_not_found"

    Comma.Repo.insert!(
      Comma.Data.WorkspaceMembership.changeset(%Comma.Data.WorkspaceMembership{}, %{
        workspace_id: c.workspace["id"],
        user_id: c.other_user["id"],
        role: "member",
        status: "active"
      })
    )

    member = request(:get, path, c.other)
    assert member.status == 404
    assert Jason.decode!(member.resp_body)["error"] == "call_not_found"
    assert request(:get, path <> "?before=bad", c.token).status == 404
    assert request(:get, path <> "?before=bad", c.other).status == 404
    assert request(:get, path <> "?before[key]=value", c.token).status == 404

    missing =
      request(:get, "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls/vc_bad/trace", c.token)

    assert missing.status == 404
    assert Jason.decode!(missing.resp_body)["error"] == "call_not_found"
  end

  test "trace responses rejected by CORS are no-store without affecting other routes", c do
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls/vc_missing"

    trace =
      conn(:get, base <> "/trace")
      |> put_req_header("origin", "https://untrusted.example")
      |> CommaWeb.Router.call(CommaWeb.Router.init([]))

    assert trace.status == 403
    assert get_resp_header(trace, "cache-control") == ["no-store"]

    other =
      conn(:get, base <> "/events")
      |> put_req_header("origin", "https://untrusted.example")
      |> CommaWeb.Router.call(CommaWeb.Router.init([]))

    assert other.status == 403
    refute "no-store" in get_resp_header(other, "cache-control")
  end

  test "drain responses for traces are no-store without affecting other routes", c do
    Comma.PodLifecycle.reset_for_test()
    on_exit(fn -> Comma.PodLifecycle.reset_for_test() end)
    Comma.PodLifecycle.begin_drain()
    base = "/v1/comma/workspaces/#{c.workspace["id"]}/voice/calls/vc_missing"
    trace = request(:get, base <> "/trace", nil)
    assert trace.status == 503
    assert get_resp_header(trace, "cache-control") == ["no-store"]
    other = request(:get, base <> "/events", nil)
    assert other.status == 503
    refute "no-store" in get_resp_header(other, "cache-control")
  end

  defp request(method, path, token, body \\ %{"sdp" => ""}) do
    conn =
      conn(method, path, Jason.encode!(body))
      |> put_req_header("content-type", "application/json")

    conn = if token, do: put_req_header(conn, "authorization", "Bearer " <> token), else: conn
    CommaWeb.Router.call(conn, CommaWeb.Router.init([]))
  end
end
