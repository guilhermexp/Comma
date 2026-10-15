defmodule SalixVoice.CodexAccounts do
  @moduledoc "AccountPool access for subscription calls. No credentials cross the voice API."

  def impl, do: Application.get_env(:salix_voice, :codex_accounts_mod, __MODULE__)

  def select(tenant) do
    case SalixAgent.SubscriptionStore.runtime_candidates(tenant, "codex") do
      {:ok, [id | _]} -> {:ok, id}
      {:ok, []} -> {:error, :codex_account_required}
      _ -> {:error, :subscription_access_unavailable}
    end
  end

  def access(tenant, id, rejected_revision),
    do: SalixAgent.AccountPool.codex_access(tenant, id, rejected_revision)
end
