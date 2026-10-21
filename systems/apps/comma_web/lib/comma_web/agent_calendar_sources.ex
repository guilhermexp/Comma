defmodule CommaWeb.AgentCalendarSources do
  @moduledoc """
  Agent port to the owner's Google and Mac calendars (`SalixAgent.CalendarSources`, C3).

  The owner is the single active owner of the Workspace of the Agent's Group.
  Google access needs no per-Agent Composio grant: each call uses an enabled
  ACTIVE `googlecalendar` account of the owner, and checks the owner and the
  account before and after each provider call. Execution, limits and the
  30-second deadline are those of `CommaWeb.GoogleCalendarAgenda`. Results are
  the C4 normalized maps with string keys; errors are C4 public codes.
  """
  alias Comma.Workspaces
  alias SalixStore.ComposioAccess, as: Access
  alias CommaWeb.GoogleCalendarAgenda, as: Agenda

  if Code.ensure_loaded?(SalixAgent.CalendarSources),
    do: @behaviour(SalixAgent.CalendarSources)

  # Owned by the Mac connector change; resolved at runtime so this compiles without it.
  @mac CommaWeb.AgentCalendarSources.Mac
  @operations %{
    calendars: "calendars",
    events: "events",
    event: "event",
    create: "create",
    update: "update",
    delete: "delete"
  }
  @codes ~w(composio_access_denied calendar_write_permission_required calendar_event_conflict provider_unavailable provider_timeout read_only not_found not_connected)a
  @max_account_pages 20

  def owner(agent_id) when is_binary(agent_id) do
    with {:ok, %{"tenant_id" => tenant, "group_id" => group}} <-
           SalixAgent.Control.get(agent_id),
         {:ok, workspace} <- Workspaces.get_by_group(group),
         true <- workspace["salix_tenant_id"] == tenant,
         user when is_binary(user) <- workspace["owner_user_id"],
         {:ok, _} <- Workspaces.authorize_group_owner(workspace["id"], group, user) do
      {:ok, %{tenant: tenant, group_id: group, user_id: user}}
    else
      _ -> {:error, :not_found}
    end
  end

  def owner(_), do: {:error, :not_found}

  def google_accounts(owner) do
    with :ok <- member(owner),
         {:ok, profile} <- Access.profile(owner.tenant, owner.group_id, owner.user_id) do
      if profile["status"] == "connected" and profile["mode"] in ~w(connect project),
        do: accounts(owner, profile["mode"], nil, [], @max_account_pages),
        else: {:ok, []}
    else
      {:error, :composio_access_denied} -> {:error, "composio_access_denied"}
      _ -> {:error, "provider_unavailable"}
    end
  end

  defp accounts(owner, mode, cursor, found, pages) do
    case Access.accounts(owner.tenant, owner.group_id, owner.user_id, cursor) do
      {:ok, page} ->
        found =
          found ++
            for account <- page["items"],
                Agenda.calendar_account?(account, mode),
                do: %{"account_id" => account["id"], "name" => account["name"]}

        if is_nil(page["next_cursor"]) or pages <= 1,
          do: {:ok, found},
          else: accounts(owner, mode, page["next_cursor"], found, pages - 1)

      _ ->
        {:error, "provider_unavailable"}
    end
  end

  def google(owner, account_id, operation, args) do
    result =
      with {:ok, request} <- request(operation, account_id, args),
           :ok <- member(owner),
           {:ok, account, binding} <- connected(owner, account_id) do
        authorize = fn ->
          with :ok <- member(owner),
               {:ok, ^account, ^binding} <- Agenda.account(owner, account_id) do
            :ok
          else
            _ -> {:error, :composio_access_denied}
          end
        end

        with {:ok, result} <- Agenda.call(owner, account, request, authorize, agent: true),
             do: {:ok, normalize(operation, result, account_id)}
      end

    public(result)
  end

  def mac(owner, op, input), do: apply(@mac, :call, [owner, op, input])

  # The live owner of the Workspace of the Group, as the Composio broker checks it.
  defp member(%{tenant: tenant, group_id: group, user_id: user})
       when is_binary(tenant) and is_binary(group) and is_binary(user),
       do: CommaWeb.OAuthCommit.authorize_composio_member(tenant, group, user)

  defp member(_), do: {:error, :composio_access_denied}

  defp connected(owner, account_id) do
    with {:error, _} <- Agenda.account(owner, account_id), do: {:error, :not_connected}
  end

  defp request(operation, account_id, args) when is_map(args) do
    with op when is_binary(op) <- @operations[operation] do
      params = Map.merge(args, %{"account_id" => account_id, "operation" => op})

      if op == "events" and is_nil(args["calendar_ids"]) do
        with {:ok, r} <- Agenda.request(Map.put(params, "calendar_ids", ["primary"])),
             do: {:ok, %{r | ids: :selected}}
      else
        Agenda.request(params)
      end
    else
      _ -> {:error, :invalid_composio_request}
    end
  end

  defp request(_, _, _), do: {:error, :invalid_composio_request}

  defp public({:ok, _} = ok), do: ok
  defp public({:error, :invalid_composio_request}), do: {:error, "invalid_request"}
  defp public({:error, code}) when code in @codes, do: {:error, Atom.to_string(code)}
  defp public(_), do: {:error, "provider_unavailable"}

  ## C4 projections

  defp normalize(:calendars, %{"calendars" => rows}, account),
    do: %{"calendars" => Enum.map(rows, &calendar(&1, account))}

  defp normalize(:events, result, account) do
    %{
      "events" => Enum.map(result["events"], &event(&1, account)),
      "truncated" => result["truncated"],
      "failed_calendar_ids" => result["failed_calendar_ids"]
    }
  end

  defp normalize(:delete, _result, _account), do: %{}
  defp normalize(_, %{"event" => row}, account), do: %{"event" => event(row, account)}

  defp calendar_ref(account, calendar_id),
    do: %{"source" => "google", "account_id" => account, "calendar_id" => calendar_id}

  defp calendar(row, account) do
    %{
      "calendar_ref" => calendar_ref(account, row["id"]),
      "name" => row["name"],
      "writable" => row["writable"],
      "color" => row["color"],
      "primary" => row["primary"]
    }
  end

  defp event(row, account) do
    ref = calendar_ref(account, row["calendar_id"])
    recurrence = row["recurrence"]

    event = %{
      "event_ref" =>
        Map.merge(ref, %{"event_id" => row["id"], "occurrence" => nil, "etag" => row["etag"]}),
      "calendar_ref" => ref,
      "title" => row["title"],
      "start" => time(row["start"]),
      "end" => time(row["end"]),
      "all_day" => row["all_day"],
      "time_zone" => row["start"]["time_zone"],
      "location" => row["location"],
      "description" => row["description"],
      "recurring" => is_binary(row["series_id"]) or recurrence not in [nil, "none"],
      "writable" => row["editable"] == true,
      "ical_uid" => row["ical_uid"]
    }

    if recurrence, do: Map.put(event, "recurrence", recurrence), else: event
  end

  defp time(%{"date" => date}), do: date
  defp time(%{"date_time" => date_time}), do: date_time
end
