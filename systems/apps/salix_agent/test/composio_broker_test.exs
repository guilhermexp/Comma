defmodule SalixAgent.ComposioBrokerTest do
  use ExUnit.Case, async: false
  alias SalixAgent.{CapabilityRequests, ComposioBroker}
  alias SalixStore.{ComposioAccess, Ids, S3}

  defmodule Scope do
    def provider_app(_, _), do: {:error, :not_configured}

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
      Application.get_env(:salix_agent, :composio_schema_hook, fn -> :ok end).()

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

        Application.get_env(
          :salix_agent,
          :composio_effect_result,
          {:ok, %{"data" => "provider result"}}
        )
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
      {:salix_agent, :composio_prepare_hook},
      {:salix_agent, :composio_schema_hook},
      {:salix_agent, :composio_effect_result}
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
          "arguments" => %{"subject" => "fixture subject"}
        }
      ]
    }

  defp denied(args, ctx) do
    assert {:tool_failure, _, "composio_execution_unconfirmed", "user_reportable", _, []} =
             ComposioBroker.execute(args, ctx)

    refute_received {:effect, _, _, _, _, _}
  end

  defp runtime_context(c) do
    ctx =
      c.ctx
      |> Map.merge(%{
        tenant_id: c.tenant,
        group_id: c.group,
        role: "router",
        runtime_kind: :internal
      })
      |> SalixAgent.TestSupport.with_plugin_projection()

    Map.put(
      ctx,
      :tool_disclosure,
      SalixAgent.ToolDisclosure.materialize_static("router", :internal, ctx)
    )
  end

  test "an authorized write returns the provider result through normal tool execution", c do
    [result] =
      SalixAgent.Tools.execute(
        [
          %{id: c.ctx.tool_call_id, name: "composio.personal_execute", args: args()}
        ],
        runtime_context(c)
      )

    refute result.error
    assert Jason.decode!(result.content) == %{"data" => "provider result"}
    assert_received {:effect, _, _, "member", "account-a", tools}
    assert tools == args()["tools"]
    refute_received {:effect, _, _, _, _, _}
  end

  test "account metadata and direct provider results retain the trusted Group audience on recovery",
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

    assert {:tool_ifc, content, [], label} = ComposioBroker.execute(args(), ctx)
    assert label == %{"label" => [group_label]}

    stored = %{
      "id" => ctx.tool_call_id,
      "name" => "composio.personal_execute",
      "content" => content,
      "status" => "completed",
      "error" => false,
      "events" => [],
      "ifc" => label
    }

    assert {:ok, _} =
             SalixAgent.WorkspaceEvents.commit_result(
               ctx.agent_id,
               ctx.session_id,
               stored,
               SalixAgent.AsyncToolResults.operation_source(:internal),
               store_result: true
             )

    assert {:ok, restored} =
             SalixAgent.Runtime.get_async_tool_setup_result(
               ctx.agent_id,
               ctx.session_id,
               ctx.tool_call_id
             )

    assert restored["ifc"] == label
    assert Jason.decode!(restored["content"]) == %{"data" => "provider result"}
  end

  test "revocation during schema discovery blocks dispatch", c do
    Application.put_env(:salix_agent, :composio_schema_hook, fn ->
      ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, false)
    end)

    denied(args(), c.ctx)
  end

  test "grant revocation during provider preparation blocks the actual effect", c do
    Application.put_env(:salix_agent, :composio_prepare_hook, fn ->
      ComposioAccess.grant(c.tenant, c.group, "member", "account-a", c.ctx.agent_id, false)
    end)

    denied(args(), c.ctx)
  end

  test "membership loss during provider preparation blocks the actual effect", c do
    Application.put_env(:salix_agent, :composio_prepare_hook, fn ->
      Application.put_env(:salix_agent, :composio_member_revoked, true)
    end)

    denied(args(), c.ctx)
  end

  test "mode changes during provider preparation block the actual effect", c do
    Application.put_env(:salix_agent, :composio_prepare_hook, fn ->
      ComposioAccess.update_profile(
        c.tenant,
        c.group,
        "member",
        &{:ok, Map.put(&1, "mode", "project")}
      )
    end)

    denied(args(), c.ctx)
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

    denied(args(), c.ctx)
  end

  test "membership loss removes projections and blocks execution", c do
    Application.put_env(:salix_agent, :composio_member_revoked, true)
    assert Jason.decode!(ComposioBroker.accounts(%{}, c.ctx))["accounts"] == []

    assert_raise RuntimeError, fn ->
      ComposioBroker.schema(
        %{"account_id" => "account-a", "tool_slugs" => ["GMAIL_FETCH_EMAILS"]},
        c.ctx
      )
    end

    denied(args(), c.ctx)
  end

  test "meta-tools and authoritative toolkit mismatch reject the whole batch", c do
    for slug <- ~w(COMPOSIO_REMOTE_BASH_TOOL GITHUB_CREATE_ISSUE) do
      mixed = Map.update!(args(), "tools", &(&1 ++ [%{"tool_slug" => slug, "arguments" => %{}}]))
      denied(mixed, c.ctx)
    end
  end

  test "disabled, inactive, foreign member, Agent and Group accounts cannot reuse a grant", c do
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, "member", "account-a", false)
    denied(args(), c.ctx)
    {:ok, _} = ComposioAccess.enable_account(c.tenant, c.group, "member", "account-a", true)

    {:ok, _} =
      ComposioAccess.put_account(c.tenant, c.group, "member", "account-a", %{
        "mode" => "connect",
        "toolkit" => "gmail",
        "status" => "EXPIRED"
      })

    denied(args(), c.ctx)

    {:ok, _} =
      ComposioAccess.put_account(c.tenant, c.group, "member", "account-a", %{
        "mode" => "connect",
        "toolkit" => "gmail",
        "status" => "ACTIVE"
      })

    for {group, agent, user} <- [
          {c.group <> "other", c.ctx.agent_id, "member"},
          {c.group, c.ctx.agent_id, "other"},
          {c.group, "other-agent", "member"}
        ] do
      assert {:error, :composio_access_denied} =
               ComposioAccess.authorize(c.tenant, group, agent, user, "account-a")
    end

    refute_received {:effect, _, _, _, _, _}
  end

  test "an uncertain mutation returns a failure through Tools without automatic replay", c do
    Application.put_env(:salix_agent, :composio_effect_result, {:error, :timeout})

    [result] =
      SalixAgent.Tools.execute(
        [
          %{id: c.ctx.tool_call_id, name: "composio.personal_execute", args: args()}
        ],
        runtime_context(c)
      )

    assert result.error
    assert result.error_class == "composio_execution_unconfirmed"
    assert_received {:effect, _, _, _, _, _}
    refute_received {:effect, _, _, _, _, _}
  end

  defp historical_request(c, status, extra \\ %{}) do
    # A persisted pre-cutover fixture, not a new request through the retired API.
    identity =
      Enum.join(
        [c.ctx.agent_id, c.ctx.session_id, c.ctx.tool_call_id, "composio_execution"],
        "\u001F"
      )

    id = "cap-" <> Base.url_encode64(:crypto.hash(:sha256, identity), padding: false)

    record =
      Map.merge(
        %{
          "request_id" => id,
          "group_id" => c.group,
          "tenant_id" => c.tenant,
          "source_agent_id" => c.ctx.agent_id,
          "source_session_id" => c.ctx.session_id,
          "tool_call_id" => c.ctx.tool_call_id,
          "request_type" => "composio_execution",
          "status" => status,
          "request_payload" => %{"user_id" => "member", "tools" => args()["tools"]},
          "expires_at" => System.system_time(:second) + 600
        },
        extra
      )

    {:ok, _} = S3.put(SalixStore.Keys.ctl_capability_request(c.group, id), Jason.encode!(record))
    id
  end

  test "a historical pending wait can be cancelled and reconciled without executing or erasing it",
       c do
    id = historical_request(c, "pending")

    assert {:ok, preserved} =
             CapabilityRequests.create_capability_request(%{
               "request_id" => id,
               "source_agent_id" => c.ctx.agent_id,
               "source_session_id" => c.ctx.session_id,
               "tool_call_id" => c.ctx.tool_call_id,
               "request_type" => "host_access",
               "request_payload" => %{}
             })

    assert preserved["request_payload"]["tools"] == args()["tools"]

    assert CapabilityRequests.pending_capability_request?(
             c.ctx.agent_id,
             c.ctx.session_id,
             c.ctx.tool_call_id
           )

    assert {:ok, cancelled} =
             CapabilityRequests.cancel_capability_request(
               c.ctx.agent_id,
               c.ctx.session_id,
               c.ctx.tool_call_id,
               "Per-call confirmation retired"
             )

    assert cancelled["status"] == "cancelled"
    assert cancelled["result"]["error"]

    assert {:ok, reconciled} =
             CapabilityRequests.reconcile_capability_request(
               c.ctx.agent_id,
               c.ctx.session_id,
               c.ctx.tool_call_id
             )

    assert reconciled["result"] == cancelled["result"]
    assert {:ok, saved} = CapabilityRequests.get(c.group, id, c.tenant)
    assert saved["request_payload"]["tools"] == args()["tools"]

    refute CapabilityRequests.pending_capability_request?(
             c.ctx.agent_id,
             c.ctx.session_id,
             c.ctx.tool_call_id
           )

    refute_received {:effect, _, _, _, _, _}
    assert is_binary(ComposioBroker.execute(args(), %{c.ctx | tool_call_id: "current-request"}))
    assert_received {:effect, _, _, _, _, _}
  end

  test "historical unknown settlement fails closed and stored results survive reconciliation",
       c do
    historical_request(c, "completed")

    assert {:ok, unknown} =
             CapabilityRequests.reconcile_capability_request(
               c.ctx.agent_id,
               c.ctx.session_id,
               c.ctx.tool_call_id
             )

    assert unknown["result"]["error_class"] == "composio_execution_unconfirmed"
    c = put_in(c.ctx.tool_call_id, "known-result")
    result = %{"status" => "completed", "error" => false, "content" => "saved provider result"}
    historical_request(c, "completed", %{"result" => result})

    assert {:ok, known} =
             CapabilityRequests.reconcile_capability_request(
               c.ctx.agent_id,
               c.ctx.session_id,
               c.ctx.tool_call_id
             )

    assert known["result"] == result
    refute_received {:effect, _, _, _, _, _}
  end
end
