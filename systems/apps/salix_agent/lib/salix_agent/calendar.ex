defmodule SalixAgent.Calendar do
  @moduledoc """
  Group-scoped runtime seam for the Comma calendar behind the agent calendar
  tools (`SalixCalendar.AgentAPI` through the product binding).

  `owner` is the server-resolved principal of the Group's owner, or `nil`.
  """

  alias SalixAgent.GroupRuntime

  @callback calendars(String.t(), map() | nil) :: {:ok, map()} | {:error, term()}
  @callback events(String.t(), map(), map() | nil) :: {:ok, map()} | {:error, term()}
  @callback event(String.t(), map(), map() | nil) :: {:ok, map()} | {:error, term()}
  @callback create(String.t(), map(), map() | nil, String.t() | nil) ::
              {:ok, map()} | {:error, term()}
  @callback update(String.t(), map(), map() | nil) :: {:ok, map()} | {:error, term()}
  @callback delete(String.t(), map(), map() | nil) :: {:ok, map()} | {:error, term()}
  @callback update_context(String.t(), map()) :: {:ok, map()} | {:error, term()}
  @callback issue_feed_link(String.t(), map() | nil) :: {:ok, map()} | {:error, term()}

  def calendars(agent_id, owner), do: call(agent_id, :calendars, [owner])
  def events(agent_id, params, owner), do: call(agent_id, :events, [params, owner])
  def event(agent_id, params, owner), do: call(agent_id, :event, [params, owner])

  def create(agent_id, params, owner, creation_request_id),
    do: call(agent_id, :create, [params, owner, creation_request_id])

  def update(agent_id, params, owner), do: call(agent_id, :update, [params, owner])
  def delete(agent_id, params, owner), do: call(agent_id, :delete, [params, owner])

  def issue_feed_link(agent_id, principal_ref),
    do: call(agent_id, :issue_feed_link, [principal_ref])

  def update_context(agent_id, params) do
    call(agent_id, :update_context, [
      Map.put(params, "actor", %{"actor_type" => "agent", "agent_id" => agent_id})
    ])
  end

  defp call(agent_id, command, args),
    do: GroupRuntime.call(agent_id, :calendar_mod, :calendar_not_configured, command, args)
end
