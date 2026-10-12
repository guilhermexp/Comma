defmodule CommaWeb.ComposioConnectTest do
  use Comma.DataCase, async: false
  alias CommaWeb.ComposioConnect
  alias SalixStore.{ComposioAccess, S3}

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      if get_req_header(conn, "x-api-key") != ["test-project-key"] do
        send_resp(conn, 401, "invalid key")
      else
        case {conn.method, conn.request_path} do
          {"GET", "/api/v3/toolkits"} ->
            json(conn, %{
              "items" => [%{"slug" => "linear", "name" => "Linear"}],
              "next_cursor" => "next"
            })

          {"GET", "/api/v3/auth_configs"} ->
            json(conn, %{"items" => [%{"id" => "auth-test"}]})

          {"POST", "/api/v3/connected_accounts/link"} ->
            {:ok, raw, conn} = read_body(conn)
            body = Jason.decode!(raw)

            id =
              Agent.get_and_update(state, fn s ->
                id = "account-#{map_size(s.accounts) + 1}"

                {id,
                 put_in(s, [:accounts, id], %{
                   "id" => id,
                   "toolkit" => %{"slug" => "linear"},
                   "status" => "ACTIVE",
                   "user_id" => body["user_id"]
                 })}
              end)

            json(conn, %{
              "connected_account_id" => id,
              "redirect_url" => "https://provider.example/authorize"
            })

          {method, "/api/v3/connected_accounts/" <> id} ->
            account = Agent.get(state, & &1.accounts[id])

            if method == "DELETE" do
              Agent.update(state, &%{&1 | deleted: [id | &1.deleted]})
              json(conn, %{})
            else
              json(conn, account)
            end

          _ ->
            send_resp(conn, 404, "")
        end
      end
    end

    defp json(conn, value),
      do:
        conn |> put_resp_content_type("application/json") |> send_resp(200, Jason.encode!(value))
  end

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing_owner = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)

    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :subscription_storage_key},
      {:salix_store, :composio_base_url_override}
    ]

    previous = Enum.map(entries, fn {a, k} -> {a, k, Application.get_env(a, k)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    if Process.whereis(S3.Fake), do: S3.Fake.reset(), else: start_supervised!(S3.Fake)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("p", 32))
    state = start_supervised!({Agent, fn -> %{accounts: %{}, deleted: []} end})

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_store, :composio_base_url_override, "http://127.0.0.1:#{port}")

    {:ok, user} =
      Comma.Accounts.create_user(%{
        "email" => "composio-#{System.unique_integer([:positive])}@comma.test"
      })

    workspace = create_ready_workspace!(user)

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)

      Ecto.Adapters.SQL.Sandbox.stop_owner(billing_owner)
    end)

    %{user: user, w: workspace, provider: state}
  end

  defp command(c, action, params),
    do: ComposioConnect.command(c.user, %{}, c.w["id"], action, params)

  defp post_command(token, workspace, action, params \\ %{}) do
    Plug.Test.conn(
      :post,
      "/v1/comma/workspaces/#{workspace}/composio/#{action}",
      Jason.encode!(params)
    )
    |> Plug.Conn.put_req_header("content-type", "application/json")
    |> Plug.Conn.put_req_header("x-comma-session-transport", "bearer")
    |> Plug.Conn.put_req_header("authorization", "Bearer " <> token)
    |> CommaWeb.Router.call(CommaWeb.Router.init([]))
  end

  test "HTTP commands preserve forbidden and missing workspace semantics", c do
    {:ok, outsider} =
      Comma.Accounts.create_user(%{
        "email" => "outsider-#{System.unique_integer([:positive])}@comma.test"
      })

    {:ok, stranger_session} = Comma.Accounts.create_session(outsider["id"])
    assert post_command(stranger_session["token"], c.w["id"], "grant").status == 403
    {:ok, session} = Comma.Accounts.create_session(c.user["id"])
    assert post_command(session["token"], "wsp_missing", "grant").status == 404
    assert post_command(session["token"], c.w["id"], "unknown").status == 422
  end

  test "HTTP commands retain provisioning retry guidance and unavailable workspace status", c do
    {:ok, session} = Comma.Accounts.create_session(c.user["id"])
    workspace = Comma.Repo.get!(Comma.Data.Workspace, c.w["id"])

    for {status, expected} <- [{"provisioning", 202}, {"suspended", 503}] do
      workspace |> Ecto.Changeset.change(status: status) |> Comma.Repo.update!()
      response = post_command(session["token"], c.w["id"], "grant")
      assert response.status == expected

      if status == "provisioning",
        do: assert(Plug.Conn.get_resp_header(response, "retry-after") != [])
    end
  end

  test "HTTP commands report invalid cursors as a bad request", c do
    {:ok, session} = Comma.Accounts.create_session(c.user["id"])
    assert post_command(session["token"], c.w["id"], "approvals", %{"cursor" => 1}).status == 400
  end

  test "HTTP commands reject replay of a settled decision as a conflict", c do
    {:ok, session} = Comma.Accounts.create_session(c.user["id"])

    {:ok, request} =
      SalixAgent.CapabilityRequests.create_capability_request(%{
        "source_agent_id" => c.w["router_agent_id"],
        "source_session_id" => SalixStore.Ids.new_session_id(),
        "tool_call_id" => "review-#{System.unique_integer([:positive])}",
        "request_type" => "composio_execution",
        "request_payload" => %{"user_id" => c.user["id"]}
      })

    params = %{"request_id" => request["request_id"], "approved" => false}
    assert post_command(session["token"], c.w["id"], "decide", params).status == 200

    assert post_command(session["token"], c.w["id"], "decide", Map.put(params, "approved", true)).status ==
             409

    assert Agent.get(c.provider, & &1.deleted) == []
  end

  test "explicit project mode browses its authenticated catalog with display fields", c do
    assert {:ok, _} = command(c, "project", %{"api_key" => "test-project-key"})

    assert {:ok,
            %{
              "items" => [
                %{
                  "slug" => "linear",
                  "name" => "Linear",
                  "description" => "",
                  "logo" => "https://logos.composio.dev/api/linear"
                }
              ],
              "next_cursor" => "next"
            }} = command(c, "catalog", %{"query" => "Linear"})
  end

  test "project validation is write-only, encrypted, and does not fall back", c do
    assert {:error, :composio_project_validation_failed} =
             command(c, "project", %{"api_key" => "invalid"})

    assert {:ok, %{"status" => "signed_out"}} = ComposioConnect.get(c.user, %{}, c.w["id"])

    assert {:ok, %{"mode" => "project"}} =
             command(c, "project", %{"api_key" => "test-project-key"})

    assert {:ok, public} = ComposioConnect.get(c.user, %{}, c.w["id"])
    refute Jason.encode!(public) =~ "test-project-key"
    refute inspect(S3.Fake.dump()) =~ "test-project-key"

    assert {:ok, %{"api_key" => "test-project-key"}} =
             ComposioAccess.project_settings(
               c.w["salix_tenant_id"],
               c.w["default_group_id"],
               c.user["id"]
             )
  end

  test "two accounts verify separately and disconnect affects only the selected account", c do
    native = %{
      "tenant" => c.w["salix_tenant_id"],
      "provider" => "linear",
      "access_token" => "native-fixture-token"
    }

    assert :ok = SalixStore.OAuth.put("native-linear", native)
    {:ok, _} = command(c, "project", %{"api_key" => "test-project-key"})
    {:ok, a} = command(c, "connect", %{"toolkit" => "linear"})
    {:ok, b} = command(c, "connect", %{"toolkit" => "linear"})
    {:ok, initial} = ComposioConnect.get(c.user, %{}, c.w["id"])
    assert Enum.all?(initial["accounts"], &(&1["status"] == "INITIATED"))

    for id <- [a["account_id"], b["account_id"]] do
      assert {:ok, %{"status" => "ACTIVE"}} =
               command(c, "account", %{"operation" => "verify", "account_id" => id})
    end

    assert {:ok, %{"enabled" => false}} =
             command(c, "account", %{"operation" => "disable", "account_id" => a["account_id"]})

    assert Agent.get(c.provider, & &1.deleted) == []

    assert {:ok, _} =
             command(c, "account", %{"operation" => "disconnect", "account_id" => a["account_id"]})

    assert Agent.get(c.provider, & &1.deleted) == [a["account_id"]]
    {:ok, last} = ComposioConnect.get(c.user, %{}, c.w["id"])
    assert Enum.find(last["accounts"], &(&1["id"] == b["account_id"]))["status"] == "ACTIVE"
    assert {:ok, ^native} = SalixStore.OAuth.get("native-linear")
  end

  test "reconnect retires only the selected local account after the new account becomes active",
       c do
    {:ok, _} = command(c, "project", %{"api_key" => "test-project-key"})
    {:ok, a} = command(c, "connect", %{"toolkit" => "linear"})
    {:ok, b} = command(c, "connect", %{"toolkit" => "linear"})

    for link <- [a, b],
        do: command(c, "account", %{"operation" => "verify", "account_id" => link["account_id"]})

    {:ok, replacement} =
      command(c, "account", %{"operation" => "reconnect", "account_id" => a["account_id"]})

    {:ok, before} = ComposioConnect.get(c.user, %{}, c.w["id"])
    assert Enum.find(before["accounts"], &(&1["id"] == a["account_id"]))["enabled"]

    assert {:ok, _} =
             command(c, "account", %{
               "operation" => "verify",
               "account_id" => replacement["account_id"]
             })

    {:ok, after_reconnect} = ComposioConnect.get(c.user, %{}, c.w["id"])
    refute Enum.find(after_reconnect["accounts"], &(&1["id"] == a["account_id"]))["enabled"]
    assert Enum.find(after_reconnect["accounts"], &(&1["id"] == b["account_id"]))["enabled"]
    assert Agent.get(c.provider, & &1.deleted) == []
  end

  test "late account verification after cancel is rejected; another member cannot access it", c do
    {:ok, _} = command(c, "project", %{"api_key" => "test-project-key"})
    {:ok, a} = command(c, "connect", %{"toolkit" => "linear"})

    assert {:ok, _} =
             command(c, "account", %{"operation" => "cancel", "account_id" => a["account_id"]})

    assert {:error, :composio_authorization_cancelled} =
             command(c, "account", %{"operation" => "verify", "account_id" => a["account_id"]})

    assert {:error, :forbidden} = ComposioConnect.get(%{"id" => "foreign"}, %{}, c.w["id"])
  end

  test "OAuth commit rechecks active workspace membership before storing a connection", c do
    auth = %{
      "origin" => "composio_connect",
      "tenant" => c.w["salix_tenant_id"],
      "group_id" => c.w["default_group_id"],
      "composio_user_id" => c.user["id"],
      "comma_operation" => %{
        "kind" => "composio_connect",
        "workspace_id" => c.w["id"],
        "user_id" => c.user["id"]
      }
    }

    assert :ok =
             CommaWeb.OAuthCommit.authorize_composio_member(
               c.w["salix_tenant_id"],
               c.w["default_group_id"],
               c.user["id"]
             )

    assert {:ok, :written} = CommaWeb.OAuthCommit.run(auth, fn -> {:ok, :written} end)

    Repo.update_all(
      from(m in Comma.Data.WorkspaceMembership, where: m.workspace_id == ^c.w["id"]),
      set: [status: "removed"]
    )

    assert {:error, :composio_access_denied} =
             CommaWeb.OAuthCommit.authorize_composio_member(
               c.w["salix_tenant_id"],
               c.w["default_group_id"],
               c.user["id"]
             )

    assert {:error, _} =
             CommaWeb.OAuthCommit.run(auth, fn -> flunk("revoked owner must not commit") end)
  end
end
