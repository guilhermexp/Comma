defmodule SalixVoice.TestStubs do
  @moduledoc false
  # Boundary stubs for CallActor tests. Each reports to the pid stored in
  # `Application.get_env(:salix_voice, :test_pid)`.

  defmodule Ingress do
    @moduledoc false
    def enqueue_group_router_im_provider_message(group_id, content, metadata, source_id, opts) do
      delays = Application.get_env(:salix_voice, :test_ingress_delays, %{})
      if delay = delays[metadata["event_type"]], do: Process.sleep(delay)

      report({:ingress, group_id, content, metadata, source_id, opts})

      Application.get_env(:salix_voice, :test_ingress_result, {:ok, :queued})
    end

    defp report(message), do: send(Application.fetch_env!(:salix_voice, :test_pid), message)
  end

  defmodule ProfileDecider do
    @moduledoc false
    # Stands in for `SalixAgent.RouterDecision`: reports the request and
    # returns `:test_profile_decision`, optionally after `{:sleep, ms, result}`.
    def decide(group_id, _purpose, questions, opts) do
      send(
        Application.fetch_env!(:salix_voice, :test_pid),
        {:profile_decide, group_id, questions, opts}
      )

      case Application.get_env(:salix_voice, :test_profile_decision, {:error, "not_configured"}) do
        {:sleep, ms, result} ->
          Process.sleep(ms)
          result

        result ->
          result
      end
    end
  end

  defmodule GroupDirectory do
    @moduledoc false
    def get_group(group_id) do
      if pid = Application.get_env(:salix_voice, :test_group_lookup_observer),
        do: send(pid, {:group_lookup, group_id, self()})

      case Application.get_env(:salix_voice, :test_group_lookup, :ok) do
        {:sleep, ms} ->
          Process.sleep(ms)
          {:error, :unavailable}

        {:error, reason} ->
          {:error, reason}

        :ok ->
          tenant_id =
            if SalixStore.Ids.valid_group_id?(group_id),
              do: SalixStore.Ids.tenant_id_from_group!(group_id),
              else: "ten_1"

          {:ok,
           %{
             "group_id" => group_id,
             "tenant_id" => tenant_id,
             "router_agent_id" =>
               Application.get_env(:salix_voice, :test_router_agent_id, "agt_voice_test_router"),
             "billing_owner" => %{
               "billing_account_id" => "ba_voice",
               "surface" => "comma",
               "product_owner_type" => "workspace",
               "product_owner_id" => "ws_1"
             }
           }}
      end
    end
  end

  defmodule FailingArchive do
    @moduledoc false
    @behaviour SalixAgent.EventArchive
    def active?, do: true
    def record(_fact), do: raise("archive unavailable")
    def reserve(_fact), do: raise("archive unavailable")
  end

  defmodule Metering do
    @moduledoc false
    def authorize(_attrs), do: Application.get_env(:salix_voice, :test_admission, :ok)

    def charge(attrs) do
      case Application.get_env(:salix_voice, :test_pid) do
        pid when is_pid(pid) -> send(pid, {:metered, attrs})
        _ -> :ok
      end

      {:ok, %{}}
    end
  end
end
