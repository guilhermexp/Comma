defmodule SalixAgent.ComposioBrokerTest do
  use ExUnit.Case, async: false
  alias SalixAgent.{CapabilityRequests, ComposioBroker}
  alias SalixStore.{ComposioAccess, Ids, S3}

  defmodule Scope do
    def agent_oauth_context(agent) do
      with {:ok, a} <- SalixAgent.Control.get(agent),
           do: {:ok, %{tenant: a["tenant_id"], group_id: a["group_id"]}}
    end
  end

  defmodule Transport do
    def execute(tenant, group, user, account, tools) do
      send(
        Application.fetch_env!(:salix_agent, :composio_effect_test_pid),
        {:effect, tenant, group, user, account["id"], tools}
      )

      {:ok, %{"data" => "provider result"}}
    end
  end

  setup do
    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :oauth_store_mod},
      {:salix_agent, :personal_composio_transport},
      {:salix_agent, :composio_effect_test_pid}
    ]

    previous = Enum.map(entries, fn {app, key} -> {app, key, Application.get_env(app, key)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)

    case start_supervised(S3.Fake) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> S3.Fake.reset()
    end

    Application.put_env(:salix_agent, :oauth_store_mod, Scope)
    Application.put_env(:salix_agent, :personal_composio_transport, Transport)
    Application.put_env(:salix_agent, :composio_effect_test_pid, self())
    tenant = SalixAgent.TestSupport.new_tenant_id()
    group = Ids.new_group_id(tenant)

    agent =
      SalixAgent.TestSupport.create_control_agent_in_group!(tenant, group, %{
        "role" => "router",
        "runtime_config" => %{"kind" => "internal"}
      })

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)
    end)

    ctx = %{
      agent_id: agent["agent_id"],
      session_id: Ids.new_session_id(),
      tool_call_id: "call-#{System.unique_integer([:positive])}"
    }

    {:ok, _} =
      ComposioAccess.put_account(tenant, group, "member", "account-a", %{
        "mode" => "connect",
        "toolkit" => "gmail",
        "status" => "ACTIVE",
        "name" => "Work"
      })

    {:ok, _} =
      ComposioAccess.grant(tenant, group, "member", "account-a", ctx.agent_id, [
        "GMAIL_FETCH_EMAILS",
        "GMAIL_SEND_EMAIL"
      ])

    %{tenant: tenant, group: group, ctx: ctx}
  end

  defp args,
    do: %{
      "account_id" => "account-a",
      "tools" => [
        %{
          "tool_slug" => "GMAIL_SEND_EMAIL",
          "arguments" => %{"subject" => "exact reviewed subject"}
        }
      ]
    }

  defp pending(c) do
    {content, _} = ComposioBroker.execute(args(), c.ctx)
    Jason.decode!(content)["request_id"]
  end

  defp decide(c, id, approved),
    do: CapabilityRequests.decide_composio(c.group, id, c.tenant, "member", approved)

  test "an exact action waits for the member, executes once, and persists the provider result",
       c do
    id = pending(c)
    refute_received {:effect, _, _, _, _, _}

    assert {:error, :not_found} =
             CapabilityRequests.decide_composio(c.group, id, c.tenant, "other-member", true)

    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["content"] =~ "provider result"
    assert_received {:effect, _, _, "member", "account-a", tools}
    assert tools == args()["tools"]
    assert {:error, {:conflict, :already_settled}} = decide(c, id, true)
    refute_received {:effect, _, _, _, _, _}
  end

  test "personal account data and asynchronous provider results retain a private audience", c do
    ctx = Map.put(c.ctx, :ifc, %{})

    assert {:tool_ifc, content, [], %{"label" => ["agent_private"]}} =
             ComposioBroker.accounts(%{}, ctx)

    assert Jason.decode!(content)["accounts"] |> Enum.any?(&(&1["account_id"] == "account-a"))
    {pending, _} = ComposioBroker.execute(args(), ctx)
    id = Jason.decode!(pending)["request_id"]
    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["ifc"] == %{"label" => ["agent_private"]}
    assert {:ok, recovered} = CapabilityRequests.get(c.group, id, c.tenant)
    assert recovered["result"]["ifc"] == done["result"]["ifc"]

    assert SalixAgent.AsyncToolResults.stored_result(recovered["result"])["ifc"] ==
             done["result"]["ifc"]

    stored =
      done["result"]
      |> Map.put("id", c.ctx.tool_call_id)
      |> Map.put("name", "composio.personal_execute")

    assert {:ok, _} =
             SalixAgent.WorkspaceEvents.commit_result(
               c.ctx.agent_id,
               c.ctx.session_id,
               stored,
               SalixAgent.AsyncToolResults.operation_source(:internal), store_result: true)

    assert {:ok, restored} =
             SalixAgent.Runtime.get_async_tool_setup_result(
               c.ctx.agent_id,
               c.ctx.session_id,
               c.ctx.tool_call_id
             )

    assert restored["ifc"] == done["result"]["ifc"]
  end

  test "revocation after discovery and approval request blocks dispatch", c do
    id = pending(c)
    {:ok, _} = ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, [])
    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["error"]
    refute_received {:effect, _, _, _, _, _}
  end

  test "a disallowed inner action rejects the entire batch before an effect", c do
    mixed =
      Map.update!(
        args(),
        "tools",
        &(&1 ++ [%{"tool_slug" => "COMPOSIO_REMOTE_BASH_TOOL", "arguments" => %{}}])
      )

    assert_raise RuntimeError, fn -> ComposioBroker.execute(mixed, c.ctx) end
    refute_received {:effect, _, _, _, _, _}
  end

  test "disable and cross-scope account selection cannot reuse a grant", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, "member", "account-a", false)
    assert_raise RuntimeError, fn -> ComposioBroker.execute(args(), c.ctx) end
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, "member", "account-a", true)

    assert {:error, :composio_access_denied} =
             ComposioAccess.authorize(
               c.tenant,
               c.group <> "other",
               c.ctx.agent_id,
               "member",
               "account-a",
               "GMAIL_FETCH_EMAILS"
             )

    assert {:error, :composio_access_denied} =
             ComposioAccess.authorize(
               c.tenant,
               c.group,
               c.ctx.agent_id,
               "other",
               "account-a",
               "GMAIL_FETCH_EMAILS"
             )

    refute_received {:effect, _, _, _, _, _}
  end

  test "denial cannot be turned into approval", c do
    id = pending(c)
    assert {:ok, _} = decide(c, id, false)
    assert {:error, {:conflict, :already_settled}} = decide(c, id, true)
    refute_received {:effect, _, _, _, _, _}
  end
end
