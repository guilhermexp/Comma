defmodule SalixAgent.ComposioGrantsTest do
  use ExUnit.Case, async: false
  alias SalixAgent.{ComposioBroker, ComposioGrants, Control, ToolDisclosure}
  alias SalixStore.{ComposioAccess, Ids, S3}

  defmodule Scope do
    def provider_app(_, _), do: {:error, :not_configured}

    def agent_oauth_context(agent) do
      with {:ok, a} <- SalixAgent.Control.get(agent),
           do: {:ok, %{tenant: a["tenant_id"], group_id: a["group_id"]}}
    end
  end

  defmodule Transport do
    def authorize_member(_, _, user) do
      if user in Application.get_env(:salix_agent, :composio_grant_members, []),
        do: :ok,
        else: {:error, :composio_access_denied}
    end
  end

  setup do
    entries = [
      {:salix_store, :s3_backend},
      {:salix_agent, :oauth_store_mod},
      {:salix_agent, :personal_composio_transport},
      {:salix_agent, :composio_grant_members}
    ]

    previous = Enum.map(entries, fn {app, key} -> {app, key, Application.get_env(app, key)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)

    case start_supervised(S3.Fake) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> S3.Fake.reset()
    end

    Application.put_env(:salix_agent, :oauth_store_mod, Scope)
    Application.put_env(:salix_agent, :personal_composio_transport, Transport)
    Application.put_env(:salix_agent, :composio_grant_members, ["owner", "other"])

    on_exit(fn ->
      Enum.each(previous, fn {a, k, v} ->
        if v, do: Application.put_env(a, k, v), else: Application.delete_env(a, k)
      end)
    end)

    tenant = SalixAgent.TestSupport.new_tenant_id()
    group = Ids.new_group_id(tenant)
    router = agent!(tenant, group, "router")
    worker = agent!(tenant, group, "worker")

    {:ok, _} =
      ComposioAccess.put_account(tenant, group, "owner", "gmail-1", %{
        "mode" => "connect",
        "toolkit" => "gmail",
        "status" => "ACTIVE",
        "name" => "Work mail"
      })

    %{tenant: tenant, group: group, router: router, worker: worker}
  end

  defp agent!(tenant, group, role) do
    SalixAgent.TestSupport.create_control_agent_in_group!(tenant, group, %{
      "role" => role,
      "runtime_config" => %{"kind" => "internal"}
    })
  end

  defp origin(c, overrides \\ %{}) do
    Map.merge(
      %{
        "provider" => "internal",
        "source_message_id" => "groupconv:conv:msg-1:ptp-1",
        "conversation_kind" => "user_chat",
        "source_actor_type" => "user",
        "agent_group_id" => c.group,
        "principal_ref" => %{
          "namespace" => "comma_user",
          "tenant_id" => c.tenant,
          "subject_id" => "owner"
        }
      },
      overrides
    )
  end

  defp ctx(c, caller \\ nil, origin \\ :default) do
    origin = if origin == :default, do: origin(c), else: origin

    %{
      agent_id: (caller || c.router)["agent_id"],
      session_id: Ids.new_session_id(),
      tool_call_id: "call-#{System.unique_integer([:positive])}",
      source_message_id: origin && origin["source_message_id"],
      trusted_origin: origin,
      ifc: %{}
    }
  end

  defp grant_args(c, extra \\ %{}),
    do:
      Map.merge(
        %{
          "agent_id" => c.worker["agent_id"],
          "account_id" => "gmail-1",
          "user_confirmed" => true
        },
        extra
      )

  defp revoke_args(c), do: Map.delete(grant_args(c), "user_confirmed")

  defp ok!(result) do
    assert {:tool_ifc, content, [], %{"label" => [_]}} = result
    Jason.decode!(content)
  end

  defp denied(result, code) do
    assert {:tool_failure, _, ^code, "user_reportable", _, []} = result
  end

  defp worker_accounts(c) do
    {:tool_ifc, content, _, _} =
      ComposioBroker.accounts(%{}, %{agent_id: c.worker["agent_id"], tool_call_id: "w", ifc: %{}})

    Jason.decode!(content)["accounts"]
  end

  defp no_grant(c) do
    assert {:error, :not_found} =
             ComposioAccess.agent_account_grant(
               c.tenant,
               c.group,
               c.worker["agent_id"],
               "gmail-1"
             )
  end

  test "the owner's confirmed request grants the same record the UI writes, and revoke removes it",
       c do
    assert %{"granted" => true, "usable" => true, "toolkit" => "gmail"} =
             ok!(ComposioGrants.call(:grant, grant_args(c), ctx(c)))

    assert {:ok, grant} =
             ComposioAccess.agent_account_grant(
               c.tenant,
               c.group,
               c.worker["agent_id"],
               "gmail-1"
             )

    assert grant == %{
             "user_id" => "owner",
             "account_id" => "gmail-1",
             "agent_id" => c.worker["agent_id"],
             "toolkit" => "gmail",
             "mode" => "connect",
             "access" => "toolkit",
             "audience" => "group",
             "enabled" => true
           }

    assert [%{"account_id" => "gmail-1", "toolkit" => "gmail"}] = worker_accounts(c)

    listed = ok!(ComposioGrants.call(:list, %{"agent_id" => c.worker["agent_id"]}, ctx(c)))

    assert [%{"account_id" => "gmail-1", "granted" => true, "usable" => true}] =
             listed["accounts"]

    assert %{"granted" => false} =
             ok!(ComposioGrants.call(:revoke, revoke_args(c), ctx(c)))

    assert worker_accounts(c) == []

    assert [%{"granted" => false, "usable" => false}] =
             ok!(ComposioGrants.call(:list, %{"agent_id" => c.worker["agent_id"]}, ctx(c)))[
               "accounts"
             ]
  end

  test "granting requires strict JSON true confirmation", c do
    for value <- [false, "true", 1] do
      result = ComposioGrants.call(:grant, grant_args(c, %{"user_confirmed" => value}), ctx(c))
      assert {:tool_failure, _, code, "user_reportable", _, []} = result
      assert code in ["user_confirmation_required", "invalid_arguments"]
    end

    denied(
      ComposioGrants.call(:grant, Map.delete(grant_args(c), "user_confirmed"), ctx(c)),
      "invalid_arguments"
    )

    no_grant(c)
  end

  test "identity comes only from a person's current sealed Comma message", c do
    origins = [
      nil,
      # A Worker report or other agent-authored message.
      origin(c, %{"source_actor_type" => "agent", "principal_ref" => nil}),
      origin(c, %{"source_actor_type" => "agent"}),
      # A scheduled Task fire.
      origin(c, %{"task_schedule" => %{"schedule_id" => "s"}}),
      origin(c, %{"provider" => "schedule"}),
      origin(c, %{"provider" => "loop"}),
      # Slack/Feishu identities are not Comma account owners.
      origin(c, %{
        "provider" => "slack",
        "source_actor_type" => "provider_user",
        "principal_ref" => %{
          "namespace" => "slack_user",
          "tenant_id" => c.tenant,
          "subject_id" => "owner"
        }
      }),
      origin(c, %{
        "principal_ref" => %{
          "namespace" => "slack_user",
          "tenant_id" => c.tenant,
          "subject_id" => "owner"
        }
      }),
      # Another Group or tenant.
      origin(c, %{"agent_group_id" => Ids.new_group_id(c.tenant)}),
      origin(c, %{
        "principal_ref" => %{
          "namespace" => "comma_user",
          "tenant_id" => SalixAgent.TestSupport.new_tenant_id(),
          "subject_id" => "owner"
        }
      })
    ]

    for origin <- origins do
      denied(
        ComposioGrants.call(:grant, grant_args(c), ctx(c, nil, origin)),
        "current_owner_request_required"
      )

      denied(
        ComposioGrants.call(:revoke, revoke_args(c), ctx(c, nil, origin)),
        "current_owner_request_required"
      )
    end

    # An origin that is not the source this activation is handling.
    stale = ctx(c) |> Map.put(:source_message_id, "groupconv:conv:msg-2:ptp-9")
    denied(ComposioGrants.call(:grant, grant_args(c), stale), "current_owner_request_required")

    # Model-supplied identity fields are rejected by the closed schema.
    denied(
      ComposioGrants.call(:grant, grant_args(c, %{"user_id" => "owner"}), ctx(c, nil, nil)),
      "invalid_arguments"
    )

    no_grant(c)
  end

  test "only the account owner, still a member, can grant or revoke it", c do
    other =
      origin(c, %{
        "principal_ref" => %{
          "namespace" => "comma_user",
          "tenant_id" => c.tenant,
          "subject_id" => "other"
        }
      })

    denied(
      ComposioGrants.call(:grant, grant_args(c), ctx(c, nil, other)),
      "composio_account_not_found"
    )

    Application.put_env(:salix_agent, :composio_grant_members, ["other"])
    denied(ComposioGrants.call(:grant, grant_args(c), ctx(c)), "composio_access_denied")
    no_grant(c)

    Application.put_env(:salix_agent, :composio_grant_members, ["owner", "other"])
    ok!(ComposioGrants.call(:grant, grant_args(c), ctx(c)))

    denied(
      ComposioGrants.call(:revoke, revoke_args(c), ctx(c, nil, other)),
      "composio_account_not_found"
    )

    assert [%{"account_id" => "gmail-1"}] = worker_accounts(c)
  end

  test "targets must be live Agents in the caller's own tenant and Group", c do
    other_group = agent!(c.tenant, Ids.new_group_id(c.tenant), "worker")
    other_tenant_id = SalixAgent.TestSupport.new_tenant_id()
    other_tenant = agent!(other_tenant_id, Ids.new_group_id(other_tenant_id), "worker")
    archived = agent!(c.tenant, c.group, "worker")
    assert {:ok, _} = Control.archive_permanently(archived["agent_id"], c.tenant)

    for agent_id <- [
          other_group["agent_id"],
          other_tenant["agent_id"],
          archived["agent_id"],
          Ids.new_agent_id(c.group)
        ] do
      denied(
        ComposioGrants.call(:grant, grant_args(c, %{"agent_id" => agent_id}), ctx(c)),
        "agent_not_found"
      )

      assert {:error, :not_found} =
               ComposioAccess.agent_account_grant(c.tenant, c.group, agent_id, "gmail-1")
    end
  end

  test "only a Router may call the tools", c do
    for operation <- [:grant, :revoke, :list] do
      args =
        case operation do
          :list -> %{"agent_id" => c.worker["agent_id"]}
          :grant -> grant_args(c)
          :revoke -> revoke_args(c)
        end

      denied(ComposioGrants.call(operation, args, ctx(c, c.worker)), "forbidden")
    end

    no_grant(c)
  end

  test "the tools are disclosed to Routers only, without tenant Composio settings", c do
    names = ~w(composio.personal_grant_list composio.personal_grant composio.personal_revoke)

    for {role, expected} <- [{"router", true}, {"worker", false}] do
      base = %{tenant_id: c.tenant, group_id: c.group, role: role, runtime_kind: :internal}
      disclosure = ToolDisclosure.materialize_static(role, :internal, base)
      ctx = Map.put(base, :tool_disclosure, disclosure)

      for name <- names do
        assert ToolDisclosure.callable?(ctx, name) == expected, "#{role} #{name}"
      end
    end

    router_ctx =
      %{tenant_id: c.tenant, group_id: c.group, role: "router", runtime_kind: :internal}
      |> then(
        &Map.put(&1, :tool_disclosure, ToolDisclosure.materialize_static("router", :internal, &1))
      )

    help =
      SalixAgent.Tools.help(%{"tool" => "composio.personal_grant"}, router_ctx) |> Jason.decode!()

    assert help["input_schema"]["required"] == ~w(agent_id account_id user_confirmed)
    assert help["input_schema"]["additionalProperties"] == false
  end

  test "grant changes are Group configuration and listing is a read for IFC", c do
    ctx = %{group_id: c.group}

    for name <- ~w(composio.personal_grant composio.personal_revoke) do
      assert {:persist, %{"kind" => "agent_configuration", "group_id" => group}} =
               SalixAgent.IFC.Destination.describe(name, %{}, ctx)

      assert group == c.group
    end

    assert {:read, _} =
             SalixAgent.IFC.Destination.describe("composio.personal_grant_list", %{}, ctx)
  end
end
