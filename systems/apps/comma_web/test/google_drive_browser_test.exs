defmodule CommaWeb.GoogleDriveBrowserTest do
  use Comma.DataCase, async: false
  alias SalixStore.{ComposioAccess, S3}

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      {:ok, raw, conn} = read_body(conn)
      request = Jason.decode!(raw)
      Agent.update(state, &Map.update!(&1, :requests, fn calls -> [request | calls] end))
      params = request["params"]
      fixture = Agent.get(state, & &1)

      result =
        case params["name"] do
          "COMPOSIO_MANAGE_CONNECTIONS" ->
            if owner = Agent.get_and_update(state, &Map.pop(&1, :hold)) do
              send(owner, {:held, self()})

              receive do
                :release -> :ok
              after
                5_000 -> raise "fixture hold timed out"
              end
            end

            %{"data" => %{"results" => %{"googledrive" => %{"accounts" => fixture.accounts}}}}

          "COMPOSIO_SEARCH_TOOLS" ->
            %{
              "data" => %{
                "toolkit_connection_statuses" => [],
                "tool_schemas" => %{},
                "session" => %{"id" => "read-session"}
              }
            }

          "COMPOSIO_MULTI_EXECUTE_TOOL" ->
            response =
              fixture[:response] ||
                %{
                  "successful" => true,
                  "data" => %{
                    "files" => fixture.files,
                    "nextPageToken" => fixture.cursor,
                    "incompleteSearch" => fixture.incomplete
                  }
                }

            %{
              "successful" => true,
              "data" => %{
                "results" => [
                  %{"tool_slug" => "GOOGLEDRIVE_FIND_FILE", "index" => 0, "response" => response}
                ]
              }
            }
        end

      conn
      |> put_resp_content_type("application/json")
      |> send_resp(
        200,
        Jason.encode!(%{
          "jsonrpc" => "2.0",
          "id" => request["id"],
          "result" => %{"structuredContent" => result}
        })
      )
    end
  end

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing_owner = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)

    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :subscription_storage_key},
      {:salix_store, :composio_base_url_override},
      {:salix_web, :composio_connect_endpoint},
      {:salix_mcp, :allow_private_http_targets}
    ]

    previous = Enum.map(entries, fn {a, k} -> {a, k, Application.get_env(a, k)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    if Process.whereis(S3.Fake), do: S3.Fake.reset(), else: start_supervised!(S3.Fake)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("p", 32))

    state =
      start_supervised!(
        {Agent,
         fn ->
           %{
             accounts: [],
             requests: [],
             files: [
               %{
                 "id" => "file-1",
                 "name" => "Budget",
                 "mimeType" => "application/pdf",
                 "modifiedTime" => "2026-10-13T10:00:00Z",
                 "webViewLink" => "https://drive.google.com/file/d/file-1/view"
               }
             ],
             cursor: "opaque/+== token",
             incomplete: false
           }
         end}
      )

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    Application.put_env(:salix_store, :composio_base_url_override, "http://127.0.0.1:#{port}")
    Application.put_env(:salix_web, :composio_connect_endpoint, "http://127.0.0.1:#{port}/mcp")
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

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

  setup c do
    tenant = c.w["salix_tenant_id"]
    group = c.w["default_group_id"]
    uid = c.user["id"]

    :ok =
      SalixStore.OAuth.put("drive-connect", %{
        "tenant" => tenant,
        "group_id" => group,
        "composio_user_id" => uid,
        "credential_protection" => "composio_connect",
        "access_token" => "private-connect-token",
        "expires_at" => System.system_time(:millisecond) + 600_000
      })

    {:ok, _} =
      ComposioAccess.update_profile(tenant, group, uid, fn profile ->
        {:ok,
         Map.merge(profile, %{
           "mode" => "connect",
           "status" => "connected",
           "connection_id" => "drive-connect",
           "mcp_session_headers" => %{"mcp-session-id" => "fixture-session"}
         })}
      end)

    {:ok, _} =
      ComposioAccess.put_account(tenant, group, uid, "owned", %{
        "toolkit" => "googledrive",
        "name" => "Member",
        "status" => "ACTIVE",
        "mode" => "connect"
      })

    Agent.update(c.provider, &%{&1 | accounts: [%{"id" => "owned", "status" => "ACTIVE"}]})
    {:ok, session} = Comma.Accounts.create_session(c.user["id"])
    %{tenant: tenant, group: group, uid: uid, token: session["token"]}
  end

  defp browse(c, params \\ %{}) do
    Plug.Test.conn(
      :post,
      "/v1/comma/workspaces/#{c.w["id"]}/composio/google_drive",
      Jason.encode!(Map.merge(%{"account_id" => "owned", "tab" => "recent"}, params))
    )
    |> Plug.Conn.put_req_header("content-type", "application/json")
    |> Plug.Conn.put_req_header("x-comma-session-transport", "bearer")
    |> Plug.Conn.put_req_header("authorization", "Bearer " <> c.token)
    |> CommaWeb.Router.call(CommaWeb.Router.init([]))
  end

  defp actions(c),
    do:
      Agent.get(c.provider, fn s ->
        Enum.filter(
          s.requests,
          &(get_in(&1, ["params", "name"]) == "COMPOSIO_MULTI_EXECUTE_TOOL")
        )
      end)

  defp arguments(c),
    do:
      actions(c)
      |> hd()
      |> get_in(["params", "arguments", "tools"])
      |> hd()
      |> Map.fetch!("arguments")

  test "authenticated member browses a complete online page without Agent or Routine grants", c do
    conn = browse(c)
    assert conn.status == 200
    page = Jason.decode!(conn.resp_body)

    assert [
             %{
               "id" => "file-1",
               "name" => "Budget",
               "url" => "https://drive.google.com/file/d/file-1/view"
             }
           ] = page["files"]

    assert page["next_cursor"] == "opaque/+== token"
    assert page["incomplete"] == false
    assert {:ok, %{"items" => []}} = ComposioAccess.grants(c.tenant, c.group, "any-agent")
    assert is_nil(Comma.MemberSourceConsents.binding(c.w["id"], c.uid, "googledrive"))
    [action] = actions(c)

    assert [%{"account" => "owned", "tool_slug" => "GOOGLEDRIVE_FIND_FILE"}] =
             get_in(action, ["params", "arguments", "tools"])
  end

  test "root, shared, folder, name escaping and opaque pagination have exact provider semantics",
       c do
    assert browse(c, %{
             "tab" => "my_drive",
             "search" => "Q'\\x",
             "cursor" => "opaque/+== token",
             "sort" => "name"
           }).status == 200

    args = arguments(c)
    assert args["folder_id"] == "root"
    assert args["q"] == "trashed = false and name contains 'Q\\'\\\\x'"
    assert args["pageToken"] == "opaque/+== token"
    assert args["orderBy"] == "name_natural"
    assert args["pageSize"] == 50
    assert browse(c, %{"tab" => "shared"}).status == 200
    assert arguments(c)["q"] == "trashed = false and sharedWithMe = true"
    refute Map.has_key?(arguments(c), "folder_id")
    assert browse(c, %{"tab" => "shared", "folder_id" => "folder-2"}).status == 200
    assert arguments(c)["folder_id"] == "folder-2"
    assert arguments(c)["q"] == "trashed = false"
  end

  test "foreign, disabled, revoked and mode mismatched accounts cannot dispatch file reads", c do
    assert browse(c, %{"account_id" => "foreign"}).status != 200
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    assert browse(c).status != 200
    assert actions(c) == []
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", true)
    Agent.update(c.provider, &%{&1 | accounts: [%{"id" => "owned", "status" => "REVOKED"}]})
    assert browse(c).status != 200
    assert actions(c) == []

    {:ok, _} =
      ComposioAccess.put_account(c.tenant, c.group, c.uid, "owned", %{
        "toolkit" => "googledrive",
        "status" => "ACTIVE",
        "mode" => "project"
      })

    assert browse(c).status != 200
    assert actions(c) == []
  end

  test "revocation during remote account resolution fences the provider effect", c do
    owner = self()
    Agent.update(c.provider, &Map.put(&1, :hold, owner))
    task = Task.async(fn -> browse(c) end)
    assert_receive {:held, pid}, 5_000
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    send(pid, :release)
    assert Task.await(task).status != 200
    assert actions(c) == []
  end

  test "incomplete is visible; failed and preview-only envelopes are never empty success", c do
    Agent.update(c.provider, &%{&1 | incomplete: true})
    conn = browse(c)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["incomplete"] == true

    for response <- [
          %{"successful" => false, "error" => "denied"},
          %{"successful" => true, "data_preview" => %{"files" => []}},
          %{"successful" => true, "data" => %{}}
        ] do
      Agent.update(c.provider, &Map.put(&1, :response, response))
      assert browse(c).status != 200
    end
  end

  test "invalid inputs do not dispatch; unsafe URLs cannot become opening destinations", c do
    for params <- [
          %{"search" => String.duplicate("x", 513)},
          %{"folder_id" => "x' or true"},
          %{"sort" => "raw"},
          %{"cursor" => String.duplicate("x", 8193)},
          %{"url" => "https://evil.test"}
        ] do
      assert browse(c, params).status != 200
    end

    assert actions(c) == []

    for url <- [
          "https://drive.google.com.evil.test/file/d/file-1/view",
          "javascript:alert(1)",
          "https://user@docs.google.com/document/d/file-1/edit",
          "https://docs.google.com:444/document/d/file-1/edit"
        ] do
      Agent.update(
        c.provider,
        &%{
          &1
          | files: [
              %{
                "id" => "file-1",
                "name" => "Unsafe",
                "mimeType" => "application/pdf",
                "webViewLink" => url
              }
            ]
        }
      )

      conn = browse(c)
      assert conn.status == 200
      assert hd(Jason.decode!(conn.resp_body)["files"])["url"] == nil
    end
  end
end
