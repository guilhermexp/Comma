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
