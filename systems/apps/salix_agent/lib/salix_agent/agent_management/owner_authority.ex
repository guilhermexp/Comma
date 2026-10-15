defmodule SalixAgent.AgentManagement.OwnerAuthority do
  @moduledoc """
  The person behind a privileged Router configuration request.

  The only identity source is the sealed `trusted_origin` of the exact source
  message this activation handles: an internal Comma message that ingress
  sealed as person-authored (`SalixIM.ProviderPrincipalRef`, `comma_user`).
  Worker reports, tool results, schedules, Loops, Slack/Feishu identities,
  system handoffs and model arguments never identify a person. The identity is
  then rechecked as the active owner of this Group's workspace through the
  product composition (`SalixAgent.AgentManagement.Ports.authorize_owner/2`).
  """

  alias SalixAgent.AgentManagement.Ports

  @doc "Return the current owner's user id for this Router scope."
  def current_owner(scope, ctx) do
    with {:ok, user_id} <- sealed_person(scope, ctx),
         :ok <- Ports.authorize_owner(scope, user_id) do
      {:ok, user_id}
    else
      {:error, :owner_unavailable} -> {:error, :owner_unavailable}
      {:error, :current_owner_request_required} = error -> error
      _ -> {:error, :owner_required}
    end
  end

  @doc "The sealed person of the current source, before the ownership recheck."
  def sealed_person(scope, ctx) do
    origin = value(ctx, :trusted_origin)

    with %{} <- origin,
         "internal" <- value(origin, "provider"),
         "user" <- value(origin, "source_actor_type"),
         nil <- value(origin, "task_schedule"),
         true <- command_integrity?(origin),
         true <- value(origin, "agent_group_id") == scope.group_id,
         %{} = ref <- value(origin, "principal_ref"),
         "comma_user" <- value(ref, "namespace"),
         true <- value(ref, "tenant_id") == scope.tenant_id,
         user_id when is_binary(user_id) and user_id != "" <- value(ref, "subject_id"),
         true <- current_source?(origin, ctx) do
      {:ok, user_id}
    else
      _ -> {:error, :current_owner_request_required}
    end
  end

  # A sealed integrity block, when present, must say a person authored it.
  defp command_integrity?(origin) do
    case value(origin, "ifc") do
      %{} = ifc -> is_nil(value(ifc, "integrity")) or value(ifc, "integrity") == "command"
      _ -> true
    end
  end

  # The runtime names the source it handles; it must be the sealed source.
  # A missing or empty source on either side is a stale or incomplete origin.
  defp current_source?(origin, ctx) do
    source = value(ctx, :source_message_id)
    sealed = value(origin, "source_message_id")
    is_binary(source) and source != "" and sealed == source
  end

  defp value(map, key) when is_map(map) and is_atom(key),
    do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp value(map, key) when is_map(map), do: SalixAgent.IFC.value(map, key)
  defp value(_, _), do: nil
end
