defmodule SalixAgent.ComposioAccountDiscoveryTest do
  use ExUnit.Case, async: false
  alias SalixAgent.ComposioBroker
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

    def search(_, _, _, account, query, _cursor),
      do:
        {:ok,
         %{
           "tools" => [
             %{"slug" => "GMAIL_LIST_LABELS", "toolkit" => account["toolkit"], "name" => query}
           ],
           "next_cursor" => nil
         }}

    def schema(_, _, _, _, tools) do
      if Enum.all?(tools, &(&1 in ~w(GMAIL_FETCH_EMAILS GMAIL_SEND_EMAIL GMAIL_LIST_LABELS))),
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

    # Persist the actual legacy record. The release must evolve this grant once,
    # preserving its member/account/audience and explicit enabled decision.
    segment = &Base.url_encode64(&1, padding: false)

    grant_key =
      "ctl/tenants/#{segment.(tenant)}/composio/groups/#{segment.(group)}/agents/#{segment.(ctx.agent_id)}/grants/#{segment.("account-a")}.json"

    {:ok, _} =
      S3.put(
        grant_key,
        Jason.encode!(%{
          "user_id" => "member",
          "account_id" => "account-a",
          "agent_id" => ctx.agent_id,
          "tools" => ["GMAIL_FETCH_EMAILS"],
          "audience" => "group",
          "enabled" => true
        })
      )

    %{tenant: tenant, group: group, ctx: ctx}
  end

  test "account authorization discovers and executes a new toolkit action without a manual tool grant",
       c do
    assert %{"tools" => ["GMAIL_LIST_LABELS"]} =
             ComposioBroker.schema(
               %{"account_id" => "account-a", "tool_slugs" => ["GMAIL_LIST_LABELS"]},
               c.ctx
             )
             |> Jason.decode!()

    assert %{"tools" => [%{"slug" => "GMAIL_LIST_LABELS"}]} =
             ComposioBroker.search(
               %{"account_id" => "account-a", "query" => "list labels"},
               c.ctx
             )
             |> Jason.decode!()

    action = %{
      "account_id" => "account-a",
      "tools" => [%{"tool_slug" => "GMAIL_LIST_LABELS", "arguments" => %{"limit" => 1}}]
    }

    assert %{"data" => "provider result"} =
             ComposioBroker.execute(action, c.ctx) |> Jason.decode!()

    assert_received {:effect, _, _, "member", "account-a", tools}
    assert tools == action["tools"]
  end
end
