defmodule SalixAgent.AgentManagement.Ports do
  @moduledoc "Product scope, defaults and existing-target discovery supplied by the composition root."

  @callback project_id(map()) :: {:ok, String.t()} | {:error, term()}
  @callback connected_target(String.t(), map()) :: {:ok, map()} | {:error, term()}
  # Copy the tenant choice; nil means follow the platform default.
  @callback worker_template(map()) :: {:ok, String.t() | nil} | {:error, term()}
  @callback page_targets(map(), map()) :: {:ok, map()} | {:error, term()}
  # Recheck that a sealed person identity still owns the product workspace of
  # this exact Group. Fail closed when the product has no owner concept.
  @callback authorize_owner(map(), String.t()) :: :ok | {:error, term()}

  def project_id(scope), do: impl().project_id(scope)
  def connected_target(id, scope), do: impl().connected_target(id, scope)
  def worker_template(scope), do: impl().worker_template(scope)
  def page_targets(caller, args), do: impl().page_targets(caller, args)
  def authorize_owner(scope, user_id), do: impl().authorize_owner(scope, user_id)
  defp impl, do: Application.get_env(:salix_agent, :agent_management_ports, __MODULE__.Standalone)

  defmodule Standalone do
    @moduledoc "Explicit Salix-only composition used when no product adapter is installed."
    @behaviour SalixAgent.AgentManagement.Ports

    def project_id(_), do: {:error, :target_not_found}

    def connected_target(_, _), do: {:error, :target_unavailable}
    def page_targets(_, _), do: {:error, :target_unavailable}
    def authorize_owner(_, _), do: {:error, :owner_unavailable}

    def worker_template(scope) do
      SalixAgent.AgentDefaults.creation_template("worker", scope.tenant_id)
    end
  end
end
