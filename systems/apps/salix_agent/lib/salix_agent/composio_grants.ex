defmodule SalixAgent.ComposioGrants do
  @moduledoc """
  Personal Composio account access for the Router's Worker configuration tools.

  It writes the same `SalixStore.ComposioAccess.grant/6` record as the Grant
  control in Comma's Composio settings. Callers supply the owner identity from
  `SalixAgent.AgentManagement.OwnerAuthority`; this module never derives it.
  The owner must still pass the Composio membership check and own the account.
  `usable` is the broker's own execution decision for the Agent, not a guess
  from the account status.
  """

  alias SalixStore.ComposioAccess, as: Access

  @doc "One page of the owner's personal accounts with this Agent's grant state."
  def accounts(scope, owner, agent_id, cursor) do
    with :ok <- transport().authorize_member(scope.tenant_id, scope.group_id, owner),
         {:ok, page} <- Access.accounts(scope.tenant_id, scope.group_id, owner, cursor) do
      items =
        page["items"]
        |> Enum.filter(&is_binary(&1["id"]))
        |> Enum.map(&item(scope, owner, agent_id, &1))

      {:ok, %{"items" => items, "next_cursor" => page["next_cursor"]}}
    end
  end

  @doc "Grant or revoke one personal account for one Agent; returns the effective state."
  def set(scope, owner, agent_id, account_id, granted?) when is_boolean(granted?) do
    with :ok <- transport().authorize_member(scope.tenant_id, scope.group_id, owner),
         {:ok, account} <- owned_account(scope, owner, account_id),
         {:ok, _grant} <-
           Access.grant(scope.tenant_id, scope.group_id, owner, account_id, agent_id, granted?) do
      {:ok, item(scope, owner, agent_id, account)}
    end
  end

  defp owned_account(scope, owner, id) do
    case Access.account(scope.tenant_id, scope.group_id, owner, id) do
      {:ok, %{"user_id" => ^owner} = account} -> {:ok, account}
      {:ok, _} -> {:error, :account_not_found}
      {:error, :not_found} -> {:error, :account_not_found}
      error -> error
    end
  end

  defp item(scope, owner, agent_id, account) do
    granted =
      case Access.agent_account_grant(scope.tenant_id, scope.group_id, agent_id, account["id"]) do
        {:ok, %{"user_id" => ^owner, "enabled" => true}} -> true
        _ -> false
      end

    %{
      "account" => %{"class" => "composio_personal", "id" => account["id"]},
      "name" => account["name"],
      "toolkit" => account["toolkit"],
      "status" => account["status"],
      "enabled" => account["enabled"] == true,
      "access" => if(granted, do: "allow", else: "default"),
      "effective" => granted and usable?(scope, owner, agent_id, account["id"])
    }
  end

  # The same decision ComposioBroker makes before discovery and execution.
  defp usable?(scope, owner, agent_id, account_id) do
    transport().authorize_member(scope.tenant_id, scope.group_id, owner) == :ok and
      match?(
        {:ok, _},
        Access.authorize(scope.tenant_id, scope.group_id, agent_id, owner, account_id)
      )
  end

  defp transport, do: Application.fetch_env!(:salix_agent, :personal_composio_transport)
end
