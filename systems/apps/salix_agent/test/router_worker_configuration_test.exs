defmodule SalixAgent.RouterWorkerConfigurationTest do
  @moduledoc """
  Router administration of Worker configuration on the workspace owner's
  request. Effects are observed through the real executors: shared Composio
  execution, managed OAuth credential resolution, the personal Composio
  broker, skill projection and model resolution. Comma ingress identity is
  proven separately in comma_web.
  """
  use ExUnit.Case, async: false

  alias SalixAgent.{AgentManagement, ComposioBroker, Control, OAuthCredentials, SkillProjection}
  alias SalixAgent.Tools.Composio, as: SharedComposio
  alias SalixStore.{ComposioAccess, Ids, Keys, S3}

  @secret_token "oauth-secret-token-value"
  @composio_key "ck_secret_settings_key"

  defmodule Ports do
    @behaviour SalixAgent.AgentManagement.Ports
    def project_id(_), do: {:error, :target_not_found}
    def connected_target(_, _), do: {:error, :target_unavailable}
    def page_targets(_, _), do: {:error, :target_unavailable}

    def worker_template(scope),
      do: SalixAgent.AgentDefaults.creation_template("worker", scope.tenant_id)

    def authorize_owner(scope, user_id) do
      if {scope.group_id, user_id} in Application.get_env(:salix_agent, :test_owners, []),
        do: :ok,
        else: {:error, :owner_required}
    end
  end

  defmodule Scope do
    def provider_app(_, _), do: {:error, :not_configured}

    def agent_oauth_context(agent) do
      with {:ok, a} <- SalixAgent.Control.get_record(agent),
           do: {:ok, %{tenant: a["tenant_id"], group_id: a["group_id"]}}
    end

    def bindings_for_group(group),
      do: {:ok, Application.get_env(:salix_agent, :test_oauth_bindings, %{})[group] || []}
  end

  defmodule ComposioSettings do
    def settings(_tenant), do: {:ok, %{"api_key" => "ck_secret_settings_key", "scope" => "t"}}
  end

  defmodule ComposioClient do
    def accounts, do: Application.get_env(:salix_agent, :test_composio_accounts, [])

    def list_connected_accounts_all(_settings, group, _opts),
      do: {:ok, Enum.filter(accounts(), &(&1["user_id"] == group))}

    def get_connected_account(_settings, id, _opts \\ []) do
      case Enum.find(accounts(), &(&1["id"] == id)) do
        nil -> {:error, :not_found}
        account -> {:ok, account}
      end
    end

    # The catalog names each action's toolkit by its slug prefix.
    def list_tools(_settings, opts) do
      slug = opts[:tool_slugs]

      toolkit =
        cond do
          String.starts_with?(slug, "GMAIL_") -> "gmail"
          String.starts_with?(slug, "GOOGLECALENDAR_") -> "googlecalendar"
          true -> "composio"
        end

      {:ok, [%{"slug" => slug, "toolkit" => %{"slug" => toolkit}}]}
    end

    def list_triggers(_settings, group, trigger_id: id) do
      {:ok,
       %{
         "items" => [
           %{
             "id" => id,
             "user_id" => group,
             "connected_account_id" => "ca_mail",
             "trigger_name" => "GMAIL_NEW"
           }
         ]
       }}
    end

    def manage_trigger(_settings, _group, id, action) do
      send(Application.get_env(:salix_agent, :test_pid), {:manage_trigger, id, action})
      {:ok, %{}}
    end

    def execute_tool(_settings, slug, group, _args, opts) do
      send(Application.get_env(:salix_agent, :test_pid), {:composio_execute, group, slug, opts})
      {:ok, %{"successful" => true, "data" => %{"ok" => true}}}
    end
  end

  defmodule PersonalTransport do
    def authorize_member(_, _, user) do
      if user in Application.get_env(:salix_agent, :test_members, []),
        do: :ok,
        else: {:error, :composio_access_denied}
    end

    def schema(_, _, _, _, _), do: {:ok, %{}}

    def execute(_, _, user, account, _tools, authorize) do
      with :ok <- authorize.() do
        send(
          Application.get_env(:salix_agent, :test_pid),
          {:personal_execute, user, account["id"]}
        )

        {:ok, %{"successful" => true}}
      end
    end
  end

  @env [
    {:salix_store, :s3_backend},
    {:salix_agent, :agent_management_ports},
    {:salix_agent, :oauth_store_mod},
    {:salix_agent, :composio_store_mod},
    {:salix_agent, :composio_client_mod},
    {:salix_agent, :personal_composio_transport},
    {:salix_agent, :test_owners},
    {:salix_agent, :test_members},
    {:salix_agent, :test_oauth_bindings},
    {:salix_agent, :test_composio_accounts},
    {:salix_agent, :test_pid}
  ]

  setup do
    previous = Enum.map(@env, fn {app, key} -> {app, key, Application.get_env(app, key)} end)
    Application.put_env(:salix_store, :s3_backend, S3.Fake)

    case start_supervised(S3.Fake) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> S3.Fake.reset()
    end

    on_exit(fn ->
      SalixAgent.TestSupport.stop_all_agents()

      Enum.each(previous, fn {app, key, value} ->
        if value, do: Application.put_env(app, key, value), else: Application.delete_env(app, key)
      end)
    end)

    Application.put_env(:salix_agent, :agent_management_ports, Ports)
    Application.put_env(:salix_agent, :oauth_store_mod, Scope)
    Application.put_env(:salix_agent, :composio_store_mod, ComposioSettings)
    Application.put_env(:salix_agent, :composio_client_mod, ComposioClient)
    Application.put_env(:salix_agent, :personal_composio_transport, PersonalTransport)
    Application.put_env(:salix_agent, :test_pid, self())

    tenant = SalixAgent.TestSupport.new_tenant_id()
    group = Ids.new_group_id(tenant)
    other_group = Ids.new_group_id(tenant)

    {:ok, template} =
      SalixAgent.Templates.create(%{
        "name" => "Worker default",
        "model" => "worker-model",
        "provider" => "mock"
      })

    _ =
      SalixAgent.TestSupport.put_tenant_agent_defaults!(tenant, %{
        "worker_template_id" => template["template_id"]
      })

    router = agent!(tenant, group, %{"role" => "router"})
    other_router = agent!(tenant, other_group, %{"role" => "router"})
    legacy = agent!(tenant, group, %{"name" => "Legacy"})
    worker = agent!(tenant, group, %{"name" => "New", "connector_access_policy" => "new"})
    sibling = agent!(tenant, group, %{"name" => "Sibling", "connector_access_policy" => "new"})
    foreign = agent!(tenant, other_group, %{"name" => "Foreign"})

    Application.put_env(:salix_agent, :test_owners, [{group, "owner"}, {other_group, "owner"}])
    Application.put_env(:salix_agent, :test_members, ["owner", "member"])

    Application.put_env(:salix_agent, :test_composio_accounts, [
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
      },
      %{
        "id" => "ca_far",
        "user_id" => other_group,
        "status" => "ACTIVE",
        "toolkit" => %{"slug" => "gmail"}
      }
    ])

    :ok =
      SalixStore.OAuth.put("conn-gh", %{"access_token" => @secret_token, "status" => "active"})

    :ok =
      SalixStore.OAuth.put("conn-gh2", %{"access_token" => "second-token", "status" => "active"})

    Application.put_env(:salix_agent, :test_oauth_bindings, %{
      group => [
        %{
          "binding_id" => "oauth-gh",
          "provider" => "github",
          "alias" => "work",
          "connection_id" => "conn-gh",
          "enabled" => true
        },
        %{
          "binding_id" => "oauth-gh2",
          "provider" => "github",
          "alias" => "personal",
          "connection_id" => "conn-gh2",
          "enabled" => true
        }
      ]
    })

    {:ok, _} =
      ComposioAccess.put_account(tenant, group, "owner", "pa_notion", %{
        "mode" => "connect",
        "toolkit" => "notion",
        "status" => "ACTIVE",
        "name" => "Owner notion"
      })

    %{
      tenant: tenant,
      group: group,
      other_group: other_group,
      router: router,
      other_router: other_router,
      legacy: legacy,
      worker: worker,
      sibling: sibling,
      foreign: foreign
    }
  end

  defp agent!(tenant, group, attrs) do
    SalixAgent.TestSupport.create_control_agent_in_group!(
      tenant,
      group,
      Map.merge(%{"runtime_config" => %{"kind" => "internal"}}, attrs)
    )
  end

  # An existing compute Worker: the stored binding a compute runtime writes.
  defp compute!(c, spec) do
    agent = agent!(c.tenant, c.group, %{"connector_access_policy" => "new"})
    key = Keys.ctl_agent(agent["agent_id"])
    {:ok, %{body: body, etag: etag}} = S3.get(key)

    runtime = %{
      "kind" => "compute_workload",
      "workload_id" => "wl-" <> agent["agent_id"],
      "runtime_spec" => spec,
      "owner_scope" => %{"type" => "project", "id" => "proj-1"},
      "binding_revision" => 1
    }

    record = body |> Jason.decode!() |> Map.put("runtime_config", runtime)
    {:ok, _} = S3.put(key, Jason.encode!(record), if_match: etag)
    SalixStore.ReadScope.invalidate({:record, key})
    record
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
        },
        "ifc" => %{"integrity" => "command"}
      },
      overrides
    )
  end

  defp ctx(c, opts \\ []) do
    origin = Keyword.get(opts, :origin, origin(c))
    caller = Keyword.get(opts, :caller, c.router)

    %{
      agent_id: caller["agent_id"],
      session_id: Ids.new_session_id(),
      tool_call_id: "call-#{System.unique_integer([:positive])}",
      source_message_id: Keyword.get(opts, :source, origin && origin["source_message_id"]),
      trusted_origin: origin
    }
  end

  defp run(c, op, args, opts \\ []),
    do:
      AgentManagement.run(
        op,
        args,
        SalixAgent.TestSupport.with_plugin_projection(ctx(c, opts))
      )

  defp set!(c, agent, class, id, access) do
    assert {:ok, result} =
             run(c, :access_set, %{
               "agent_id" => agent["agent_id"],
               "account" => %{"class" => class, "id" => id},
               "access" => access
             })

    result
  end

  defp shared_execute(agent, account) do
    slug = if account == "ca_cal", do: "GOOGLECALENDAR_EVENTS_LIST", else: "GMAIL_FETCH_EMAILS"
    args = %{"tool_slug" => slug, "arguments" => %{}}
    args = if account, do: Map.put(args, "connected_account_id", account), else: args
    SharedComposio.execute(args, %{agent_id: agent["agent_id"], group_id: agent["group_id"]})
  end

  defp oauth_env(agent, alias_) do
    OAuthCredentials.resolve(agent["agent_id"], [
      %{"env_var" => "GH", "provider" => "github", "alias" => alias_, "value" => "access_token"}
    ])
  end

  describe "owner authority" do
    test "rejects every origin that is not the owner's own current Comma message", c do
      args = %{"agent_id" => c.worker["agent_id"], "instructions" => "Be terse"}

      rejected = [
        {:origin, nil},
        {:origin, origin(c, %{"source_actor_type" => "agent"})},
        {:origin, origin(c, %{"source_actor_type" => "system"})},
        {:origin, origin(c, %{"provider" => "schedule"})},
        {:origin, origin(c, %{"provider" => "loop"})},
        {:origin, origin(c, %{"task_schedule" => %{"schedule_id" => "s"}})},
        {:origin,
         origin(c, %{
           "provider" => "slack",
           "source_actor_type" => "provider_user",
           "principal_ref" => %{
             "namespace" => "slack_user",
             "tenant_id" => c.tenant,
             "subject_id" => "U1"
           }
         })},
        {:origin, origin(c, %{"ifc" => %{"integrity" => "data"}})},
        {:origin, origin(c, %{"agent_group_id" => c.other_group})},
        {:origin,
         origin(c, %{
           "principal_ref" => %{
             "namespace" => "comma_user",
             "tenant_id" => SalixAgent.TestSupport.new_tenant_id(),
             "subject_id" => "owner"
           }
         })},
        {:origin, Map.delete(origin(c), "source_message_id")},
        {:source, nil},
        {:source, ""},
        {:source, "groupconv:conv:older:ptp-1"}
      ]

      for {kind, value} <- rejected do
        assert {:error, %{"code" => "current_owner_request_required"}} =
                 run(c, :configure, args, [{kind, value}]),
               inspect({kind, value})
      end

      # A sealed person who is not the active owner is rechecked and refused.
      member =
        origin(c, %{
          "principal_ref" => %{
            "namespace" => "comma_user",
            "tenant_id" => c.tenant,
            "subject_id" => "member"
          }
        })

      assert {:error, %{"code" => "owner_required"}} = run(c, :configure, args, origin: member)

      # Workers cannot use the Router catalog, even with an owner's origin.
      assert {:error, %{"code" => "forbidden"}} = run(c, :configure, args, caller: c.worker)

      assert {:ok, record} = Control.get_record(c.worker["agent_id"])
      assert record["system_prompt"] in [nil, ""]
    end

    test "targets must be live Workers of the Router's own Group", c do
      args = &%{"agent_id" => &1, "instructions" => "x"}

      assert {:error, %{"code" => "agent_not_found"}} =
               run(c, :configure, args.(c.foreign["agent_id"]))

      assert {:error, %{"code" => "agent_not_found"}} =
               run(c, :configure, args.(c.router["agent_id"]))

      {:ok, _} = Control.archive_permanently(c.sibling["agent_id"], c.tenant)

      assert {:error, %{"code" => code}} = run(c, :configure, args.(c.sibling["agent_id"]))
      assert code in ~w(agent_archived agent_permanently_archived)

      assert {:error, %{"code" => ^code}} =
               run(c, :access_set, %{
                 "agent_id" => c.sibling["agent_id"],
                 "account" => %{"class" => "composio_shared", "id" => "ca_mail"},
                 "access" => "allow"
               })

      # Reads of an archived Worker stay available.
      assert {:ok, _} =
               run(c, :access_list, %{"agent_id" => c.sibling["agent_id"], "class" => "oauth"})
    end

    test "an explicit request needs no confirmation flag and an unknown outcome is reported", c do
      key = Keys.ctl_agent(c.worker["agent_id"])
      S3.Fake.set_fault({:ambiguous_after, :put, key})

      assert {:error, %{"code" => "mutation_outcome_unknown"}} =
               run(c, :configure, %{"agent_id" => c.worker["agent_id"], "instructions" => "Ship"})

      # The read-back settles the ambiguity.
      assert {:ok, %{"agent" => %{"configuration" => %{"instructions" => "Ship"}}}} =
               run(c, :get, %{"agent_id" => c.worker["agent_id"]})
    end
  end

  describe "existing Router writes in Comma Groups" do
    setup c do
      comma =
        owned_group!(c, %{
          "surface" => "comma",
          "product_owner_type" => "workspace",
          "product_owner_id" => "ws-owner-writes"
        })

      Application.put_env(:salix_agent, :test_owners, [{c.group, "owner"}, {comma, "owner"}])
      router = agent!(c.tenant, comma, %{"role" => "router"})
      worker = agent!(c.tenant, comma, %{"name" => "Comma Worker"})
      %{comma: comma, comma_router: router, comma_worker: worker}
    end

    defp comma_run(c, op, args, origin_overrides) do
      origin =
        if origin_overrides == :none,
          do: nil,
          else: origin(c, Map.merge(%{"agent_group_id" => c.comma}, origin_overrides))

      run(c, op, args, caller: c.comma_router, origin: origin)
    end

    test "update, rebind, create and archive need the current owner's own request", c do
      update = %{"agent_id" => c.comma_worker["agent_id"], "name" => "Renamed"}

      member = %{
        "principal_ref" => %{
          "namespace" => "comma_user",
          "tenant_id" => c.tenant,
          "subject_id" => "member"
        }
      }

      assert {:error, %{"code" => "current_owner_request_required"}} =
               comma_run(c, :update, update, :none)

      assert {:error, %{"code" => "current_owner_request_required"}} =
               comma_run(c, :update, update, %{"task_schedule" => %{"schedule_id" => "s1"}})

      assert {:error, %{"code" => "current_owner_request_required"}} =
               run(c, :update, update,
                 caller: c.comma_router,
                 origin: origin(c, %{"agent_group_id" => c.comma}),
                 source: "groupconv:conv:older:ptp-1"
               )

      assert {:error, %{"code" => "owner_required"}} = comma_run(c, :update, update, member)
      assert {:ok, %{"agent" => %{"name" => "Renamed"}}} = comma_run(c, :update, update, %{})

      create = %{
        "name" => "Scheduled",
        "purpose" => "x",
        "creation_reason" => "y",
        "runtime" => %{"kind" => "internal"}
      }

      assert {:error, %{"code" => "current_owner_request_required"}} =
               comma_run(c, :create, create, %{"provider" => "schedule"})

      assert {:ok, %{"result" => "applied"}} = comma_run(c, :create, create, %{})

      assert {:error, %{"code" => "current_owner_request_required"}} =
               comma_run(
                 c,
                 :rebind,
                 %{
                   "agent_id" => c.comma_worker["agent_id"],
                   "target" => %{"kind" => "connected", "device_runtime_id" => "drt"},
                   "expected_binding_revision" => 0
                 },
                 %{"source_actor_type" => "agent"}
               )

      archive = %{"agent_id" => c.comma_worker["agent_id"], "user_confirmed" => true}

      assert {:error, %{"code" => "current_owner_request_required"}} =
               comma_run(c, :archive, archive, %{"provider" => "loop"})

      # Archive keeps its irreversibility confirmation even for the owner.
      assert {:error, %{"code" => "user_confirmation_required"}} =
               comma_run(c, :archive, %{archive | "user_confirmed" => false}, %{})

      assert {:ok, %{"agent" => %{"lifecycle" => "archived"}}} =
               comma_run(c, :archive, archive, %{})
    end

    test "Groups of other products keep the Router-only rule", c do
      assert {:ok, %{"agent" => %{"name" => "Still Router-only"}}} =
               run(
                 c,
                 :update,
                 %{"agent_id" => c.legacy["agent_id"], "name" => "Still Router-only"},
                 origin: nil
               )
    end
  end

  describe "Composio triggers" do
    test "a Worker without the account cannot change a shared trigger but can unsubscribe its Loop",
         c do
      ctx = %{agent_id: c.worker["agent_id"], session_id: Ids.new_session_id(), group_id: c.group}
      manage = %{"trigger_id" => "trig-1", "action" => "delete"}

      for action <- ~w(delete disable enable) do
        assert_raise RuntimeError, ~r/not_found/, fn ->
          SalixAgent.Tools.ComposioTriggers.manage(%{manage | "action" => action}, ctx)
        end
      end

      refute_received {:manage_trigger, _, _}

      set!(c, c.worker, "composio_shared", "ca_mail", "allow")
      SalixAgent.Tools.ComposioTriggers.manage(manage, ctx)
      assert_received {:manage_trigger, "trig-1", "delete"}

      # Unsubscribing its own Loop needs no account access.
      set!(c, c.worker, "composio_shared", "ca_mail", "default")

      SalixStore.Repo.query!("DELETE FROM agent_loops WHERE agent_id = $1", [c.worker["agent_id"]])

      elf = <<0x7F, ?E, ?L, ?F, 1, 2, 3>>

      {:ok, event} =
        SalixAgent.AgentWorkspace.prepare_write(c.worker["agent_id"], "/loops/a.elf", elf)

      {:ok, _} =
        SalixAgent.AgentWorkspace.seed_operation(c.worker["agent_id"], "trigger-test", %{}, [
          event
        ])

      {:ok, loop} =
        SalixAgent.Loops.create(
          Map.put(ctx, :ifc_evidence, %{
            "requester" => "comma_user|owner",
            "sources_label" => ["public"]
          }),
          %{"path" => "/loops/a.elf"}
        )

      result =
        SalixAgent.Tools.ComposioTriggers.bind(%{"loop_id" => loop["loop_id"] || loop["id"]}, ctx)

      refute match?({:tool_failure, _, _, _, _, _}, result)
    end
  end

  describe "model readback and concurrent choices" do
    test "the saved choice, including a forced paid API-key Profile, reads back without secrets",
         c do
      id = c.worker["agent_id"]

      model =
        Enum.find(
          SalixAgent.Models.list(),
          &(&1["efforts"] not in [nil, []] and Map.has_key?(&1["routes"], "openrouter"))
        )

      {:ok, profile} =
        SalixAgent.AccountPool.create(c.tenant, %{
          "credential_kind" => "provider_api_key",
          "source" => "openrouter",
          "api_key" => "sk-or-v1-secretsecret0123"
        })

      selection = %{
        "kind" => "catalog",
        "model" => model["id"],
        "allow_paid" => false,
        "reasoning_effort" => hd(model["efforts"]),
        "profile_id" => profile["id"]
      }

      expected = %{selection | "allow_paid" => true}

      assert {:ok, %{"agent" => %{"model" => set}}} =
               run(c, :set_model, %{"agent_id" => id, "selection" => selection})

      assert set["selection"] == expected
      assert set["reasoning_effort"] == hd(model["efforts"])
      assert {:ok, %{"agent" => %{"model" => got}}} = run(c, :get, %{"agent_id" => id})
      assert got["selection"] == expected
      assert {:ok, %{"current" => current}} = run(c, :model_choices, %{"agent_id" => id})
      assert current["selection"] == expected
      refute inspect([set, got, current]) =~ "secretsecret"

      assert {:ok, %{"agent" => %{"model" => %{"selection" => %{"kind" => "builtin"}}}}} =
               run(c, :set_model, %{"agent_id" => id, "selection" => %{"kind" => "builtin"}})
    end

    test "a stale lookup cannot report or keep the wrong choice after a competing write", c do
      id = c.worker["agent_id"]
      # A reads the Worker while it follows the builtin default.
      {:ok, _} = Control.configure(id, %{"template_id" => nil}, c.tenant)
      {:ok, %{"template_id" => nil} = stale} = Control.get(id, c.tenant)
      model = Enum.find(SalixAgent.Models.list(), &Map.has_key?(&1["routes"], "openrouter"))
      catalog = %{"kind" => "catalog", "model" => model["id"], "allow_paid" => false}

      # B writes a catalog choice after A looked the Agent up.
      _ = SalixAgent.AgentModelSelection.apply(stale, c.tenant, catalog)
      {:ok, %{"template_id" => catalog_template}} = Control.get_record(id)
      assert is_binary(catalog_template)

      # A applies builtin with its stale record: the transition is catalog -> builtin.
      result = SalixAgent.AgentModelSelection.apply(stale, c.tenant, %{"kind" => "builtin"})
      assert {:ok, %{"template_id" => nil}} = Control.get_record(id)
      assert {:ok, %{record: record, previous: previous}} = result
      assert previous["template_id"] == catalog_template
      assert record["template_id"] == nil
      # The replaced private template has no Agent left and is released.
      assert {:error, :not_found} = SalixAgent.Templates.get(catalog_template, c.tenant)
    end
  end

  describe "shared Composio action contract" do
    test "a Worker under per-account access cannot use meta-tools or another toolkit's action",
         c do
      set!(c, c.worker, "composio_shared", "ca_mail", "allow")

      exec = fn slug ->
        SharedComposio.execute(
          %{"tool_slug" => slug, "connected_account_id" => "ca_mail", "arguments" => %{}},
          %{agent_id: c.worker["agent_id"]}
        )
      end

      assert_raise RuntimeError, ~r/meta-tools/, fn -> exec.("COMPOSIO_MULTI_EXECUTE_TOOL") end
      assert_raise RuntimeError, ~r/toolkit/, fn -> exec.("GOOGLECALENDAR_EVENTS_LIST") end
      refute_received {:composio_execute, _, _, _}
      exec.("GMAIL_FETCH_EMAILS")
      assert_received {:composio_execute, _, "GMAIL_FETCH_EMAILS", _}
    end
  end

  describe "creation defaults" do
    defp create_in(c, group, role) do
      id = Ids.new_agent_id(group)

      Control.create_owned_preallocated(
        %{"group_id" => group, "role" => role, "name" => "Created #{role}"},
        c.tenant,
        id
      )
    end

    defp owned_group!(c, billing_owner) do
      group = Ids.new_group_id(c.tenant)
      SalixAgent.TestSupport.create_control_group!(group, %{"billing_owner" => billing_owner})
      group
    end

    test "new Workers in Comma Groups start with none; other Groups and roles keep Group access",
         c do
      comma =
        owned_group!(c, %{
          "surface" => "comma",
          "product_owner_type" => "workspace",
          "product_owner_id" => "ws-1"
        })

      bridge = owned_group!(c, %{"surface" => "bridge", "project_id" => "proj-1"})

      assert {:ok, worker} = create_in(c, comma, "worker")

      assert {:ok, %{"connector_access" => %{"default" => "none", "accounts" => %{}}}} =
               Control.get_record(worker["agent_id"])

      assert {:ok, router} = create_in(c, comma, "router")
      refute Map.has_key?(elem(Control.get_record(router["agent_id"]), 1), "connector_access")

      # Bridge for Teams is outside this contract and keeps inherited access.
      assert {:ok, bft} = create_in(c, bridge, "worker")
      assert {:ok, record} = Control.get_record(bft["agent_id"])
      refute Map.has_key?(record, "connector_access")
      assert SalixAgent.ConnectorAccess.allowed?(record, "composio_shared", "ca_any")
    end

    test "an unreadable Group fails the create instead of granting inherited access", c do
      group =
        owned_group!(c, %{
          "surface" => "comma",
          "product_owner_type" => "workspace",
          "product_owner_id" => "ws-2"
        })

      S3.Fake.set_fault({:fail, 503, :get, Keys.ctl_group(group)})
      assert {:error, _} = create_in(c, group, "worker")
    end
  end

  describe "settings" do
    test "instructions, tool restrictions and vm are saved, read back and used by the runtime",
         c do
      id = c.worker["agent_id"]

      assert {:ok, %{"result" => "applied", "agent" => agent}} =
               run(c, :configure, %{
                 "agent_id" => id,
                 "instructions" => "Answer in Portuguese.",
                 "disabled_tools" => ["composio.execute", "web.http_request"],
                 "vm" => %{"enabled" => false}
               })

      assert agent["configuration"]["instructions"] == "Answer in Portuguese."
      assert agent["configuration"]["disabled_tools"] == ["composio.execute", "web.http_request"]
      # Purpose is descriptive and stays separate from instructions.
      assert agent["purpose"] == ""

      assert {:ok, runtime} = SalixAgent.AgentRuntimeConfig.resolve(id)
      assert runtime.prompts["system_prompt"] == "Answer in Portuguese."
      assert "composio.execute" in runtime.disabled_tools

      assert {:ok, %{"result" => "unchanged"}} =
               run(c, :configure, %{"agent_id" => id, "instructions" => "Answer in Portuguese."})

      assert {:error, %{"code" => "unknown_tools", "unknown" => ["no.such.tool"]}} =
               run(c, :configure, %{"agent_id" => id, "disabled_tools" => ["no.such.tool"]})

      assert {:error, %{"code" => "invalid_arguments"}} =
               run(c, :configure, %{"agent_id" => id})
    end
  end

  describe "model" do
    test "builtin and catalog choices use Comma's selection owner; API-key Profiles count as paid",
         c do
      id = c.worker["agent_id"]

      model =
        Enum.find(
          SalixAgent.Models.list(),
          &(&1["efforts"] not in [nil, []] and Map.has_key?(&1["routes"], "openrouter"))
        )

      assert {:ok, choices} = run(c, :model_choices, %{"agent_id" => id, "query" => model["id"]})
      assert choices["kinds"] == ["builtin", "catalog"]
      assert Enum.any?(choices["models"], &(&1["model"] == model["id"]))

      assert {:ok, %{"result" => "applied", "agent" => agent}} =
               run(c, :set_model, %{
                 "agent_id" => id,
                 "selection" => %{
                   "kind" => "catalog",
                   "model" => model["id"],
                   "allow_paid" => false,
                   "reasoning_effort" => hd(model["efforts"])
                 }
               })

      assert agent["model"]["model_id"] == model["id"]
      assert {:ok, llm} = SalixAgent.Templates.resolve_llm_for_agent(id)
      assert llm["model"] == model["id"]

      {:ok, profile} =
        SalixAgent.AccountPool.create(c.tenant, %{
          "credential_kind" => "provider_api_key",
          "source" => "openrouter",
          "api_key" => "sk-or-v1-0123456789abcdef"
        })

      assert {:ok, %{"profiles" => profiles}} = run(c, :model_choices, %{"agent_id" => id})
      assert %{"paid" => true} = Enum.find(profiles, &(&1["profile_id"] == profile["id"]))
      refute inspect(profiles) =~ "0123456789"

      assert {:ok, %{"agent" => agent}} =
               run(c, :set_model, %{
                 "agent_id" => id,
                 "selection" => %{
                   "kind" => "catalog",
                   "model" => model["id"],
                   "allow_paid" => false,
                   "profile_id" => profile["id"]
                 }
               })

      {:ok, template} = SalixAgent.Templates.get(agent["model"]["template_id"], c.tenant)
      assert template["provider_config"]["allow_paid"] == true
      assert template["provider_config"]["profile_id"] == profile["id"]

      assert {:ok, %{"agent" => %{"model" => %{"source" => source}}}} =
               run(c, :set_model, %{"agent_id" => id, "selection" => %{"kind" => "builtin"}})

      assert source in ["platform_default", "role_default"]

      assert {:error, %{"code" => "invalid_model_configuration"}} =
               run(c, :set_model, %{
                 "agent_id" => id,
                 "selection" => %{
                   "kind" => "catalog",
                   "model" => "no-such-model",
                   "allow_paid" => false
                 }
               })
    end

    test "runtime constraints are preserved", c do
      internal = c.worker["agent_id"]

      assert {:error, %{"code" => "invalid_arguments"}} =
               run(c, :set_model, %{
                 "agent_id" => internal,
                 "selection" => %{"kind" => "runtime", "model" => "gpt-5.5"}
               })

      pinned =
        compute!(c, %{"provider" => "codex", "model" => "gpt-5.5"})

      assert {:error, %{"code" => "runtime_model_pinned"}} =
               run(c, :set_model, %{
                 "agent_id" => pinned["agent_id"],
                 "selection" => %{"kind" => "runtime", "model" => "gpt-5.5"}
               })

      assert {:ok, %{"kinds" => [], "unsupported_reason" => reason}} =
               run(c, :model_choices, %{"agent_id" => pinned["agent_id"]})

      assert reason =~ "runtime binding"

      own_login = compute!(c, %{"provider" => "codex"})

      assert {:ok, %{"kinds" => ["builtin", "runtime"], "models" => [_ | _] = models}} =
               run(c, :model_choices, %{"agent_id" => own_login["agent_id"], "limit" => 50})

      runtime_model = hd(models)["model"]

      assert {:error, %{"code" => "invalid_arguments", "message" => message}} =
               run(c, :set_model, %{
                 "agent_id" => own_login["agent_id"],
                 "selection" => %{
                   "kind" => "catalog",
                   "model" => runtime_model,
                   "allow_paid" => false
                 }
               })

      assert message =~ "controlled by its runtime" or message =~ "own models"

      assert {:ok, %{"agent" => %{"model" => model}}} =
               run(c, :set_model, %{
                 "agent_id" => own_login["agent_id"],
                 "selection" => %{"kind" => "runtime", "model" => runtime_model}
               })

      assert model["source"] == "agent_config"
      assert model["model_id"] == runtime_model

      assert model["selection"] == %{
               "kind" => "runtime",
               "model" => runtime_model,
               "reasoning_effort" => nil
             }

      # Back to the runtime default: the builtin selection reads back everywhere.
      own_id = own_login["agent_id"]

      assert {:ok, %{"agent" => %{"model" => %{"selection" => %{"kind" => "builtin"}} = builtin}}} =
               run(c, :set_model, %{"agent_id" => own_id, "selection" => %{"kind" => "builtin"}})

      assert builtin["source"] == "runtime_default"

      assert {:ok, %{"agent" => %{"model" => %{"selection" => %{"kind" => "builtin"}}}}} =
               run(c, :get, %{"agent_id" => own_id})

      assert {:ok, %{"current" => %{"selection" => %{"kind" => "builtin"}}}} =
               run(c, :model_choices, %{"agent_id" => own_id})
    end
  end

  describe "skills" do
    test "a Worker-only skill is visible to that Worker alone and can be removed", c do
      id = c.worker["agent_id"]

      assert {:ok, %{"skill" => %{"skill_id" => "release-notes", "scope" => "worker"}}} =
               run(c, :skill_add, %{
                 "agent_id" => id,
                 "skill_id" => "release-notes",
                 "name" => "Release notes",
                 "description" => "Write release notes",
                 "content" => "# Release notes\n\nUse STE."
               })

      worker_ctx =
        SalixAgent.TestSupport.with_plugin_projection(%{
          tenant_id: c.tenant,
          group_id: c.group,
          agent_id: id
        })

      sibling_ctx = %{worker_ctx | agent_id: c.sibling["agent_id"]}
      router_ctx = %{worker_ctx | agent_id: c.router["agent_id"]}

      assert {:ok, %{"layer" => "agent"}} = SkillProjection.get_skill(worker_ctx, "release-notes")
      assert {:error, :not_found} = SkillProjection.get_skill(sibling_ctx, "release-notes")
      assert {:error, :not_found} = SkillProjection.get_skill(router_ctx, "release-notes")

      assert {:ok,
              %{
                "agent" => %{"configuration" => %{"skills" => [%{"skill_id" => "release-notes"}]}}
              }} =
               run(c, :get, %{"agent_id" => id})

      assert {:error, %{"code" => "skill_exists"}} =
               run(c, :skill_add, %{
                 "agent_id" => id,
                 "skill_id" => "release-notes",
                 "name" => "Other"
               })

      assert {:ok, %{"skills" => []}} =
               run(c, :skill_remove, %{"agent_id" => id, "skill_id" => "release-notes"})

      assert {:error, :not_found} = SkillProjection.get_skill(worker_ctx, "release-notes")

      assert {:error, %{"code" => "skill_not_found"}} =
               run(c, :skill_remove, %{"agent_id" => id, "skill_id" => "release-notes"})
    end
  end

  describe "shared connector access" do
    test "new Workers start with none, legacy Workers inherit, and grants are per account and Worker",
         c do
      # Default deny for a new Worker, inherited access for a legacy Worker.
      assert_raise RuntimeError, ~r/not found/, fn -> shared_execute(c.worker, "ca_mail") end

      assert_raise RuntimeError, ~r/connected_account_id is required/, fn ->
        shared_execute(c.worker, nil)
      end

      refute_received {:composio_execute, _, _, _}

      shared_execute(c.legacy, "ca_mail")
      assert_received {:composio_execute, _, _, [connected_account_id: "ca_mail"]}
      # Legacy Workers keep Composio's own account choice.
      shared_execute(c.legacy, nil)
      assert_received {:composio_execute, _, _, []}

      assert {:ok, %{"worker_default" => "none", "items" => items}} =
               run(c, :access_list, %{
                 "agent_id" => c.worker["agent_id"],
                 "class" => "composio_shared"
               })

      assert Enum.map(items, & &1["account"]["id"]) |> Enum.sort() == ["ca_cal", "ca_mail"]
      assert Enum.all?(items, &(&1["effective"] == false and &1["decision"] == "not_granted"))
      refute Jason.encode!(items) =~ @composio_key

      # Grant one account: that account only, that Worker only.
      grant = set!(c, c.worker, "composio_shared", "ca_mail", "allow")
      assert grant["account"]["effective"] == true
      assert grant["result"] == "applied"

      shared_execute(c.worker, "ca_mail")

      assert_received {:composio_execute, group, "GMAIL_FETCH_EMAILS",
                       [connected_account_id: "ca_mail"]}

      assert group == c.group
      assert_raise RuntimeError, ~r/not found/, fn -> shared_execute(c.worker, "ca_cal") end
      assert_raise RuntimeError, ~r/not found/, fn -> shared_execute(c.sibling, "ca_mail") end

      listed =
        SharedComposio.list_connections(%{}, %{agent_id: c.worker["agent_id"]}) |> Jason.decode!()

      assert Enum.map(listed["connections"], & &1["connected_account_id"]) == ["ca_mail"]

      # Cross-Group and unknown accounts cannot be referenced.
      for id <- ["ca_far", "ca_missing"] do
        assert {:error, %{"code" => "account_not_found"}} =
                 run(c, :access_set, %{
                   "agent_id" => c.worker["agent_id"],
                   "account" => %{"class" => "composio_shared", "id" => id},
                   "access" => "allow"
                 })
      end

      # Revoke: later dispatch is refused; the account stays for others.
      revoke = set!(c, c.worker, "composio_shared", "ca_mail", "default")
      assert revoke["account"]["effective"] == false
      assert_raise RuntimeError, ~r/not found/, fn -> shared_execute(c.worker, "ca_mail") end
      shared_execute(c.legacy, "ca_mail")
      assert_received {:composio_execute, _, _, [connected_account_id: "ca_mail"]}

      # An explicit deny overrides a legacy Worker's inherited access.
      set!(c, c.legacy, "composio_shared", "ca_mail", "deny")
      assert_raise RuntimeError, ~r/not found/, fn -> shared_execute(c.legacy, "ca_mail") end
      shared_execute(c.legacy, "ca_cal")
      assert_received {:composio_execute, _, _, [connected_account_id: "ca_cal"]}
      # Under a policy, the Worker must name an account it may use.
      assert_raise RuntimeError, ~r/connected_account_id is required/, fn ->
        shared_execute(c.legacy, nil)
      end

      # A tool restriction makes the account ineffective without changing the grant.
      set!(c, c.worker, "composio_shared", "ca_cal", "allow")

      run(c, :configure, %{
        "agent_id" => c.worker["agent_id"],
        "disabled_tools" => ["composio.execute"]
      })

      assert {:ok, %{"items" => items}} =
               run(c, :access_list, %{
                 "agent_id" => c.worker["agent_id"],
                 "class" => "composio_shared"
               })

      cal = Enum.find(items, &(&1["account"]["id"] == "ca_cal"))
      assert cal["access"] == "allow" and cal["effective"] == false
      assert cal["blocked_by"] == "disabled_tools"

      assert {:ok, %{"agent" => %{"configuration" => %{"connector_access" => access}}}} =
               run(c, :get, %{"agent_id" => c.worker["agent_id"]})

      assert access == %{
               "worker_default" => "none",
               "accounts" => [
                 %{"class" => "composio_shared", "id" => "ca_cal", "access" => "allow"}
               ]
             }
    end

    test "managed OAuth credentials are provisioned only for granted bindings", c do
      assert {:error, message} = oauth_env(c.worker, "work")
      assert message =~ "not granted"
      refute message =~ @secret_token

      assert {:ok, %{"GH" => @secret_token}} = oauth_env(c.legacy, "work")

      grant = set!(c, c.worker, "oauth", "oauth-gh", "allow")
      assert grant["account"]["effective"] == true
      refute Jason.encode!(grant) =~ @secret_token

      assert {:ok, %{"GH" => @secret_token}} = oauth_env(c.worker, "work")
      assert {:error, _} = oauth_env(c.worker, "personal")
      assert {:error, _} = oauth_env(c.sibling, "work")

      listed =
        SalixAgent.Tools.OAuth.list_oauth_credentials(%{}, %{agent_id: c.worker["agent_id"]})
        |> Jason.decode!()

      assert Enum.map(listed["credentials"], & &1["alias"]) == ["work"]

      set!(c, c.worker, "oauth", "oauth-gh", "deny")
      assert {:error, _} = oauth_env(c.worker, "work")
      assert {:ok, _} = oauth_env(c.legacy, "work")

      assert {:ok, %{"items" => items}} =
               run(c, :access_list, %{"agent_id" => c.worker["agent_id"], "class" => "oauth"})

      refute Jason.encode!(items) =~ @secret_token

      assert %{"access" => "deny", "effective" => false} =
               Enum.find(items, &(&1["account"]["id"] == "oauth-gh"))
    end

    test "personal Composio access stays a ComposioAccess grant of the owner's own account", c do
      exec = fn agent ->
        ComposioBroker.execute(
          %{
            "account_id" => "pa_notion",
            "tools" => [%{"tool_slug" => "NOTION_SEARCH", "arguments" => %{}}]
          },
          %{agent_id: agent["agent_id"], group_id: c.group}
        )
      end

      assert {:tool_failure, _, "composio_execution_unconfirmed", _, _, _} = exec.(c.worker)

      grant = set!(c, c.worker, "composio_personal", "pa_notion", "allow")
      assert grant["account"]["effective"] == true

      assert {:ok, %{"enabled" => true, "user_id" => "owner"}} =
               ComposioAccess.agent_account_grant(
                 c.tenant,
                 c.group,
                 c.worker["agent_id"],
                 "pa_notion"
               )

      exec.(c.worker)
      assert_received {:personal_execute, "owner", "pa_notion"}
      assert {:tool_failure, _, _, _, _, _} = exec.(c.sibling)

      assert {:error, %{"code" => "personal_access_is_grant_only"}} =
               run(c, :access_set, %{
                 "agent_id" => c.worker["agent_id"],
                 "account" => %{"class" => "composio_personal", "id" => "pa_notion"},
                 "access" => "deny"
               })

      revoke = set!(c, c.worker, "composio_personal", "pa_notion", "default")
      assert revoke["account"]["effective"] == false
      assert {:tool_failure, _, _, _, _, _} = exec.(c.worker)

      # Only the account's owner can grant it; the account stays connected.
      Application.put_env(:salix_agent, :test_members, ["owner"])
      assert {:ok, _} = ComposioAccess.account(c.tenant, c.group, "owner", "pa_notion")
    end
  end
end
