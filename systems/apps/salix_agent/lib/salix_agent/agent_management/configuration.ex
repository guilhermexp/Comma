defmodule SalixAgent.AgentManagement.Configuration do
  @moduledoc """
  Router commands that change an existing Worker's configuration on the
  current workspace owner's request: instructions, tool restrictions, cloud VM,
  model choice, Worker-only skills and connector account access.

  Every command reuses the existing owner: Agent configuration CAS
  (`SalixAgent.AgentControl`), `SalixAgent.AgentModelSelection`,
  `SalixAgent.SkillStore` and `SalixAgent.ConnectorAccess`, or
  `SalixAgent.ComposioGrants` for personal Composio accounts. The caller has
  already established the Router, the rollout gate and the owner identity.
  """

  alias SalixAgent.{AgentModelSelection, ComposioGrants, ConnectorAccess, Control}
  alias SalixAgent.{OAuthStore, PluginStore, SkillProjection, SkillStore}
  alias SalixAgent.AgentManagement.Projection

  @dynamic_mcp_tool ~r/^mcp\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  @composio_pages 5

  # ---- settings ----

  def configure(scope, record, args) do
    patch =
      %{}
      |> put_present("system_prompt", args["instructions"])
      |> put_present("disabled_tools", args["disabled_tools"])
      |> put_present("vm", args["vm"])

    with :ok <- known_tools(args["disabled_tools"]),
         {:ok, %{record: updated, result: result}} <-
           Control.configure_worker_settings(record["agent_id"], scope.tenant_id, patch) do
      {:ok,
       %{
         "result" => Atom.to_string(result),
         "agent" => Projection.detail(updated),
         "effect" =>
           "Applies from the Worker's next round or runtime tool call. Work already running is not interrupted."
       }}
    end
  end

  defp known_tools(nil), do: :ok

  defp known_tools(names) do
    registry = MapSet.new(SalixAgent.Tools.registry(), &elem(&1, 0))

    case Enum.reject(
           names,
           &(MapSet.member?(registry, &1) or Regex.match?(@dynamic_mcp_tool, &1))
         ) do
      [] -> :ok
      unknown -> {:error, {:unknown_tools, Enum.take(unknown, 10)}}
    end
  end

  # ---- model ----

  def model_choices(scope, record, args) do
    kinds = AgentModelSelection.kinds(record)
    query = String.downcase(args["query"] || "")
    limit = args["limit"] || 20
    offset = cursor_offset(args["cursor"])

    models =
      SalixAgent.Models.list()
      |> Enum.filter(&model_for_kinds?(&1, kinds, record))
      |> Enum.filter(fn model ->
        query == "" or String.contains?(String.downcase(model["id"]), query) or
          String.contains?(String.downcase(model["name"] || ""), query)
      end)

    page = models |> Enum.drop(offset) |> Enum.take(limit)

    with {:ok, profiles} <- profiles(scope, kinds) do
      {:ok,
       %{
         "agent_id" => record["agent_id"],
         "current" => Projection.detail(record)["model"],
         "kinds" => kinds,
         "unsupported_reason" =>
           if(kinds == [],
             do:
               "This Worker's runtime binding sets its model. Existing tools cannot change a connected runtime's model."
           ),
         "models" => Enum.map(page, &public_model(&1, record)),
         "profiles" => profiles,
         "next_cursor" =>
           if(offset + limit < length(models), do: Integer.to_string(offset + limit))
       }}
    end
  end

  defp model_for_kinds?(model, kinds, record) do
    cond do
      "catalog" in kinds -> true
      "runtime" in kinds -> Map.has_key?(model["routes"] || %{}, runtime_provider(record))
      true -> false
    end
  end

  defp public_model(model, record) do
    %{
      "model" => model["id"],
      "name" => model["name"],
      "vendor" => model["vendor"],
      "efforts" => model["efforts"] || [],
      "sources" => Map.keys(model["routes"] || %{}) |> Enum.sort()
    }
    |> then(fn item ->
      if runtime_provider(record),
        do: Map.put(item, "runtime", runtime_provider(record)),
        else: item
    end)
  end

  defp runtime_provider(record),
    do: get_in(record, ["runtime_config", "runtime_spec", "provider"])

  # Profiles are the tenant's provider accounts: subscription plans and API keys.
  # Only identifiers and labels are returned; credentials never leave the store.
  defp profiles(scope, kinds) do
    if "catalog" in kinds do
      case SalixAgent.AccountPool.list(scope.tenant_id, "", :all) do
        # One bounded page (25 Profiles) of the tenant's accounts.
        {:ok, %{"accounts" => accounts}} ->
          {:ok,
           Enum.map(accounts, fn profile ->
             %{
               "profile_id" => profile["id"],
               "name" => profile["name"],
               "source" => profile["source"],
               "credential_kind" => profile["credential_kind"],
               "status" => profile["status"],
               "paid" => profile["credential_kind"] == "provider_api_key"
             }
           end)}

        {:ok, _} ->
          {:ok, []}

        _ ->
          {:error, :read_unavailable}
      end
    else
      {:ok, []}
    end
  end

  def set_model(scope, record, %{"selection" => selection}) do
    with {:ok, updated} <- AgentModelSelection.apply(record, scope.tenant_id, selection) do
      {:ok,
       %{
         "result" =>
           if(updated["template_id"] == record["template_id"], do: "unchanged", else: "applied"),
         "agent" => Projection.detail(updated),
         "effect" => model_effect(updated)
       }}
    end
  end

  defp model_effect(record) do
    if Control.external_runtime?(record),
      do:
        "The runtime reads this choice when it next dispatches, including later turns of its existing Sessions. A turn already running keeps its model.",
      else: "Applies from the Worker's next round. A round already running keeps its model."
  end

  # ---- skills ----

  def skill_add(scope, record, args, ctx) do
    worker_ctx = worker_ctx(scope, record, ctx)

    with {:ok, source} <- skill_source(ctx, args["source_skill_id"]),
         name = args["name"] || (source && source["name"]),
         false <- is_nil(name) or SkillProjection.duplicate?(worker_ctx, args["skill_id"], name),
         {:ok, event} <-
           SkillStore.prepare_agent_create(
             router_ctx(scope, ctx),
             record["agent_id"],
             source,
             Map.take(args, ~w(skill_id name description content)) |> Map.put("name", name)
           ),
         {:ok, _} <-
           SkillStore.commit_operation(operation_id(ctx, "skill_add"), :ok, [event]) do
      {:ok,
       %{
         "result" => "applied",
         "agent_id" => record["agent_id"],
         "skill" => %{
           "skill_id" => event["skill"]["skill_id"],
           "name" => event["skill"]["name"],
           "scope" => "worker"
         },
         "skills" => worker_skills(record),
         "effect" => "Visible to this Worker only, from its next round or runtime dispatch."
       }}
    else
      true -> {:error, :skill_exists}
      {:error, :not_found} -> {:error, :skill_not_found}
      {:error, reason} when is_binary(reason) -> {:error, {:skill_rejected, reason}}
      error -> error
    end
  end

  def skill_remove(scope, record, %{"skill_id" => skill_id}, ctx, owner) do
    actor = %{"type" => "user", "user_id" => owner, "request_id" => operation_id(ctx, "skill")}

    with {:ok, event} <-
           SkillStore.prepare_agent_delete(
             router_ctx(scope, ctx),
             record["agent_id"],
             skill_id,
             actor
           ),
         {:ok, _} <-
           SkillStore.commit_operation(operation_id(ctx, "skill_remove"), :ok, [event]) do
      {:ok,
       %{
         "result" => "applied",
         "agent_id" => record["agent_id"],
         "skill_id" => skill_id,
         "skills" => worker_skills(record)
       }}
    else
      {:error, "skill not found"} -> {:error, :skill_not_found}
      {:error, reason} when is_binary(reason) -> {:error, {:skill_rejected, reason}}
      error -> error
    end
  end

  @doc "Skills in the Worker's own layer; Group and platform skills stay shared."
  def worker_skills(record) do
    case SkillStore.read_scope(:agent, record["agent_id"]) do
      {:ok, state} ->
        state.skills
        |> Map.values()
        |> Enum.map(&%{"skill_id" => &1["skill_id"], "name" => &1["name"]})
        |> Enum.sort_by(& &1["skill_id"])

      _ ->
        nil
    end
  end

  defp skill_source(_ctx, nil), do: {:ok, nil}

  defp skill_source(ctx, id) do
    with {:ok, skill} <- SkillProjection.get_skill(ctx, id), do: {:ok, skill}
  end

  # Skill visibility follows the Group's plugin projection, as in a real round.
  defp worker_ctx(scope, record, ctx) do
    projection =
      ctx[:plugin_projection] ||
        case PluginStore.runtime_projection(%{
               "tenant_id" => scope.tenant_id,
               "group_id" => scope.group_id
             }) do
          {:ok, projection} -> projection
          _ -> nil
        end

    %{tenant_id: scope.tenant_id, group_id: scope.group_id, agent_id: record["agent_id"]}
    |> then(&if(projection, do: Map.put(&1, :plugin_projection, projection), else: &1))
  end

  defp router_ctx(scope, ctx),
    do: %{tenant_id: scope.tenant_id, group_id: scope.group_id, agent_id: ctx[:agent_id]}

  defp operation_id(ctx, operation),
    do:
      Enum.join(
        ["router-config", operation, ctx[:agent_id], ctx[:session_id], ctx[:tool_call_id]],
        ":"
      )

  # ---- connector accounts ----

  def access_list(scope, record, args, ctx, owner) do
    case args["class"] do
      "composio_personal" ->
        with {:ok, page} <-
               ComposioGrants.accounts(gscope(scope), owner, record["agent_id"], args["cursor"]) do
          {:ok, access_page(record, "composio_personal", page["items"], page["next_cursor"])}
        end

      "composio_shared" ->
        with {:ok, accounts} <- shared_composio_accounts(scope) do
          {:ok,
           access_page(
             record,
             "composio_shared",
             Enum.map(accounts, &shared_item(record, &1)),
             nil
           )}
        end

      "oauth" ->
        with {:ok, bindings} <- OAuthStore.bindings_for_group(scope.group_id) do
          {:ok, access_page(record, "oauth", Enum.map(bindings, &oauth_item(record, &1)), nil)}
        end

      "mcp" ->
        with {:ok, bindings} <- mcp_bindings(ctx) do
          items = Enum.map(bindings, &mcp_item(scope, record, &1))
          {:ok, access_page(record, "mcp", items, nil)}
        end

      "plugin" ->
        with {:ok, plugins} <- plugins(scope, ctx) do
          {:ok, access_page(record, "plugin", Enum.map(plugins, &plugin_item(record, &1)), nil)}
        end
    end
  end

  defp access_page(record, class, items, next_cursor) do
    %{
      "agent_id" => record["agent_id"],
      "class" => class,
      "worker_default" => worker_default(record),
      "items" => items,
      "next_cursor" => next_cursor
    }
  end

  defp worker_default(%{"connector_access" => %{"default" => "none"}}), do: "none"
  defp worker_default(_), do: "inherit"

  def access_set(scope, record, %{"account" => account, "access" => access}, ctx, owner) do
    case account do
      %{"class" => "composio_personal", "id" => id} ->
        if access == "deny",
          do: {:error, :personal_access_is_grant_only},
          else: personal_set(scope, record, owner, id, access == "allow")

      %{"class" => class, "id" => id} ->
        with :ok <- writable_access_target(record),
             {:ok, item_fun} <- existing_account(scope, ctx, class, id),
             ref = ConnectorAccess.ref(class, id),
             {:ok, %{record: updated, result: result}} <-
               Control.configure_connector_access(
                 record["agent_id"],
                 scope.tenant_id,
                 ref,
                 access
               ) do
          {:ok,
           %{
             "result" => Atom.to_string(result),
             "agent_id" => record["agent_id"],
             "worker_default" => worker_default(updated),
             "account" => item_fun.(updated),
             "effect" => access_effect(access)
           }}
        end
    end
  end

  defp personal_set(scope, record, owner, id, granted?) do
    with :ok <- writable_access_target(record),
         {:ok, item} <- ComposioGrants.set(gscope(scope), owner, record["agent_id"], id, granted?) do
      {:ok,
       %{
         "result" => "applied",
         "agent_id" => record["agent_id"],
         "account" => item,
         "effect" => access_effect(if(granted?, do: "allow", else: "default"))
       }}
    end
  end

  defp writable_access_target(record) do
    cond do
      Control.permanently_archived?(record) -> {:error, :agent_permanently_archived}
      Control.archived?(record) -> {:error, :agent_archived}
      true -> :ok
    end
  end

  defp access_effect("allow"),
    do:
      "New Comma-mediated calls by this Worker can use the account, subject to its status and tool restrictions."

  defp access_effect(_),
    do:
      "New Comma-mediated calls by this Worker cannot use the account unless its Worker default allows it. The account stays connected for other Agents. Earlier provider effects and credentials already copied outside Comma are not retracted."

  # Resolve the exact account in this Group before referencing it.
  defp existing_account(scope, _ctx, "composio_shared", id) do
    with {:ok, accounts} <- shared_composio_accounts(scope),
         %{} = account <- Enum.find(accounts, &(to_string(&1["id"]) == id)) do
      {:ok, &shared_item(&1, account)}
    else
      nil -> {:error, :account_not_found}
      error -> error
    end
  end

  defp existing_account(scope, _ctx, "oauth", id) do
    with {:ok, bindings} <- OAuthStore.bindings_for_group(scope.group_id),
         %{} = binding <- Enum.find(bindings, &(&1["binding_id"] == id)) do
      {:ok, &oauth_item(&1, binding)}
    else
      nil -> {:error, :account_not_found}
      error -> error
    end
  end

  defp existing_account(scope, ctx, "mcp", id) do
    with {:ok, bindings} <- mcp_bindings(ctx),
         %{} = binding <- Enum.find(bindings, &(&1["binding_id"] == id)) do
      {:ok, &mcp_item(scope, &1, binding)}
    else
      nil -> {:error, :account_not_found}
      error -> error
    end
  end

  defp existing_account(_, _, _, _), do: {:error, :invalid_arguments}

  defp shared_composio_accounts(scope) do
    with {:ok, settings} <- composio_settings(scope.tenant_id),
         {:ok, items} <-
           composio_client().list_connected_accounts_all(settings, scope.group_id,
             page_limit: 100,
             max_pages: @composio_pages
           ) do
      {:ok, Enum.filter(items, &(to_string(&1["user_id"] || scope.group_id) == scope.group_id))}
    else
      {:error, :composio_not_configured} -> {:ok, []}
      {:error, :not_configured} -> {:ok, []}
      {:error, _} -> {:error, :connector_read_unavailable}
    end
  end

  defp composio_settings(tenant_id), do: SalixAgent.ComposioStore.settings(tenant_id)

  defp shared_item(record, account) do
    id = to_string(account["id"])
    status = to_string(account["status"] || "")
    toolkit = get_in(account, ["toolkit", "slug"]) || account["toolkit"]

    item(
      record,
      "composio_shared",
      id,
      toolkit,
      %{"toolkit" => toolkit, "status" => status},
      status == "ACTIVE",
      tool_open?(record, "composio.execute")
    )
  end

  defp oauth_item(record, binding) do
    enabled = Map.get(binding, "enabled", true) != false

    item(
      record,
      "oauth",
      binding["binding_id"],
      binding["alias"],
      %{"provider" => binding["provider"], "alias" => binding["alias"], "enabled" => enabled},
      enabled,
      true
    )
    |> Map.put(
      "note",
      "Token health and scopes are checked when a tool resolves the credential."
    )
  end

  defp mcp_item(scope, record, binding) do
    enabled = binding["enabled"] != false
    status = get_in(binding, ["connection", "status"]) || binding["status"]
    oauth = fn -> OAuthStore.bindings_for_group(scope.group_id) end

    dependencies =
      case ConnectorAccess.mcp_oauth_binding_ids(binding, oauth) do
        {:ok, ids} -> Enum.map(ids, &%{"class" => "oauth", "id" => &1})
        _ -> :unresolved
      end

    base =
      item(
        record,
        "mcp",
        binding["binding_id"],
        binding["alias"],
        %{"alias" => binding["alias"], "enabled" => enabled, "status" => status},
        enabled and dependencies != :unresolved,
        true
      )

    base
    |> Map.put("requires", if(dependencies == :unresolved, do: [], else: dependencies))
    |> Map.update!("effective", fn effective ->
      effective and ConnectorAccess.mcp_allowed?(record, binding, oauth)
    end)
  end

  defp item(record, class, id, name, details, account_usable, tool_open) do
    {decision, reason} = ConnectorAccess.decision(record, class, id)

    %{
      "account" => %{"class" => class, "id" => id},
      "name" => name,
      "access" => explicit(record, class, id),
      "decision" => Atom.to_string(reason),
      "effective" => decision == :allow and account_usable and tool_open and visible?(record)
    }
    |> Map.merge(details)
    |> then(fn item ->
      if tool_open, do: item, else: Map.put(item, "blocked_by", "disabled_tools")
    end)
  end

  defp explicit(record, class, id),
    do:
      get_in(record, ["connector_access", "accounts", ConnectorAccess.ref(class, id)]) ||
        "default"

  defp visible?(record), do: not Control.archived?(record)

  defp tool_open?(record, tool) do
    disabled = MapSet.new(record["disabled_tools"] || [])

    not Enum.any?(
      SalixAgent.ToolPolicy.tool_permission_names(tool),
      &MapSet.member?(disabled, &1)
    )
  end

  defp mcp_bindings(ctx) do
    case Application.get_env(:salix_agent, :mcp_provider_mod) do
      nil ->
        {:ok, []}

      mod ->
        case mod.list_bindings(ctx[:agent_id]) do
          {:ok, bindings} -> {:ok, bindings}
          _ -> {:error, :connector_read_unavailable}
        end
    end
  end

  # A plugin owns no access. Its MCP bindings, managed OAuth bindings and
  # Composio toolkits are resolved to the accounts that carry the access.
  defp plugins(scope, ctx) do
    with {:ok, definitions} <- PluginStore.list_definitions(scope.tenant_id, scope.group_id),
         {:ok, enablements} <- PluginStore.list_group_enablements(scope.tenant_id, scope.group_id),
         {:ok, mcp} <- mcp_bindings(ctx),
         {:ok, oauth} <- OAuthStore.bindings_for_group(scope.group_id) do
      enabled = MapSet.new(for e <- enablements, e["enabled"] != false, do: e["plugin_id"])

      {:ok,
       definitions
       |> Enum.filter(&MapSet.member?(enabled, &1["plugin_id"]))
       |> Enum.map(&plugin_accounts(&1, mcp, oauth, scope))}
    else
      {:error, :plugin_store_not_configured} -> {:ok, []}
      {:error, _} -> {:error, :connector_read_unavailable}
    end
  end

  defp plugin_accounts(definition, mcp, oauth, scope) do
    refs = definition["refs"] || %{}
    setup = definition["setup_status"] || %{}

    mcp_matches =
      (List.wrap(refs["mcp_refs"]) ++ List.wrap(setup["mcps"]))
      |> Enum.flat_map(fn ref ->
        {binding_id, mcp_id, alias_} =
          case ref do
            ref when is_binary(ref) -> {ref, ref, nil}
            %{} -> {ref["binding_id"], ref["mcp_id"], ref["alias"]}
            _ -> {nil, nil, nil}
          end

        Enum.filter(mcp, fn b ->
          (binding_id && b["binding_id"] == binding_id) || (alias_ && b["alias"] == alias_) ||
            (mcp_id && b["mcp_id"] == mcp_id)
        end)
      end)
      |> Enum.uniq_by(& &1["binding_id"])

    oauth_ids =
      List.wrap(setup["connections"])
      |> Enum.filter(&(&1["kind"] == "managed_oauth"))
      |> Enum.flat_map(fn c ->
        oauth
        |> Enum.filter(&(&1["provider"] == c["provider"] and &1["alias"] == c["alias"]))
        |> Enum.map(& &1["binding_id"])
      end)

    mcp_oauth =
      Enum.flat_map(mcp_matches, fn b ->
        case ConnectorAccess.mcp_oauth_binding_ids(b, fn -> {:ok, oauth} end) do
          {:ok, ids} -> ids
          _ -> []
        end
      end)

    toolkits =
      List.wrap(setup["connections"])
      |> Enum.filter(&(&1["kind"] == "composio"))
      |> Enum.map(&(&1["toolkit"] || &1["provider"]))
      |> Enum.reject(&is_nil/1)

    %{
      definition: definition,
      scope: scope,
      accounts:
        Enum.map(mcp_matches, &{"mcp", &1["binding_id"]}) ++
          Enum.map(Enum.uniq(oauth_ids ++ mcp_oauth), &{"oauth", &1}),
      composio_toolkits: Enum.uniq(toolkits)
    }
  end

  defp plugin_item(record, %{definition: definition, accounts: accounts} = plugin) do
    items =
      Enum.map(accounts, fn {class, id} ->
        %{
          "account" => %{"class" => class, "id" => id},
          "access" => explicit(record, class, id),
          "allowed" => ConnectorAccess.allowed?(record, class, id)
        }
      end)

    %{
      "plugin_id" => definition["plugin_id"],
      "name" => definition["name"] || definition["plugin_id"],
      "accounts" => items,
      "composio_toolkits" => plugin.composio_toolkits,
      "effective" => items != [] and Enum.all?(items, & &1["allowed"]),
      "note" =>
        "Grant or deny each listed account with agent.access_set. Composio toolkits resolve to composio_shared accounts of that toolkit."
    }
  end

  defp gscope(scope), do: %{tenant_id: scope.tenant_id, group_id: scope.group_id}

  defp composio_client,
    do: Application.get_env(:salix_agent, :composio_client_mod, SalixStore.Composio)

  defp cursor_offset(nil), do: 0

  defp cursor_offset(cursor) do
    case Integer.parse(cursor) do
      {n, ""} when n >= 0 and n < 10_000 -> n
      _ -> 0
    end
  end

  defp put_present(map, _key, nil), do: map
  defp put_present(map, key, value), do: Map.put(map, key, value)
end
