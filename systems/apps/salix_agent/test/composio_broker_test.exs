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
    def authorize_member(_, _, _) do
      if Application.get_env(:salix_agent, :composio_member_revoked, false),
        do: {:error, :revoked},
        else: :ok
    end

    def search(_, _, _, _, _, _), do: {:ok, %{"tools" => [], "next_cursor" => nil}}

    def schema(_, _, _, _, tools) do
      if Enum.all?(tools, &(&1 in ~w(GMAIL_FETCH_EMAILS GMAIL_SEND_EMAIL))),
        do: {:ok, %{"tools" => tools}},
        else: {:error, :wrong_toolkit}
    end

    def execute(tenant, group, user, account, tools, authorize_effect) do
      Application.get_env(:salix_agent, :composio_prepare_hook, fn -> :ok end).()

      with :ok <- authorize_effect.() do
        send(
          Application.fetch_env!(:salix_agent, :composio_effect_test_pid),
          {:effect, tenant, group, user, account["id"], tools}
        )

        {:ok, %{"data" => "provider result"}}
      end
    end
  end

  setup do
    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :oauth_store_mod},
      {:salix_agent, :personal_composio_transport},
      {:salix_agent, :composio_effect_test_pid},
      {:salix_agent, :composio_member_revoked},
      {:salix_agent, :composio_prepare_hook}
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
    Application.put_env(:salix_agent, :composio_member_revoked, false)
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
      ComposioAccess.grant(tenant, group, "member", "account-a", ctx.agent_id, true)

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

  test "explicitly shared account metadata and provider results retain the trusted Group audience",
       c do
    ctx = c.ctx |> Map.put(:ifc, %{}) |> Map.put(:group_id, "untrusted-group")
    {:ok, group_label} = SalixIFC.Codec.encode_atom({:group, c.group})

    assert {:tool_ifc, content, [], %{"label" => [^group_label]}} =
             ComposioBroker.accounts(%{}, ctx)

    assert Jason.decode!(content)["accounts"] |> Enum.any?(&(&1["account_id"] == "account-a"))

    assert {:tool_ifc, _, [], %{"label" => [^group_label]}} =
             ComposioBroker.schema(
               %{"account_id" => "account-a", "tool_slugs" => ["GMAIL_FETCH_EMAILS"]},
               ctx
             )

    assert {:tool_ifc, _, [], %{"label" => [^group_label]}} =
             ComposioBroker.search(%{"account_id" => "account-a", "query" => "find email"}, ctx)

    {pending, _} = ComposioBroker.execute(args(), ctx)
    id = Jason.decode!(pending)["request_id"]
    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["ifc"] == %{"label" => [group_label]}
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
               SalixAgent.AsyncToolResults.operation_source(:internal),
               store_result: true
             )

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

    {:ok, _} =
      ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, false)

    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["error"]
    refute_received {:effect, _, _, _, _, _}
  end

  test "grant revocation during provider preparation blocks the actual effect", c do
    id = pending(c)

    Application.put_env(:salix_agent, :composio_prepare_hook, fn ->
      ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, false)
    end)

    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["error"]
    refute_received {:effect, _, _, _, _, _}
  end

  test "membership loss during provider preparation blocks the actual effect", c do
    id = pending(c)

    Application.put_env(:salix_agent, :composio_prepare_hook, fn ->
      Application.put_env(:salix_agent, :composio_member_revoked, true)
    end)

    assert {:ok, done} = decide(c, id, true)
    assert done["result"]["error"]
    refute_received {:effect, _, _, _, _, _}
  end

  test "connected alone reveals no account and grants no schema or execution", c do
    {:ok, _} =
      ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, false)

    assert Jason.decode!(ComposioBroker.accounts(%{}, c.ctx))["accounts"] == []

    assert_raise RuntimeError, fn ->
      ComposioBroker.schema(
        %{"account_id" => "account-a", "tool_slugs" => ["GMAIL_FETCH_EMAILS"]},
        c.ctx
      )
    end

    assert_raise RuntimeError, fn -> ComposioBroker.execute(args(), c.ctx) end
    refute_received {:effect, _, _, _, _, _}
  end

  test "membership loss removes the projection and blocks a previously approved action", c do
    id = pending(c)
    Application.put_env(:salix_agent, :composio_member_revoked, true)
    assert Jason.decode!(ComposioBroker.accounts(%{}, c.ctx))["accounts"] == []

    assert_raise RuntimeError, fn ->
      ComposioBroker.schema(
        %{"account_id" => "account-a", "tool_slugs" => ["GMAIL_FETCH_EMAILS"]},
        c.ctx
      )
    end

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
               "account-a"
             )

    assert {:error, :composio_access_denied} =
             ComposioAccess.authorize(
               c.tenant,
               c.group,
               c.ctx.agent_id,
               "other",
               "account-a"
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
