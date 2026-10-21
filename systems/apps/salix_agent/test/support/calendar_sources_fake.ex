defmodule SalixAgent.CalendarSources.Fake do
  @moduledoc """
  Test implementation of `SalixAgent.CalendarSources`.

  Each test installs answers with `put/1`: a map from callback name to a
  function taking the callback's arguments. Every call is reported to the
  installing test process as `{:calendar_sources, callback, args}`.
  """

  @behaviour SalixAgent.CalendarSources

  @owner %{tenant: "tnt_1", group_id: "grp_1", user_id: "usr_owner"}

  def owner_fixture, do: @owner

  def put(answers) when is_map(answers) do
    Application.put_env(:salix_agent, __MODULE__, Map.put(answers, :test_pid, self()))
    Application.put_env(:salix_agent, :calendar_sources_mod, __MODULE__)
  end

  def reset do
    Application.delete_env(:salix_agent, __MODULE__)
    Application.delete_env(:salix_agent, :calendar_sources_mod)
  end

  @impl true
  def owner(agent_id), do: answer(:owner, [agent_id], fn _ -> {:ok, @owner} end)

  @impl true
  def google_accounts(owner), do: answer(:google_accounts, [owner], fn _ -> {:ok, []} end)

  @impl true
  def google(owner, account_id, operation, args),
    do:
      answer(:google, [owner, account_id, operation, args], fn _, _, _, _ ->
        {:error, "not_connected"}
      end)

  @impl true
  def mac(owner, op, input),
    do: answer(:mac, [owner, op, input], fn _, _, _ -> {:error, :desktop_offline} end)

  defp answer(name, args, default) do
    answers = Application.get_env(:salix_agent, __MODULE__, %{})
    if pid = answers[:test_pid], do: send(pid, {:calendar_sources, name, args})
    apply(Map.get(answers, name, default), args)
  end
end
