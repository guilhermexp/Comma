defmodule SalixWeb.LocalComposioCalendarMockTest do
  use ExUnit.Case, async: false
  alias SalixWeb.LocalComposioMock, as: Mock

  @group "group-agenda"
  @account "local-group-agenda-googlecalendar"
  @primary "local-member@comma.test"

  setup do
    Mock.reset!()
    :ok
  end

  defp run(slug, args, account \\ @account) do
    case Mock.execute_calendar(@group, account, %{"tool_slug" => slug, "arguments" => args}) do
      {:ok, %{"successful" => true, "data" => data}} -> {:ok, data}
      {:ok, %{"successful" => false, "error" => error}} -> {:error, error}
      other -> other
    end
  end

  defp week do
    today = DateTime.utc_now() |> DateTime.add(-3 * 3600) |> DateTime.to_date()
    monday = Date.add(today, 1 - Date.day_of_week(today))

    %{
      "calendarId" => @primary,
      "timeMin" => "#{monday}T00:00:00-03:00",
      "timeMax" => "#{Date.add(monday, 14)}T00:00:00-03:00",
      "singleEvents" => true
    }
  end

  defp items, do: elem(run("GOOGLECALENDAR_EVENTS_LIST", week()), 1)["items"]

  test "a foreign account cannot read the local calendars" do
    assert {:error, :composio_access_denied} = run("GOOGLECALENDAR_LIST_CALENDARS", %{}, "other")
  end

  test "lists two calendars and expands the weekly series of the current weeks" do
    assert {:ok, %{"calendars" => [%{"accessRole" => "owner"}, %{"accessRole" => "reader"}]}} =
             run("GOOGLECALENDAR_LIST_CALENDARS", %{})

    weekly = Enum.filter(items(), &(&1["recurringEventId"] == "localweekly"))
    assert length(weekly) == 2
  end

  test "writes stay in memory, an occurrence changes alone and holidays are read-only" do
    assert {:ok, %{"response_data" => %{"id" => id}}} =
             run("GOOGLECALENDAR_CREATE_EVENT", %{
               "calendar_id" => @primary,
               "summary" => "[Comma teste]",
               "start_datetime" => week()["timeMin"] |> String.replace("T00", "T15"),
               "end_datetime" => week()["timeMin"] |> String.replace("T00", "T16"),
               "timezone" => "America/Sao_Paulo"
             })

    assert Enum.any?(items(), &(&1["id"] == id))
    [first, second] = Enum.filter(items(), &(&1["recurringEventId"] == "localweekly"))

    assert {:ok, %{"summary" => "Moved"}} =
             run("GOOGLECALENDAR_PATCH_EVENT", %{
               "calendar_id" => @primary,
               "event_id" => first["id"],
               "summary" => "Moved"
             })

    assert Enum.find(items(), &(&1["id"] == first["id"]))["summary"] == "Moved"
    assert Enum.find(items(), &(&1["id"] == second["id"]))["summary"] == "Planejamento semanal"

    assert {:ok, _} =
             run("GOOGLECALENDAR_DELETE_EVENT", %{"calendar_id" => @primary, "event_id" => id})

    refute Enum.any?(items(), &(&1["id"] == id))

    assert {:error, "403" <> _} =
             run("GOOGLECALENDAR_DELETE_EVENT", %{
               "calendar_id" => "pt.brazilian#holiday@group.v.calendar.google.com",
               "event_id" => "localholiday"
             })
  end
end
