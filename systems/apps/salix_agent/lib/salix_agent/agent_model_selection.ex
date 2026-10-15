defmodule SalixAgent.AgentModelSelection do
  @moduledoc """
  One Agent's model choice: Comma's built-in default, a catalog model, or (for
  a Codex or Claude Code compute Worker) a model its runtime runs.

  The choice is the Agent's `template_id`. Catalog and runtime choices reuse or
  create a private template under the tenant catalog lock
  (`SalixAgent.Templates`); a template the Agent no longer uses is released.
  Comma's settings page and the Router's configuration tool share this owner,
  so validation, Profile rules and runtime constraints cannot diverge.
  """

  alias SalixAgent.{Control, Templates}

  @doc "Apply a selection to an existing Agent record. Returns the updated record."
  def apply(agent, tenant_id, %{"kind" => "runtime"} = selection) do
    with {:ok, model, effort} <- runtime_selection(selection),
         {:ok, provider} <- runtime_model_writable(agent),
         {:ok, updated} <- assign_runtime_choice(agent, provider, model, effort, tenant_id) do
      release_replaced(agent, updated, tenant_id)
      {:ok, updated}
    else
      {:error, :invalid_model_configuration} -> {:error, :invalid_runtime_model}
      error -> error
    end
  end

  def apply(agent, tenant_id, selection) do
    with {:ok, resolve} <- selection_template(selection),
         :ok <- template_model_writable(agent),
         :ok <- own_login_choice_allowed(agent, selection["kind"] == "builtin"),
         {:ok, updated} <- assign_selection(agent, resolve, tenant_id) do
      release_replaced(agent, updated, tenant_id)
      {:ok, updated}
    end
  end

  @doc "The selection kinds this Agent's runtime accepts."
  def kinds(agent) do
    cond do
      match?({:ok, _}, runtime_model_writable(agent)) -> ~w(builtin runtime)
      template_model_writable(agent) == :ok -> ~w(builtin catalog)
      true -> []
    end
  end

  @doc "Runtime binding model fields that override the Agent template, or nil."
  def runtime_model_settings(%{"runtime_config" => %{"kind" => kind} = runtime})
      when kind in ~w(external connected_runtime),
      do: runtime

  def runtime_model_settings(%{
        "runtime_config" => %{"kind" => "compute_workload", "runtime_spec" => settings}
      })
      when is_map(settings) do
    if runtime_spec_pinned?(settings), do: settings
  end

  def runtime_model_settings(_), do: nil

  @doc "Codex and Claude Code compute Workers run with the runtime's own login."
  def own_login_compute?(%{
        "runtime_config" => %{
          "kind" => "compute_workload",
          "runtime_spec" => %{"provider" => provider}
        }
      }),
      do: provider in ~w(codex claude)

  def own_login_compute?(_agent), do: false

  # Codex and Claude Code run only their own subscription's models, so they
  # take the runtime default or a runtime choice, never a Comma catalog model.
  def own_login_choice_allowed(agent, builtin?) do
    if builtin? or not own_login_compute?(agent),
      do: :ok,
      else:
        {:error,
         {:bad_request,
          "This Worker's runtime runs only its own models. Choose the runtime default or a runtime model."}}
  end

  def template_model_writable(agent) do
    if is_nil(runtime_model_settings(agent)),
      do: :ok,
      else:
        {:error,
         {:bad_request, "This Worker's model is controlled by its runtime configuration."}}
  end

  # A runtime choice is the template of a Codex or Claude Code compute Worker.
  # Dispatch uses the template only for fields the binding leaves blank. Such
  # binding fields predate binding revisions; changing them is out of scope.
  # Pi is excluded: it needs a Pi provider id, which the catalog does not name.
  def runtime_model_writable(%{
        "runtime_config" => %{
          "kind" => "compute_workload",
          "runtime_spec" => %{"provider" => provider} = spec
        }
      })
      when provider in ~w(codex claude) do
    if runtime_spec_pinned?(spec),
      do: {:error, :runtime_model_pinned},
      else: {:ok, provider}
  end

  def runtime_model_writable(_agent),
    do:
      {:error, {:bad_request, "This Worker's model is controlled by its runtime configuration."}}

  # Dispatch merges the template's model, provider and effort under the binding,
  # so any of them set on the binding wins over the Agent's template.
  defp runtime_spec_pinned?(spec),
    do: Enum.any?(~w(model model_provider reasoning_effort), &present?(spec[&1]))

  defp present?(value), do: is_binary(value) and String.trim(value) != ""

  # The same lock as `assign_selection/3`: a concurrent release must not delete
  # the runtime template before the Agent takes it.
  defp assign_runtime_choice(agent, provider, model, effort, tenant_id) do
    Templates.with_catalog_lock(tenant_id, fn ->
      with {:ok, template} <-
             Templates.resolve_private_runtime(provider, model, effort, tenant_id) do
        assign_or_release(agent, template["template_id"], tenant_id)
      end
    end)
  end

  # Resolve and assign under the catalog lock: a release that checks the
  # template's Agents in between would find none and delete it. A template
  # that the Agent did not take is released again, so no orphan stays.
  defp assign_selection(agent, resolve, tenant_id) do
    Templates.with_catalog_lock(tenant_id, fn ->
      with {:ok, template_id} <- resolve.(tenant_id) do
        assign_or_release(agent, template_id, tenant_id)
      end
    end)
  end

  defp assign_or_release(agent, template_id, tenant_id) do
    case assign(agent, template_id, tenant_id) do
      {:ok, updated} ->
        {:ok, updated}

      error ->
        if template_id, do: Templates.release_private_catalog(template_id, tenant_id)
        error
    end
  end

  defp assign(agent, template_id, tenant_id) do
    if agent["template_id"] == template_id,
      do: {:ok, agent},
      else: Control.configure(agent["agent_id"], %{"template_id" => template_id}, tenant_id)
  end

  defp release_replaced(agent, updated, tenant_id) do
    if agent["template_id"] != updated["template_id"],
      do: Templates.release_private_catalog(agent["template_id"], tenant_id)
  end

  defp selection_template(%{"kind" => "builtin"} = selection) when map_size(selection) == 1,
    do: {:ok, fn _tenant -> {:ok, nil} end}

  defp selection_template(
         %{"kind" => "catalog", "model" => model, "allow_paid" => allow_paid} = selection
       )
       when map_size(selection) <= 5 do
    if Enum.all?(
         Map.keys(selection),
         &(&1 in ~w(kind model allow_paid reasoning_effort profile_id))
       ) do
      {:ok,
       fn tenant_id ->
         with {:ok, template} <-
                Templates.resolve_private_catalog(
                  model,
                  selection["reasoning_effort"],
                  allow_paid,
                  tenant_id,
                  selection["profile_id"]
                ),
              do: {:ok, template["template_id"]}
       end}
    else
      {:error, :invalid_model_configuration}
    end
  end

  defp selection_template(_), do: {:error, :invalid_model_configuration}

  defp runtime_selection(%{"kind" => "runtime", "model" => model} = selection)
       when is_binary(model) do
    effort = selection["reasoning_effort"]

    if Enum.all?(Map.keys(selection), &(&1 in ~w(kind model reasoning_effort))) and
         (is_nil(effort) or is_binary(effort)),
       do: {:ok, model, effort},
       else: {:error, :invalid_runtime_model}
  end

  defp runtime_selection(_), do: {:error, :invalid_runtime_model}
end
