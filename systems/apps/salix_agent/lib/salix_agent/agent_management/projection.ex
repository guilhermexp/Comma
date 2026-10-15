defmodule SalixAgent.AgentManagement.Projection do
  @moduledoc false
  alias SalixAgent.{Control, Templates}

  def runtime(%{"kind" => kind} = binding) when kind in ~w(external connected_runtime) do
    %{
      "kind" => "connected",
      "provider" => binding["provider"],
      "device_id" => binding["device_id"],
      "device_runtime_id" => binding["device_runtime_id"]
    }
  end

  def runtime(%{"kind" => "compute_workload"} = binding),
    do: %{
      "kind" => "compute",
      "provider" => get_in(binding, ["runtime_spec", "provider"]),
      "workload_id" => binding["workload_id"]
    }

  def runtime(_), do: %{"kind" => "internal"}

  def summary(record) do
    %{
      "agent_id" => record["agent_id"],
      "name" => record["name"],
      "purpose" => record["management_purpose"] || "",
      "lifecycle" => if(Control.archived?(record), do: "archived", else: "unarchived"),
      "runtime" => runtime(record["runtime_config"]),
      "binding_revision" =>
        if(Control.external_runtime?(record),
          do: get_in(record, ["runtime_config", "binding_revision"]) || 0,
          else: nil
        ),
      "archived_at" => record["archived_at"],
      "permanent" => Control.permanently_archived?(record)
    }
  end

  def detail(record) do
    summary(record)
    |> Map.put("model", model(record))
    |> Map.put("creation_audit", record["management_creation_audit"])
    |> Map.put("configuration", configuration(record))
  end

  # Saved Worker settings. Instructions are the runtime system prompt, distinct
  # from the descriptive purpose. Connector access lists explicit entries only;
  # agent.access_list resolves each account's effective state.
  defp configuration(record) do
    access = record["connector_access"]

    %{
      "instructions" => record["system_prompt"] || "",
      "disabled_tools" => record["disabled_tools"] || [],
      "vm" => Map.take(record["vm"] || %{"enabled" => false}, ~w(enabled provider profile)),
      "skills" => SalixAgent.AgentManagement.Configuration.worker_skills(record),
      "connector_access" => %{
        "worker_default" => if(access["default"] == "none", do: "none", else: "inherit"),
        "accounts" =>
          (access || %{})
          |> Map.get("accounts", %{})
          |> Enum.map(fn {ref, value} ->
            [class, id] = String.split(ref, ":", parts: 2)
            %{"class" => class, "id" => id, "access" => value}
          end)
          |> Enum.sort_by(&{&1["class"], &1["id"]})
      }
    }
  end

  defp model(record) do
    cond do
      Control.external_runtime?(record) and
        is_nil(SalixAgent.AgentModelSelection.runtime_model_settings(record)) and
          is_binary(record["template_id"]) ->
        compute_template_model(record)

      true ->
        bound_model(record)
    end
  end

  # A compute Worker without binding model fields runs its chosen template
  # (ExternalSessionStore.resolve_compute_runtime_model/3).
  defp compute_template_model(record) do
    case Templates.get(record["template_id"], record["tenant_id"]) do
      {:ok, template} ->
        config = template["provider_config"] || %{}

        %{
          "source" => "agent_config",
          "template_id" => template["template_id"],
          "model_id" => config["runtime_model"] || config["catalog_model"] || template["model"],
          "provider" => template["provider"],
          "reasoning_effort" => config["reasoning_effort"]
        }

      _ ->
        %{"source" => "unavailable"}
    end
  end

  defp bound_model(record) do
    if Control.external_runtime?(record) do
      runtime = record["runtime_config"] || %{}
      settings = runtime["runtime_spec"] || runtime

      %{
        "source" => if(settings["model"], do: "agent_config", else: "runtime_default"),
        "model_id" => settings["model"],
        "provider" => settings["model_provider"],
        "reasoning_effort" => settings["reasoning_effort"]
      }
    else
      # `source` says whether the Agent pins this template or follows a role
      # default; the remaining fields always describe the effective template.
      case Templates.resolve_public_template_for_record(record) do
        {:ok, template, source} ->
          %{
            "source" => Atom.to_string(source),
            "template_id" => template["template_id"],
            "name" => template["name"],
            "model_id" => template["model"],
            "provider" => template["provider"]
          }

        _ ->
          %{"source" => "unavailable"}
      end
    end
  end
end
