defmodule Salix.Bindings.AgentCalendar do
  @moduledoc "Local coordinator for the agent's Comma calendar and context-triggered meeting reconciliation."

  @behaviour SalixAgent.Calendar

  alias SalixCalendar.AgentAPI
  alias SalixMeet.MeetingPlan
  alias SalixStore.CalendarFeedSubscriptions

  @impl true
  def calendars(group_id, owner), do: AgentAPI.calendars(group_id, owner)

  @impl true
  def events(group_id, params, owner), do: AgentAPI.events(group_id, params, owner)

  @impl true
  def event(group_id, params, owner), do: AgentAPI.event(group_id, params, owner)

  @impl true
  def create(group_id, params, owner, creation_request_id),
    do: AgentAPI.create(group_id, params, owner, creation_request_id)

  @impl true
  def update(group_id, params, owner), do: AgentAPI.update(group_id, params, owner)

  @impl true
  def delete(group_id, params, owner), do: AgentAPI.delete(group_id, params, owner)

  @impl true
  def update_context(group_id, params) do
    with {:ok, context} <- AgentAPI.update_context(group_id, params),
         {:ok, _result} <-
           MeetingPlan.reconcile_occurrence(group_id, context["occurrence_ref"]) do
      {:ok, context}
    end
  end

  # Issuance mints the credential and returns its URL for the caller to show the
  # requesting human. Rotation stays fenced so a concurrent reissue cannot
  # invalidate a URL already returned.
  @impl true
  def issue_feed_link(group_id, principal_ref) do
    with {:ok, scope} <- AgentAPI.feed_scope(group_id, principal_ref) do
      now = System.system_time(:millisecond)

      case CalendarFeedSubscriptions.active(scope) do
        {:ok, %{"id" => feed_id, "fence" => fence}} ->
          secret = CalendarFeedSubscriptions.new_secret()

          with :ok <- CalendarFeedSubscriptions.rotate_to(feed_id, fence, secret, now),
               do: {:ok, %{"feed_url" => feed_url(feed_id, secret)}}

        {:error, :not_found} ->
          case CalendarFeedSubscriptions.issue(scope, now) do
            {:ok, %{"id" => feed_id, "secret" => secret}} ->
              {:ok, %{"feed_url" => feed_url(feed_id, secret)}}

            {:error, :calendar_feed_active_exists} ->
              issue_feed_link(group_id, principal_ref)

            {:error, _} = error ->
              error
          end

        {:error, _} = error ->
          error
      end
    end
  end

  defp feed_url(feed_id, secret),
    do: "#{SalixWeb.Application.public_base_url()}/v1/calendar/feeds/#{feed_id}/#{secret}.ics"
end
