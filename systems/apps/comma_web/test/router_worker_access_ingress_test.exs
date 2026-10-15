defmodule CommaWeb.RouterWorkerAccessIngressTest do
  @moduledoc """
  Production ingress for Router administration of Worker connector access.

  The workspace owner posts to the Router chat through Comma's HTTP API. Comma
  ingress seals the person; the Router's tool call is admitted only after
  `CommaWeb.AgentManagement.authorize_owner/2` rechecks that person as the
  workspace owner. The Worker then runs its own Task and calls the shared
  Composio executor. Only the model and the Composio HTTP client are scripted:
  the model replies by marker, and the client records calls instead of
  reaching Composio.
  """
  use ExUnit.Case, async: false

  import Comma.WorkspaceTestSupport

  @admin_token "test-token"

  defmodule ScriptLLM do
    @moduledoc "Replies once per {role, marker}; records what each role saw afterwards."
    @behaviour SalixAgent.LLM
    use Agent

    def start_link(_), do: Agent.start_link(fn -> %{script: %{}, seen: []} end, name: __MODULE__)
    def script(entries), do: Agent.update(__MODULE__, &%{&1 | script: Map.new(entries)})
    def seen, do: Agent.get(__MODULE__, & &1.seen)

    @impl true
    def complete(messages, _tools) do
      text = Jason.encode!(messages)

      role =
        cond do
          text =~ "You are a Worker agent" -> :worker
          text =~ "You are the Router agent" -> :router
          true -> :other
        end

      latest = latest_user(messages)

      Agent.get_and_update(__MODULE__, fn state ->
        state = %{state | seen: [{role, text} | state.seen]}

        case Enum.find(state.script, fn {{r, marker}, _} -> r == role and latest =~ marker end) do
          {key, response} -> {response, %{state | script: Map.delete(state.script, key)}}
          nil -> {done(), state}
        end
      end)
    end

    defp latest_user(messages) do
      messages
      |> Enum.reverse()
      |> Enum.find(%{}, &((&1[:role] || &1["role"]) == "user"))
      |> then(&(&1[:content] || &1["content"] || ""))
      |> Jason.encode!()
    end

    defp done,
      do:
        {:assistant, "done",
         [
           %{
             id: "done-#{System.unique_integer([:positive])}",
             name: "end_turn",
             args: %{"outcome" => "done"}
           }
         ]}
  end

  defmodule ComposioSettings do
    def settings(_tenant), do: {:ok, %{"api_key" => "ck_ingress_secret", "scope" => "tenant"}}
  end

  defmodule ComposioClient do
    defp accounts, do: Application.get_env(:comma_web, :ingress_composio_accounts, [])

    def list_connected_accounts_all(_settings, group, _opts),
      do: {:ok, Enum.filter(accounts(), &(&1["user_id"] == group))}

    def get_connected_account(_settings, id, _opts \\ []) do
      case Enum.find(accounts(), &(&1["id"] == id)) do
        nil -> {:error, :not_found}
        account -> {:ok, account}
      end
    end

    def list_tools(_settings, opts),
      do: {:ok, [%{"slug" => opts[:tool_slugs], "toolkit" => %{"slug" => "gmail"}}]}

    def execute_tool(_settings, slug, group, _arguments, opts) do
      send(
        Application.fetch_env!(:comma_web, :ingress_test_pid),
        {:composio_execute, group, slug, opts}
      )

      {:ok, %{"successful" => true, "data" => %{"messages" => []}}}
    end
  end

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing_owner = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)
    comma_owner = CommaWeb.TestRepoSandbox.start_owner!(:transaction)

    if Process.whereis(SalixStore.S3.Fake),
      do: SalixStore.S3.Fake.reset(),
      else: start_supervised!(SalixStore.S3.Fake)

    SalixAgent.TestSupport.stop_all_agents()

    keys = [
      {:salix_store, :s3_backend},
      {:salix_agent, :llm},
      {:salix_agent, :im_provider_mod},
      {:salix_agent, :composio_store_mod},
      {:salix_agent, :composio_client_mod},
      {:comma_core, :salix_client},
      {:comma_web, :api_token},
      {:comma_web, :ingress_composio_accounts},
      {:comma_web, :ingress_test_pid},
      {:salix_im, :conversation_notifier},
      {:salix_agent, :agent_management_ports}
    ]

    previous = Enum.map(keys, fn {app, key} -> {app, key, Application.get_env(app, key)} end)

    Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)
    Application.put_env(:comma_web, :api_token, @admin_token)
    Application.put_env(:comma_core, :salix_client, CommaWeb.SalixClient)
    Application.put_env(:salix_agent, :im_provider_mod, Salix.Bindings.AgentIMProvider)
    Application.put_env(:salix_agent, :composio_store_mod, ComposioSettings)
    Application.put_env(:salix_agent, :composio_client_mod, ComposioClient)
    # The owner recheck is Comma's composition; do not rely on whichever ports
    # an earlier suite in this VM left behind (same as comma_web_router_test).
    Application.put_env(:salix_agent, :agent_management_ports, CommaWeb.AgentManagement)
    Application.put_env(:comma_web, :ingress_test_pid, self())
    CommaWeb.Application.register_im_notifier()
    start_supervised!(ScriptLLM)
    Application.put_env(:salix_agent, :llm, ScriptLLM)

    start_supervised!(%{
      id: BillingStripe.TestAPI.Recorder,
      start: {Agent, :start_link, [fn -> [] end, [name: BillingStripe.TestAPI.Recorder]]}
    })

    on_exit(fn ->
      SalixAgent.TestSupport.stop_all_agents()

      Enum.each(previous, fn {app, key, value} ->
        if is_nil(value),
          do: Application.delete_env(app, key),
          else: Application.put_env(app, key, value)
      end)

      CommaWeb.TestRepoSandbox.stop_owner(comma_owner)
      Ecto.Adapters.SQL.Sandbox.stop_owner(billing_owner)
    end)

    :ok
  end

  test "the owner's Comma message grants, the Worker uses, the owner revokes, and use is denied" do
    user =
      req(@admin_token, :post, "/v1/comma/admin/users",
        json: %{"email" => "access-owner@example.com"}
      )
      |> expect_status(201)
      |> Map.fetch!(:body)

    workspace = create_ready_workspace!(user["id"])
    issue_billing_grant(workspace)
    group = workspace["default_group_id"]
    worker = workspace["default_worker_agent_id"]

    Application.put_env(:comma_web, :ingress_composio_accounts, [
      %{
        "id" => "ca_mail",
        "user_id" => group,
        "status" => "ACTIVE",
        "toolkit" => %{"slug" => "gmail"}
      },
      %{
        "id" => "ca_cal",
        "user_id" => group,
        "status" => "ACTIVE",
        "toolkit" => %{"slug" => "googlecalendar"}
      }
    ])

    session =
      req(@admin_token, :post, "/v1/comma/admin/users/#{user["id"]}/sessions", json: %{})
      |> expect_status(201)
      |> Map.fetch!(:body)

    :ok = CommaWeb.TestConvergence.workspace!(workspace["id"])

    chat =
      req(session["token"], :post, "/v1/comma/groups/#{group}/assistant-chat", json: %{})
      |> expect_status(200)
      |> Map.fetch!(:body)

    # The workspace's default Worker was created after the contract: no account.
    assert {:ok, %{"connector_access" => %{"default" => "none", "accounts" => %{}}}} =
             SalixAgent.Control.get_record(worker)

    ScriptLLM.script([
      {{:router, "GRANT_MAIL_1"},
       router_call("grant-1", "agent.access_set", access(worker, "allow"))},
      {{:router, "DELEGATE_1"},
       router_call("task-1", "im_api.internal.task.create", task(worker, "WORKER_READ_1"))},
      {{:worker, "WORKER_READ_1"}, worker_read("read-1")},
      {{:router, "REVOKE_MAIL_1"},
       router_call("revoke-1", "agent.access_set", access(worker, "default"))},
      {{:router, "DELEGATE_2"},
       router_call("task-2", "im_api.internal.task.create", task(worker, "WORKER_READ_2"))},
      {{:worker, "WORKER_READ_2"}, worker_read("read-2")}
    ])

    send_message!(session, group, chat, "grant", "GRANT_MAIL_1 give the Worker my mail account")

    # The tool is synchronous: once the Router's next round carries its result,
    # the record write has finished. A refusal fails here with its own code.
    grant = router_tool_result!("grant-1")

    unless match?(
             {:ok,
              %{"connector_access" => %{"accounts" => %{"composio_shared:ca_mail" => "allow"}}}},
             SalixAgent.Control.get_record(worker)
           ),
           do: flunk("grant was not applied; Router tool result: " <> grant)

    send_message!(session, group, chat, "delegate-1", "DELEGATE_1 read my mail")

    assert_receive {:composio_execute, ^group, "GMAIL_FETCH_EMAILS",
                    [connected_account_id: "ca_mail"]},
                   15_000

    send_message!(session, group, chat, "revoke", "REVOKE_MAIL_1 remove that access")
    revoke = router_tool_result!("revoke-1")

    unless match?(
             {:ok, %{"connector_access" => %{"accounts" => accounts}}} when accounts == %{},
             SalixAgent.Control.get_record(worker)
           ),
           do: flunk("revoke was not applied; Router tool result: " <> revoke)

    send_message!(session, group, chat, "delegate-2", "DELEGATE_2 read my mail again")

    # The Worker's next round sees the refused call; Composio is never reached.
    eventually(
      fn ->
        Enum.find(ScriptLLM.seen(), fn {role, text} ->
          role == :worker and text =~ "WORKER_READ_2" and text =~ "Composio account not found"
        end)
      end,
      750
    )

    refute_received {:composio_execute, _, _, _}

    # Secrets never reach the model.
    refute Enum.any?(ScriptLLM.seen(), fn {_role, text} -> text =~ "ck_ingress_secret" end)
  end

  # agent.access_set runs as an async tool: the Router's next round first sees
  # a `running` placeholder, then the completion notification
  # (`tool-call-result:<id>`) after the tool, including its record write, has
  # finished. Wait for that completion and return it, so a refusal is reported
  # by its own status and code instead of a timeout on the stored record.
  defp router_tool_result!(call_id) do
    eventually(fn ->
      Enum.find_value(ScriptLLM.seen(), fn {role, text} ->
        role == :router && completion_excerpt(text, call_id)
      end)
    end)
  end

  defp completion_excerpt(text, call_id) do
    case :binary.matches(text, ~s("runtime_message_id":"tool-call-result:#{call_id}")) do
      [] ->
        nil

      matches ->
        {at, _} = List.last(matches)
        from = max(at - 1_500, 0)
        binary_part(text, from, at - from)
    end
  end

  defp access(worker, access),
    do: %{
      "agent_id" => worker,
      "account" => %{"class" => "composio_shared", "id" => "ca_mail"},
      "access" => access
    }

  defp task(worker, content),
    do: %{
      "connect_id" => "internal",
      "agent_id" => worker,
      "content" => content,
      "title" => content
    }

  defp router_call(id, tool, params),
    do: {:assistant, "", [%{id: id, name: "call", args: %{"tool" => tool, "params" => params}}]}

  defp worker_read(id),
    do:
      {:assistant, "",
       [
         %{
           id: id,
           name: "call",
           args: %{
             "tool" => "composio.execute",
             "params" => %{
               "tool_slug" => "GMAIL_FETCH_EMAILS",
               "connected_account_id" => "ca_mail",
               "arguments" => %{}
             }
           }
         }
       ]}

  defp send_message!(session, group, chat, request_id, text) do
    req(session["token"], :post, "/v1/comma/groups/#{group}/conversations/#{chat["id"]}/messages",
      json: %{"client_request_id" => request_id, "message" => %{"content" => text}}
    )
    |> expect_status(202)
  end

  defp issue_billing_grant(%{"billing_account_id" => account_id, "id" => workspace_id}) do
    :ok =
      BillingCore.Accounts.ensure_account(%{
        repo: BillingCore.Repo,
        billing_account_id: account_id,
        surface: "comma",
        product_owner_type: "workspace",
        product_owner_id: workspace_id
      })

    {:ok, _grant} =
      BillingCore.Credits.issue_grant(%{
        repo: BillingCore.Repo,
        billing_account_id: account_id,
        credits: 100,
        valid_from: ~U[2026-06-17 00:00:00Z],
        expires_at: DateTime.utc_now() |> DateTime.add(30, :day) |> DateTime.truncate(:second),
        source_type: "manual_contract",
        source_id: "access-ingress:#{workspace_id}",
        source_event_id: "access-ingress:#{workspace_id}",
        idempotency_key: "access-ingress:#{workspace_id}"
      })
  end

  defp req(token, method, path, opts) do
    headers = [{"authorization", "Bearer " <> token}]

    Req.request!(
      [method: method, url: CommaWeb.Application.base_url() <> path, headers: headers] ++ opts
    )
  end

  defp expect_status(resp, status) do
    assert resp.status == status, inspect(resp.body)
    resp
  end

  defp eventually(fun, retries \\ 500) do
    case fun.() do
      value when value in [nil, false] and retries > 0 ->
        Process.sleep(20)
        eventually(fun, retries - 1)

      value when value in [nil, false] ->
        flunk("condition did not become true")

      value ->
        value
    end
  end
end
