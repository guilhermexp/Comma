defmodule SalixAgent.CalendarSources do
  @moduledoc """
  Port to the owner's external calendars (Google accounts and the Mac) for the
  agent calendar tools.

  The product composition implements it and sets it with

      Application.put_env(:salix_agent, :calendar_sources_mod, Module)

  Without one, `SalixAgent.CalendarSources.None` answers: there is no owner, and
  Google and the Mac are not connected, so the tools still read the Comma
  calendar.

  Every implementation returns string-keyed maps already normalized to the
  unified calendar and event shapes; `salix_agent` never sees provider formats.
  `owner/1` resolves the owner of the agent's Group from the server side; the
  model never supplies it.
  """

  @type owner :: %{tenant: String.t(), group_id: String.t(), user_id: String.t()}
  @type google_operation :: :calendars | :events | :event | :create | :update | :delete
  @typedoc "calendars | events | event | create-event | update-event | delete-event"
  @type mac_op :: String.t()

  @callback owner(agent_id :: String.t()) :: {:ok, owner()} | {:error, term()}
  @callback google_accounts(owner()) ::
              {:ok, [%{account_id: String.t(), name: String.t()}]} | {:error, term()}
  @callback google(owner(), account_id :: String.t(), google_operation(), args :: map()) ::
              {:ok, map()} | {:error, String.t()}
  @callback mac(owner(), mac_op(), input :: map()) ::
              {:ok, map()}
              | {:error, :desktop_offline | :mac_access_not_granted | :mac_unavailable | term()}

  def owner(agent_id), do: impl().owner(agent_id)
  def google_accounts(owner), do: impl().google_accounts(owner)

  def google(owner, account_id, operation, args),
    do: impl().google(owner, account_id, operation, args)

  def mac(owner, op, input), do: impl().mac(owner, op, input)

  defp impl, do: Application.get_env(:salix_agent, :calendar_sources_mod) || __MODULE__.None
end

defmodule SalixAgent.CalendarSources.None do
  @moduledoc "No external calendars: no owner, Google and the Mac not connected."

  @behaviour SalixAgent.CalendarSources

  @impl true
  def owner(_agent_id), do: {:error, :not_configured}

  @impl true
  def google_accounts(_owner), do: {:ok, []}

  @impl true
  def google(_owner, _account_id, _operation, _args), do: {:error, "not_connected"}

  @impl true
  def mac(_owner, _op, _input), do: {:error, :not_connected}
end
