defmodule CommaWeb.ComposioConnectTest do
  use Comma.DataCase, async: false
  alias CommaWeb.ComposioConnect
  alias SalixStore.{ComposioAccess, S3}

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(%{request_path: "/mcp"} = conn, state) do
      if get_req_header(conn, "authorization") == ["Bearer private-connect-token"] do
        {:ok, raw, conn} = read_body(conn)
        request = Jason.decode!(raw)
        Agent.update(state, &Map.update!(&1, :rpc_requests, fn calls -> [request | calls] end))
        result = Agent.get(state, & &1.connect_result)

        if get_in(request, ["params", "arguments", "toolkits"]) == [
             %{"name" => "gmail", "action" => "list"}
           ] do
          if owner = Agent.get_and_update(state, &Map.pop(&1, :hold_next_list)) do
            send(owner, {:held_account_list, self()})

            receive do
              :release_account_list -> :ok
            after
              5_000 -> raise "account-list fixture was not released"
            end
          end
        end

        json(conn, %{
          "jsonrpc" => "2.0",
          "id" => request["id"],
          "result" => %{
            "isError" => false,
            "content" => [%{"type" => "text", "text" => Jason.encode!(result)}]
          }
        })
      else
        send_resp(conn, 401, "invalid bearer")
      end
    end

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
      {:salix_store, :composio_base_url_override},
      {:salix_web, :composio_connect_endpoint},
      {:salix_mcp, :allow_private_http_targets}
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

  defp connect_fixture(c) do
    tenant = c.w["salix_tenant_id"]
    group = c.w["default_group_id"]
    user = c.user["id"]

    :ok =
      SalixStore.OAuth.put("personal-connect", %{
        "tenant" => tenant,
        "group_id" => group,
        "composio_user_id" => user,
        "credential_protection" => "composio_connect",
        "access_token" => "private-connect-token",
        "expires_at" => System.system_time(:millisecond) + 600_000
      })

    {:ok, _} =
      ComposioAccess.update_profile(tenant, group, user, fn profile ->
        {:ok,
         Map.merge(profile, %{
           "mode" => "connect",
           "status" => "connected",
           "connection_id" => "personal-connect",
           "mcp_session_headers" => %{"mcp-session-id" => "fixture-session"}
         })}
      end)

    # Include a local pending sibling omitted by the provider response.
    siblings =
      for id <- ~w(pending-a pending-b pending-c) do
        {:ok, record} =
          ComposioAccess.put_account(tenant, group, user, id, %{
            "toolkit" => "gmail",
            "status" => "INITIALIZING",
            "mode" => "connect"
          })

        {id, record}
      end

    {:ok, session} = Comma.Accounts.create_session(user)
    %{tenant: tenant, group: group, user: user, siblings: siblings, token: session["token"]}
  end

  defp add_response(c, result) do
    Agent.update(
      c.provider,
      &Map.merge(&1, %{
        rpc_requests: [],
        connect_result: %{
          "successful" => true,
          "error" => nil,
          "data" => %{"results" => %{"gmail" => result}}
        }
      })
    )
  end

  defp initiated_result(accounts) do
    %{
      "toolkit" => "gmail",
      "status" => "initiated",
      "redirect_url" => "https://provider.example/authorize?state=private-fixture-state",
      "instruction" => "Complete consent",
      "accounts" => accounts
    }
  end

  defp assert_one_add(c) do
    assert [
             %{
               "method" => "tools/call",
               "params" => %{
                 "name" => "COMPOSIO_MANAGE_CONNECTIONS",
                 "arguments" => %{"toolkits" => [%{"name" => "gmail", "action" => "add"}]}
               }
             }
           ] = Agent.get(c.provider, & &1.rpc_requests)
  end

  @tag :connect_shape
  @tag :account_identity
  test "metadata refresh labels duplicate Drive identities without changing account decisions",
       c do
    s = connect_fixture(c)

    originals =
      for {id, status} <- [{"drive-work", "ACTIVE"}, {"drive-other", "CANCELLED"}], into: %{} do
        {:ok, _} =
          ComposioAccess.put_account(s.tenant, s.group, s.user, id, %{
            "toolkit" => "googledrive",
            "mode" => "connect",
            "status" => status,
            "name" => "Googledrive"
          })

        {:ok, record} = ComposioAccess.enable_account(s.tenant, s.group, s.user, id, false)
        {id, record}
      end

    {:ok, attempt} = ComposioAccess.begin_consent(s.tenant, s.group, s.user, "googledrive")

    {:ok, consent} =
      ComposioAccess.finish_consent(
        s.tenant,
        s.group,
        s.user,
        "googledrive",
        attempt["id"],
        "https://provider.example/consent"
      )

    {:ok, _} =
      ComposioAccess.grant(s.tenant, s.group, s.user, "drive-work", c.w["router_agent_id"], [
        "GOOGLEDRIVE_GET_ABOUT"
      ])

    {:ok, grants} = ComposioAccess.grants(s.tenant, s.group, c.w["router_agent_id"])
    {:ok, oauth} = SalixStore.OAuth.get("personal-connect")

    raw =
      for id <- ~w(drive-work drive-other),
          do: %{
            "id" => id,
            "status" => "active",
            "user_info" => %{
              "user" => %{
                "displayName" => "Casey Example",
                "emailAddress" => "casey@example.test",
                "photoLink" => "https://provider.example/private-photo",
                "permissionId" => "private-permission"
              }
            }
          }

    Agent.update(
      c.provider,
      &Map.merge(&1, %{
        rpc_requests: [],
        connect_result: %{
          "successful" => true,
          "data" => %{
            "results" => %{
              "googledrive" => %{
                "accounts" =>
                  raw ++
                    [
                      %{
                        "id" => "drive-no-identity",
                        "status" => "active",
                        "user_info" => %{"user" => false}
                      }
                    ]
              }
            }
          }
        }
      })
    )

    assert {:ok, public} = command(c, "refresh_accounts", %{"toolkit" => "googledrive"})

    for {id, original} <- originals do
      name = "Casey Example <casey@example.test> (#{id})"
      assert Enum.find(public["accounts"], &(&1["id"] == id))["name"] == name
      assert {:ok, stored} = ComposioAccess.account(s.tenant, s.group, s.user, id)
      assert stored == Map.put(original, "name", name)
    end

    assert Enum.find(public["accounts"], &(&1["id"] == "drive-no-identity"))["name"] ==
             "Googledrive"

    for {id, record} <- s.siblings do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    assert {:ok, ^consent} = ComposioAccess.consent(s.tenant, s.group, s.user, "googledrive")
    assert {:ok, ^grants} = ComposioAccess.grants(s.tenant, s.group, c.w["router_agent_id"])
    assert {:ok, ^oauth} = SalixStore.OAuth.get("personal-connect")
    refute inspect(public) =~ "private-photo"
    refute inspect(S3.Fake.dump()) =~ "private-permission"

    label = %{"name" => "Casey Example", "toolkit" => "googledrive", "mode" => "connect"}

    assert {:error, :not_found} =
             ComposioAccess.update_account_name(s.tenant, s.group, s.user, "missing", label)

    assert {:error, :not_found} = ComposioAccess.account(s.tenant, s.group, s.user, "missing")

    assert {:error, :composio_account_not_owned} =
             ComposioAccess.update_account_name(s.tenant, s.group, s.user, "pending-a", label)

    assert {:ok, unchanged} = ComposioAccess.account(s.tenant, s.group, s.user, "pending-a")
    assert {"pending-a", ^unchanged} = List.keyfind(s.siblings, "pending-a", 0)

    assert [
             %{
               "params" => %{
                 "name" => "COMPOSIO_MANAGE_CONNECTIONS",
                 "arguments" => %{"toolkits" => [%{"name" => "googledrive", "action" => "list"}]}
               }
             }
           ] = Agent.get(c.provider, & &1.rpc_requests)
  end

  @tag :connect_shape
  test "Connect HTTP add retains unidentified consent without selecting any pending account", c do
    s = connect_fixture(c)

    result =
      initiated_result([
        %{
          "id" => "pending-a",
          "status" => "initializing",
          "is_default" => false,
          "account_type" => "PRIVATE"
        },
        %{
          "id" => "pending-b",
          "status" => "initializing",
          "is_default" => false,
          "account_type" => "PRIVATE"
        },
        %{
          "id" => "pending-c",
          "status" => "initiated",
          "is_default" => false,
          "account_type" => "PRIVATE"
        }
      ])

    {:ok, oauth_before} = SalixStore.OAuth.get("personal-connect")
    add_response(c, result)
    response = post_command(s.token, c.w["id"], "connect", %{"toolkit" => "gmail"})
    assert response.status == 200
    link = Jason.decode!(response.resp_body)
    refute Map.has_key?(link, "account_id")
    assert is_binary(link["consent_id"])
    assert link["authorization_url"] == result["redirect_url"]
    assert link["status"] == "pending"

    for {id, record} <- s.siblings do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    assert {:ok, ^oauth_before} = SalixStore.OAuth.get("personal-connect")

    assert {:ok, %{"items" => []}} =
             ComposioAccess.grants(s.tenant, s.group, c.w["router_agent_id"])

    assert_one_add(c)
    refute inspect(S3.Fake.dump()) =~ result["redirect_url"]
    {:ok, public} = command(c, "consent", %{"toolkit" => "gmail", "operation" => "get"})
    assert public["consent"]["id"] == link["consent_id"]
    refute inspect(public) =~ result["redirect_url"]

    assert {:ok, reopened} =
             command(c, "consent", %{
               "toolkit" => "gmail",
               "operation" => "reopen",
               "consent_id" => link["consent_id"]
             })

    assert reopened["authorization_url"] == result["redirect_url"]
    assert_one_add(c)
    assert {:error, :composio_consent_pending} = command(c, "connect", %{"toolkit" => "gmail"})
    assert_one_add(c)
  end

  @tag :connect_shape
  test "only an explicit exact ACTIVE account selection completes unidentified consent", c do
    s = connect_fixture(c)

    add_response(
      c,
      initiated_result([
        %{"id" => "pending-a", "status" => "initiated"},
        %{"id" => "pending-b", "status" => "initiated"}
      ])
    )

    assert {:ok, link} = command(c, "connect", %{"toolkit" => "gmail"})
    refute Map.has_key?(link, "account_id")

    params = %{
      "toolkit" => "gmail",
      "operation" => "select",
      "consent_id" => link["consent_id"],
      "account_id" => "pending-b"
    }

    assert {:error, :composio_account_not_active} = command(c, "consent", params)

    for {id, record} <- s.siblings do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    Agent.update(c.provider, fn state ->
      put_in(state, [:connect_result, "data", "results", "gmail", "accounts"], [
        %{"id" => "unselected-active", "status" => "active"},
        %{"id" => "pending-b", "status" => "active"}
      ])
    end)

    assert {:error, :composio_account_not_owned} =
             command(c, "consent", Map.put(params, "account_id", "not-owned"))

    assert {:ok, selected} = command(c, "consent", params)
    assert selected["id"] == "pending-b"
    assert selected["status"] == "ACTIVE"

    for {id, record} <- s.siblings, id != "pending-b" do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    assert {:error, :not_found} =
             ComposioAccess.account(s.tenant, s.group, s.user, "unselected-active")

    assert {:ok, %{"items" => []}} =
             ComposioAccess.grants(s.tenant, s.group, c.w["router_agent_id"])

    assert Enum.count(
             Agent.get(c.provider, & &1.rpc_requests),
             &(get_in(&1, ["params", "arguments", "toolkits"]) == [
                 %{"name" => "gmail", "action" => "add"}
               ])
           ) == 1
  end

  @tag :connect_shape
  test "cancelled unidentified consent cannot select a late active account or change siblings",
       c do
    s = connect_fixture(c)
    add_response(c, initiated_result([]))
    assert {:ok, link} = command(c, "connect", %{"toolkit" => "gmail"})
    params = %{"toolkit" => "gmail", "consent_id" => link["consent_id"]}
    assert {:ok, _} = command(c, "consent", Map.put(params, "operation", "cancel"))

    assert {:error, :composio_attempt_not_pending} =
             command(
               c,
               "consent",
               Map.merge(params, %{"operation" => "select", "account_id" => "pending-c"})
             )

    for {id, record} <- s.siblings do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    assert_one_add(c)
  end

  @tag :connect_shape
  @tag :consent_replay_race
  test "reconnect replay racing settlement reads the saved account without repeating effects",
       c do
    s = connect_fixture(c)
    add_response(c, initiated_result([]))

    assert {:ok, link} =
             command(c, "account", %{"operation" => "reconnect", "account_id" => "pending-a"})

    for {id, record} <- s.siblings do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    Agent.update(c.provider, fn state ->
      put_in(state, [:connect_result, "data", "results", "gmail", "accounts"], [
        %{"id" => "replacement", "status" => "active"}
      ])
    end)

    params = %{
      "toolkit" => "gmail",
      "operation" => "select",
      "consent_id" => link["consent_id"],
      "account_id" => "replacement"
    }

    owner = self()
    Agent.update(c.provider, &Map.put(&1, :hold_next_list, owner))
    replay = Task.async(fn -> post_command(s.token, c.w["id"], "consent", params) end)
    assert_receive {:held_account_list, provider_request}, 2_000

    # The replay has read pending consent but its provider read is still in flight.
    # Another request settles the same selection before that read returns.
    assert {:ok, %{"id" => "replacement"}} = command(c, "consent", params)

    assert {:ok, %{"enabled" => false}} =
             ComposioAccess.account(s.tenant, s.group, s.user, "pending-a")

    for {id, record} <- s.siblings, id != "pending-a" do
      assert {:ok, ^record} = ComposioAccess.account(s.tenant, s.group, s.user, id)
    end

    # A late HTTP replay must not undo a later owner decision.
    assert {:ok, _} = ComposioAccess.enable_account(s.tenant, s.group, s.user, "pending-a", true)

    assert {:ok, _} =
             ComposioAccess.enable_account(s.tenant, s.group, s.user, "replacement", false)

    send(provider_request, :release_account_list)
    response = Task.await(replay, 5_000)
    assert response.status == 200
    assert %{"id" => "replacement", "enabled" => false} = Jason.decode!(response.resp_body)

    requests = Agent.get(c.provider, & &1.rpc_requests)
    assert {:ok, %{"enabled" => false}} = command(c, "consent", params)

    assert {:ok, %{"enabled" => true}} =
             ComposioAccess.account(s.tenant, s.group, s.user, "pending-a")

    assert Agent.get(c.provider, & &1.rpc_requests) == requests
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
