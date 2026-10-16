defmodule CommaWeb.GoogleDriveBrowserTest do
  use Comma.DataCase, async: false
  alias SalixStore.{ComposioAccess, S3}

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(%{request_path: "/api/" <> _} = conn, state) do
      {:ok, raw, conn} = read_body(conn)
      body = if raw == "", do: %{}, else: Jason.decode!(raw)

      Agent.update(
        state,
        &Map.update!(&1, :requests, fn calls ->
          [%{"path" => conn.request_path, "body" => body} | calls]
        end)
      )

      fixture = Agent.get(state, & &1)

      result =
        case conn.request_path do
          "/api/v3/tools" ->
            %{
              "items" => [
                %{"slug" => "GOOGLEDRIVE_FIND_FILE", "toolkit" => %{"slug" => "googledrive"}}
              ],
              "next_cursor" => nil
            }

          "/api/v3/connected_accounts/owned" ->
            %{
              "id" => "owned",
              "status" => "ACTIVE",
              "user_id" => fixture.remote_user,
              "toolkit" => %{"slug" => "googledrive"}
            }

          "/api/v3.1/tool_router/session" ->
            %{"session_id" => "project-session"}

          "/api/v3.1/tool_router/session/project-session/execute" ->
            %{
              "successful" => true,
              "data" => %{
                "files" => fixture.files,
                "nextPageToken" => fixture.cursor,
                "incompleteSearch" => false
              }
            }

          "/api/v3.1/tool_router/session/project-session" ->
            %{}
        end

      conn |> put_resp_content_type("application/json") |> send_resp(200, Jason.encode!(result))
    end

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

            %{
              "data" => %{
                "results" =>
                  Map.get(fixture, :toolkit_accounts, %{
                    "googledrive" => %{"accounts" => fixture.accounts}
                  })
              }
            }

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

  defp reconcile(c, params \\ %{}) do
    Plug.Test.conn(
      :post,
      "/v1/comma/workspaces/#{c.w["id"]}/composio/reconcile_accounts",
      Jason.encode!(params)
    )
    |> Plug.Conn.put_req_header("content-type", "application/json")
    |> Plug.Conn.put_req_header("x-comma-session-transport", "bearer")
    |> Plug.Conn.put_req_header("authorization", "Bearer " <> c.token)
    |> CommaWeb.Router.call(CommaWeb.Router.init([]))
  end

  defp expired_drive_consent(c, baseline) do
    {:ok, started} =
      ComposioAccess.begin_consent(c.tenant, c.group, c.uid, "googledrive", nil, baseline)

    {:ok, _} =
      ComposioAccess.finish_consent(
        c.tenant,
        c.group,
        c.uid,
        "googledrive",
        started["id"],
        "https://provider.example/drive"
      )

    key =
      "ctl/tenants/" <>
        Base.url_encode64(c.tenant, padding: false) <>
        "/composio/groups/" <>
        Base.url_encode64(c.group, padding: false) <>
        "/members/" <>
        Base.url_encode64(c.uid, padding: false) <>
        "/consents/" <> Base.url_encode64("googledrive", padding: false) <> ".json"

    {:ok, %{body: body, etag: etag}} = S3.get(key)

    {:ok, _} =
      S3.put(key, Jason.encode!(Map.put(Jason.decode!(body), "expires_at", 1)), if_match: etag)
  end

  @tag :drive_shared_projection
  test "preserves shared folder metadata for the online card projection", c do
    Agent.update(c.provider, fn state ->
      %{
        state
        | files: [
            %{
              "id" => "team-folder",
              "name" => "Team resources",
              "mimeType" => "application/vnd.google-apps.folder",
              "shared" => true
            }
          ]
      }
    end)

    response = browse(c, %{"tab" => "my_drive"})
    assert response.status == 200

    assert [%{"id" => "team-folder", "shared" => true}] =
             Jason.decode!(response.resp_body)["files"]
  end

  @tag :account_adoption
  test "catalog reconciliation reads its known toolkits in one batch and adopts each without grants",
       c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    Agent.update(
      c.provider,
      &Map.put(&1, :toolkit_accounts, %{
        "googledrive" => %{"accounts" => [%{"id" => "drive-new", "status" => "ACTIVE"}]},
        "gmail" => %{"accounts" => [%{"id" => "mail-new", "status" => "ACTIVE"}]}
      })
    )

    conn = reconcile(c, %{"toolkits" => ["gmail"]})
    assert conn.status == 200
    active = Jason.decode!(conn.resp_body)["accounts"] |> Enum.filter(& &1["enabled"])
    assert Enum.sort(Enum.map(active, & &1["toolkit"])) == ["gmail", "googledrive"]

    assert [%{"params" => %{"name" => "COMPOSIO_MANAGE_CONNECTIONS"}}] =
             Agent.get(c.provider, & &1.requests)

    assert {:ok, %{"items" => []}} =
             ComposioAccess.grants(c.tenant, c.group, c.w["router_agent_id"])
  end

  @tag :account_adoption
  test "list reconciliation finds a remotely connected product source toolkit without consent or catalog visibility",
       c do
    Agent.update(
      c.provider,
      &Map.put(&1, :toolkit_accounts, %{
        "googledrive" => %{"accounts" => []},
        "googlecalendar" => %{"accounts" => [%{"id" => "calendar-remote", "status" => "ACTIVE"}]}
      })
    )

    # The visible catalog page names an unrelated toolkit; no Calendar consent exists.
    conn = reconcile(c, %{"toolkits" => ["airtable"]})
    assert conn.status == 200

    assert Enum.any?(
             Jason.decode!(conn.resp_body)["accounts"],
             &(&1["id"] == "calendar-remote" and &1["toolkit"] == "googlecalendar" and
                 &1["enabled"])
           )

    assert [%{"params" => %{"name" => "COMPOSIO_MANAGE_CONNECTIONS"} = params}] =
             Agent.get(c.provider, & &1.requests)

    assert %{"name" => "googlecalendar", "action" => "list"} in params["arguments"]["toolkits"]

    # Discovery is not sharing: no Agent receives the adopted account.
    assert {:ok, %{"items" => []}} =
             ComposioAccess.grants(c.tenant, c.group, c.w["router_agent_id"])
  end

  @tag :review_regression
  test "catalog adoption keeps a valid toolkit when another toolkit is absent or unsupported",
       c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    Agent.update(
      c.provider,
      &Map.put(&1, :toolkit_accounts, %{
        "googledrive" => %{"accounts" => [%{"id" => "drive-valid", "status" => "ACTIVE"}]}
      })
    )

    conn = reconcile(c, %{"toolkits" => ["gmail"]})
    assert conn.status == 200

    assert Enum.any?(
             Jason.decode!(conn.resp_body)["accounts"],
             &(&1["id"] == "drive-valid" and &1["enabled"])
           )

    assert [%{"params" => %{"name" => "COMPOSIO_MANAGE_CONNECTIONS"}}] =
             Agent.get(c.provider, & &1.requests)

    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "gmail")
    # The same missing result is an error for an explicitly scoped read.
    assert reconcile(c, %{"toolkit" => "gmail"}).status != 200
  end

  @tag :review_regression
  test "a scoped cancelled consent beyond the first page still prevents automatic adoption", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    for i <- 1..60 do
      {:ok, _} = ComposioAccess.begin_consent(c.tenant, c.group, c.uid, "a_toolkit_#{i}")
    end

    {:ok, consent} =
      ComposioAccess.begin_consent(c.tenant, c.group, c.uid, "googledrive", nil, [
        "drive-baseline"
      ])

    {:ok, cancelled} =
      ComposioAccess.cancel_consent(c.tenant, c.group, c.uid, "googledrive", consent["id"])

    {:ok, first_page} = ComposioAccess.consents(c.tenant, c.group, c.uid)
    refute Enum.any?(first_page["items"], &(&1["toolkit"] == "googledrive"))
    assert first_page["next_cursor"]

    Agent.update(
      c.provider,
      &%{&1 | accounts: [%{"id" => "drive-baseline", "status" => "ACTIVE"}]}
    )

    conn = reconcile(c, %{"toolkit" => "googledrive"})
    assert conn.status == 200

    assert {:error, :not_found} =
             ComposioAccess.account(c.tenant, c.group, c.uid, "drive-baseline")

    assert {:ok, ^cancelled} = ComposioAccess.consent(c.tenant, c.group, c.uid, "googledrive")
  end

  @tag :account_adoption
  test "expired consent adopts one of the same-identity baseline Drive accounts and lists real provider-stub files",
       c do
    {:ok, preserved} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    ids = ["googledrive_sandix-pudge", "googledrive_frisky-devout"]
    expired_drive_consent(c, ids)

    accounts =
      Enum.map(
        ids,
        &%{
          "id" => &1,
          "status" => "ACTIVE",
          "user_info" => %{
            "user" => %{"emailAddress" => "member@example.test", "displayName" => "Member"}
          }
        }
      )

    Agent.update(c.provider, &%{&1 | accounts: accounts})
    # The catalog trigger has no toolkit or active consent parameter.
    conn = reconcile(c)
    assert conn.status == 200
    result = Jason.decode!(conn.resp_body)

    connected =
      Enum.filter(
        result["accounts"],
        &(&1["toolkit"] == "googledrive" and &1["status"] == "ACTIVE" and &1["enabled"])
      )

    assert [%{"id" => "googledrive_frisky-devout"}] = connected

    assert {:error, :not_found} =
             ComposioAccess.account(c.tenant, c.group, c.uid, "googledrive_sandix-pudge")

    assert {:ok, ^preserved} = ComposioAccess.account(c.tenant, c.group, c.uid, "owned")

    assert {:ok, %{"items" => []}} =
             ComposioAccess.grants(c.tenant, c.group, c.w["router_agent_id"])

    reads =
      Agent.get(c.provider, & &1.requests)
      |> Enum.filter(&(get_in(&1, ["params", "name"]) == "COMPOSIO_MANAGE_CONNECTIONS"))

    assert length(reads) == 1
    files = browse(c, %{"account_id" => "googledrive_frisky-devout"})
    assert files.status == 200
    assert [%{"name" => "Budget"}] = Jason.decode!(files.resp_body)["files"]
  end

  @tag :account_adoption
  test "automatic discovery preserves explicit disable and does not offer registered accounts as candidates",
       c do
    {:ok, disabled} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    Agent.update(c.provider, &%{&1 | accounts: [%{"id" => "owned", "status" => "ACTIVE"}]})
    conn = reconcile(c, %{"toolkit" => "googledrive"})
    assert conn.status == 200
    assert {:ok, ^disabled} = ComposioAccess.account(c.tenant, c.group, c.uid, "owned")
    assert Jason.decode!(conn.resp_body)["remote_accounts"] == []
    assert Jason.decode!(conn.resp_body)["accounts"] == [Map.drop(disabled, ["user_id"])]
  end

  @tag :account_adoption
  test "absent consent adopts only ACTIVE accounts and preserves an existing connected toolkit",
       c do
    existing = elem(ComposioAccess.account(c.tenant, c.group, c.uid, "owned"), 1)

    Agent.update(
      c.provider,
      &%{
        &1
        | accounts: [
            %{"id" => "owned", "status" => "ACTIVE"},
            %{"id" => "other", "status" => "ACTIVE", "alias" => "other@example.test"}
          ]
      }
    )

    assert reconcile(c, %{"toolkit" => "googledrive"}).status == 200
    assert {:ok, ^existing} = ComposioAccess.account(c.tenant, c.group, c.uid, "owned")
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "other")
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    Agent.update(
      c.provider,
      &%{
        &1
        | accounts: [
            %{"id" => "not-ready", "status" => "INITIATED"},
            %{"id" => "authorized", "status" => "ACTIVE"}
          ]
      }
    )

    conn = reconcile(c)
    assert conn.status == 200

    assert Enum.any?(
             Jason.decode!(conn.resp_body)["accounts"],
             &(&1["id"] == "authorized" and &1["enabled"])
           )

    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "not-ready")
  end

  @tag :account_adoption
  test "different identities remain explicit without a fresh consent and a new account outranks the baseline",
       c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    expired_drive_consent(c, ["first", "second"])

    accounts = [
      %{"id" => "first", "status" => "ACTIVE", "alias" => "one@example.test"},
      %{"id" => "second", "status" => "ACTIVE", "alias" => "two@example.test"}
    ]

    Agent.update(c.provider, &%{&1 | accounts: accounts})
    assert reconcile(c, %{"toolkit" => "googledrive"}).status == 200
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "first")
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "second")

    Agent.update(
      c.provider,
      &%{
        &1
        | accounts:
            accounts ++ [%{"id" => "new", "status" => "ACTIVE", "alias" => "new@example.test"}]
      }
    )

    assert reconcile(c, %{"toolkit" => "googledrive"}).status == 200
    assert {:ok, %{"enabled" => true}} = ComposioAccess.account(c.tenant, c.group, c.uid, "new")
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "new", false)
    Agent.update(c.provider, &%{&1 | accounts: accounts})
    assert reconcile(c, %{"toolkit" => "googledrive", "account_id" => "second"}).status == 200

    assert {:ok, %{"enabled" => true}} =
             ComposioAccess.account(c.tenant, c.group, c.uid, "second")

    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "first")
  end

  @tag :account_adoption
  test "a connected account beyond the first local page blocks adoption even when the provider omits it",
       c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    for number <- 1..55 do
      {:ok, _} =
        ComposioAccess.put_account(c.tenant, c.group, c.uid, "a#{number}", %{
          "mode" => "connect",
          "toolkit" => "gmail",
          "status" => "ACTIVE",
          "name" => "Other toolkit"
        })
    end

    {:ok, existing} =
      ComposioAccess.put_account(c.tenant, c.group, c.uid, "zz-existing", %{
        "mode" => "connect",
        "toolkit" => "googledrive",
        "status" => "ACTIVE",
        "name" => "Existing Drive"
      })

    {:ok, page} = ComposioAccess.accounts(c.tenant, c.group, c.uid)
    refute Enum.any?(page["items"], &(&1["id"] == "zz-existing"))
    Agent.update(c.provider, &%{&1 | accounts: [%{"id" => "new-remote", "status" => "ACTIVE"}]})
    conn = reconcile(c, %{"toolkit" => "googledrive"})
    assert conn.status == 200

    assert Enum.any?(
             Jason.decode!(conn.resp_body)["accounts"],
             &(&1["id"] == "zz-existing" and &1["enabled"])
           )

    assert {:ok, ^existing} = ComposioAccess.account(c.tenant, c.group, c.uid, "zz-existing")
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "new-remote")

    reads =
      Agent.get(c.provider, & &1.requests)
      |> Enum.filter(&(get_in(&1, ["params", "name"]) == "COMPOSIO_MANAGE_CONNECTIONS"))

    assert length(reads) == 1
  end

  @tag :account_adoption
  test "cancel during discovery fences adoption of the late ACTIVE account", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    {:ok, consent} = ComposioAccess.begin_consent(c.tenant, c.group, c.uid, "googledrive")

    {:ok, _} =
      ComposioAccess.finish_consent(
        c.tenant,
        c.group,
        c.uid,
        "googledrive",
        consent["id"],
        "https://provider.example/drive"
      )

    owner = self()

    Agent.update(
      c.provider,
      &Map.merge(&1, %{accounts: [%{"id" => "late", "status" => "ACTIVE"}], hold: owner})
    )

    task = Task.async(fn -> reconcile(c, %{"toolkit" => "googledrive"}) end)
    assert_receive {:held, pid}, 5_000

    {:ok, _} =
      ComposioAccess.cancel_consent(c.tenant, c.group, c.uid, "googledrive", consent["id"])

    send(pid, :release)
    assert Task.await(task).status != 200
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "late")
  end

  @tag :account_adoption
  test "credential authority loss during discovery cannot adopt a remote account", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)

    owner = self()

    Agent.update(
      c.provider,
      &Map.merge(&1, %{accounts: [%{"id" => "late", "status" => "ACTIVE"}], hold: owner})
    )

    task = Task.async(fn -> reconcile(c, %{"toolkit" => "googledrive"}) end)
    assert_receive {:held, pid}, 5_000

    {:ok, _} =
      ComposioAccess.update_profile(
        c.tenant,
        c.group,
        c.uid,
        &{:ok, Map.put(&1, "status", "reauthorization_required")}
      )

    send(pid, :release)
    assert Task.await(task).status != 200
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "late")
  end

  @tag :account_adoption
  test "opaque baseline accounts without identity metadata use a deterministic reference without inventing an identity",
       c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    expired_drive_consent(c, ["drive-z", "drive-a"])

    Agent.update(
      c.provider,
      &%{
        &1
        | accounts: [
            %{"id" => "drive-z", "status" => "ACTIVE"},
            %{"id" => "drive-a", "status" => "ACTIVE"}
          ]
      }
    )

    conn = reconcile(c, %{"toolkit" => "googledrive"})
    assert conn.status == 200
    assert {:ok, selected} = ComposioAccess.account(c.tenant, c.group, c.uid, "drive-a")
    assert selected["enabled"]
    refute Map.has_key?(selected, "email")
    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "drive-z")
  end

  @tag :account_adoption
  test "reopening after an accepted account write settles its exact unfinished consent", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, c.uid, "owned", false)
    {:ok, consent} = ComposioAccess.begin_consent(c.tenant, c.group, c.uid, "googledrive")

    {:ok, _} =
      ComposioAccess.finish_consent(
        c.tenant,
        c.group,
        c.uid,
        "googledrive",
        consent["id"],
        "https://provider.example/drive"
      )

    {:ok, _} =
      ComposioAccess.prepare_adoption_consent(
        c.tenant,
        c.group,
        c.uid,
        "googledrive",
        consent["id"],
        "accepted"
      )

    {:ok, _} =
      ComposioAccess.adopt_account(c.tenant, c.group, c.uid, %{
        "id" => "accepted",
        "toolkit" => "googledrive",
        "mode" => "connect",
        "status" => "ACTIVE",
        "name" => "Member"
      })

    Agent.update(
      c.provider,
      &%{
        &1
        | accounts: [
            %{"id" => "accepted", "status" => "ACTIVE"},
            %{"id" => "other", "status" => "ACTIVE"}
          ]
      }
    )

    assert reconcile(c, %{"toolkit" => "googledrive"}).status == 200

    assert {:ok, %{"status" => "completed", "selected_account_id" => "accepted"}} =
             ComposioAccess.consent(c.tenant, c.group, c.uid, "googledrive")

    assert {:error, :not_found} = ComposioAccess.account(c.tenant, c.group, c.uid, "other")
  end

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

  test "failed inner provider data cannot become a successful file listing", c do
    Agent.update(
      c.provider,
      &Map.put(&1, :response, %{
        "successful" => true,
        "data" => %{"successful" => false, "data" => %{"files" => &1.files}}
      })
    )

    assert browse(c).status != 200
  end

  test "project mode pins the exact member account and a bounded read-only action session", c do
    {:ok, _} =
      ComposioAccess.put_project_settings(c.tenant, c.group, c.uid, %{
        "api_key" => "fixture-project-key"
      })

    {:ok, _} =
      ComposioAccess.put_account(c.tenant, c.group, c.uid, "owned", %{
        "toolkit" => "googledrive",
        "status" => "ACTIVE",
        "mode" => "project"
      })

    {:ok, before_reconciliation} = ComposioAccess.profile(c.tenant, c.group, c.uid)
    assert reconcile(c).status == 200
    assert Agent.get(c.provider, & &1.requests) == []
    assert {:ok, ^before_reconciliation} = ComposioAccess.profile(c.tenant, c.group, c.uid)
    Agent.update(c.provider, &Map.put(&1, :remote_user, "comma:" <> c.group <> ":" <> c.uid))
    conn = browse(c, %{"tab" => "my_drive"})
    assert conn.status == 200
    assert [%{"id" => "file-1"}] = Jason.decode!(conn.resp_body)["files"]
    requests = Agent.get(c.provider, & &1.requests)
    session = Enum.find(requests, &(&1["path"] == "/api/v3.1/tool_router/session"))["body"]
    assert session["connected_accounts"] == %{"googledrive" => ["owned"]}
    assert session["tools"] == %{"googledrive" => %{"enable" => ["GOOGLEDRIVE_FIND_FILE"]}}
    assert session["manage_connections"] == %{"enable" => false}
    assert session["proxy_execute"] == %{"enable" => false}

    action =
      Enum.find(
        requests,
        &(&1["path"] == "/api/v3.1/tool_router/session/project-session/execute")
      )["body"]

    assert action["account"] == "owned"
    assert action["arguments"]["folder_id"] == "root"
    assert actions(c) == []
    Agent.update(c.provider, &%{&1 | remote_user: "foreign", requests: []})
    assert browse(c).status != 200

    refute Enum.any?(
             Agent.get(c.provider, & &1.requests),
             &(&1["path"] == "/api/v3.1/tool_router/session/project-session/execute")
           )
  end

  test "the documented Connect wrapper preserves dates, folders and shortcuts", c do
    Agent.update(
      c.provider,
      &%{
        &1
        | files: [
            %{
              "id" => "folder",
              "name" => "Reports",
              "mimeType" => "application/vnd.google-apps.folder"
            },
            %{
              "id" => "shortcut",
              "name" => "Shortcut",
              "mimeType" => "application/vnd.google-apps.shortcut",
              "shortcutDetails" => %{
                "targetId" => "folder",
                "targetMimeType" => "application/vnd.google-apps.folder"
              }
            },
            %{
              "id" => "doc",
              "name" => "Document",
              "mimeType" => "application/vnd.google-apps.document",
              "modifiedTime" => "2026-10-12T10:00:00Z",
              "viewedByMeTime" => "2026-10-13T11:00:00Z",
              "webViewLink" => "https://docs.google.com/document/d/doc/edit"
            }
          ]
      }
    )

    conn = browse(c)
    assert conn.status == 200
    [folder, shortcut, doc] = Jason.decode!(conn.resp_body)["files"]
    assert folder["mime_type"] == "application/vnd.google-apps.folder"

    assert shortcut["shortcut"] == %{
             "id" => "folder",
             "mime_type" => "application/vnd.google-apps.folder"
           }

    assert doc["viewed_at"] == "2026-10-13T11:00:00Z"
    assert doc["modified_at"] == "2026-10-12T10:00:00Z"
    assert doc["url"] == "https://docs.google.com/document/d/doc/edit"
  end
end
