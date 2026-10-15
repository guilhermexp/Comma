defmodule SalixAgent.ConnectorAccess do
  @moduledoc """
  Per-Worker access to the Group's shared connector accounts.

  The policy is a field of the Agent configuration record (`connector_access`)
  and changes only at that record's CAS (`SalixAgent.AgentControl`). It names
  existing accounts by scoped canonical reference and never copies a credential:

    * `composio_shared:<connected_account_id>` - a Group Composio account;
    * `oauth:<binding_id>` - a managed OAuth binding of the Group;
    * `mcp:<binding_id>` - an MCP binding of the Group.

  Personal Composio accounts stay with `SalixStore.ComposioAccess` grants.
  Plugins have no access of their own: they resolve to the MCP, OAuth and
  Composio accounts underneath. Device-owned runtime logins follow the Worker's
  runtime binding.

  A Worker record without the field keeps its shared access (`inherit`): it
  predates this policy, or its Group belongs to a product without an owner grant
  path. Every Worker created afterwards in a Comma workspace Group starts with
  `none`. An inspector Worker's operator-pinned Composio accounts
  (`SalixAgent.InspectorPolicy`) are allowed unless explicitly denied.
  An explicit `deny` overrides inheritance; an explicit `allow` grants exactly
  one account. Routers and other roles keep their Group access.

  Decisions read the current record at the point of use, so revocation stops
  later dispatch and credential resolution. It cannot retract provider effects
  or credentials already copied out of a Comma-managed path.
  """

  alias SalixAgent.Control

  @classes ~w(composio_shared oauth mcp)
  @accesses ~w(allow deny)
  @max_accounts 500
  @id_re ~r/^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,255}$/

  def classes, do: @classes

  @doc "The policy every Worker created after this contract starts with."
  def new_worker_policy, do: %{"default" => "none", "accounts" => %{}}

  def ref(class, id) when class in @classes and is_binary(id), do: class <> ":" <> id

  def parse_ref(ref) when is_binary(ref) do
    with [class, id] <- String.split(ref, ":", parts: 2),
         true <- class in @classes and Regex.match?(@id_re, id) do
      {:ok, class, id}
    else
      _ -> {:error, :invalid_account_ref}
    end
  end

  def parse_ref(_), do: {:error, :invalid_account_ref}

  def valid_id?(id) when is_binary(id), do: Regex.match?(@id_re, id)
  def valid_id?(_), do: false

  @doc "Validate a stored policy. `nil` is the legacy inherit state."
  def validate(nil), do: :ok

  def validate(%{"default" => default, "accounts" => accounts} = policy)
      when default in ~w(inherit none) and is_map(accounts) and map_size(policy) == 2 do
    if map_size(accounts) <= @max_accounts and
         Enum.all?(accounts, fn {ref, access} ->
           access in @accesses and match?({:ok, _, _}, parse_ref(ref))
         end),
       do: :ok,
       else: {:error, {:bad_request, "connector_access is invalid"}}
  end

  def validate(_), do: {:error, {:bad_request, "connector_access is invalid"}}

  @doc """
  Apply one account change. `default` removes the explicit entry, so the
  account follows the Worker default again. A legacy record keeps `inherit`.
  """
  def put(record, ref, access) when access in ~w(allow deny default) do
    with {:ok, _, _} <- parse_ref(ref) do
      policy = record["connector_access"] || %{"default" => "inherit", "accounts" => %{}}

      accounts =
        if access == "default",
          do: Map.delete(policy["accounts"], ref),
          else: Map.put(policy["accounts"], ref, access)

      if map_size(accounts) > @max_accounts,
        do: {:error, :too_many_account_entries},
        else: {:ok, %{policy | "accounts" => accounts}}
    end
  end

  def put(_, _, _), do: {:error, :invalid_arguments}

  @doc "Whether this Agent record follows the per-account policy at all."
  def restricted?(%{"role" => "worker", "connector_access" => %{}}), do: true
  def restricted?(_), do: false

  @doc "The effective policy decision for one account, before account state."
  def decision(%{"role" => "worker"} = record, class, id) when class in @classes,
    do: policy_decision(record, class, id)

  def decision(%{} = _record, class, _id) when class in @classes, do: {:allow, :role}
  def decision(_, _, _), do: {:deny, :unknown_agent}

  defp inspector_pinned?(record, "composio_shared", id) do
    accounts = get_in(record, ["inspector_policy", "composio_accounts"])
    is_map(accounts) and to_string(id) in Map.values(accounts)
  end

  defp inspector_pinned?(_record, _class, _id), do: false

  defp policy_decision(record, class, id) do
    case record["connector_access"] do
      nil ->
        {:allow, :legacy_inherit}

      %{"accounts" => accounts, "default" => default} ->
        case Map.get(accounts, ref(class, to_string(id))) do
          "allow" ->
            {:allow, :granted}

          "deny" ->
            {:deny, :denied}

          _ when default == "inherit" ->
            {:allow, :inherited}

          _ ->
            if inspector_pinned?(record, class, id),
              do: {:allow, :inspector_policy},
              else: {:deny, :not_granted}
        end

      _ ->
        {:deny, :invalid_policy}
    end
  end

  def allowed?(record, class, id) when is_map(record),
    do: match?({:allow, _}, decision(record, class, id))

  @doc "Read the current Agent record and decide. Unknown Agents are denied."
  def agent_allowed?(agent_id, class, id) when is_binary(agent_id) do
    case Control.get_record(agent_id) do
      {:ok, record} -> allowed?(record, class, id)
      _ -> false
    end
  end

  def agent_allowed?(_, _, _), do: false

  @doc """
  MCP use needs the binding and every managed OAuth binding it carries.
  `oauth_bindings` lazily lists the Group's OAuth bindings for references that
  name a provider and alias rather than a binding id.
  """
  def mcp_allowed?(record, binding, oauth_bindings \\ fn -> {:ok, []} end) do
    # Routers and legacy Workers without a policy keep Group access.
    not restricted?(record) or mcp_restricted_allowed?(record, binding, oauth_bindings)
  end

  defp mcp_restricted_allowed?(record, binding, oauth_bindings) do
    allowed?(record, "mcp", binding["binding_id"]) and
      case mcp_oauth_binding_ids(binding, oauth_bindings) do
        {:ok, ids} -> Enum.all?(ids, &allowed?(record, "oauth", &1))
        _ -> false
      end
  end

  @doc "Managed OAuth binding ids underneath one MCP binding."
  def mcp_oauth_binding_ids(binding, oauth_bindings) do
    refs = Map.values(binding["oauth_binding_refs"] || %{})
    direct = Enum.flat_map(refs, &List.wrap(text(&1["binding_id"])))
    remote = List.wrap(text(binding["remote_oauth_binding_id"]))
    by_alias = Enum.filter(refs, &is_nil(text(&1["binding_id"])))

    if by_alias == [] do
      {:ok, Enum.uniq(direct ++ remote)}
    else
      with {:ok, bindings} <- oauth_bindings.() do
        resolved =
          Enum.map(by_alias, fn ref ->
            Enum.find_value(bindings, fn b ->
              (b["provider"] == ref["provider"] and b["alias"] == ref["alias"]) &&
                b["binding_id"]
            end)
          end)

        if Enum.all?(resolved, &is_binary/1),
          do: {:ok, Enum.uniq(direct ++ remote ++ resolved)},
          else: {:error, :unresolved_oauth_binding}
      end
    end
  end

  defp text(value) when is_binary(value) and value != "", do: value
  defp text(_), do: nil
end
