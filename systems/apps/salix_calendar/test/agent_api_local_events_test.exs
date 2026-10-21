defmodule SalixCalendar.AgentAPILocalEventsTest do
  use ExUnit.Case, async: false

  alias SalixCalendar.{AgentAPI, Server}
  alias SalixStore.{Ids, Keys, S3}

  setup do
    S3.Fake.reset()

    tenant_id = Ids.new_tenant_id()
    group_id = Ids.new_group_id(tenant_id)

    assert {:ok, _} =
             S3.put(
               Keys.ctl_group(group_id),
               Jason.encode!(%{"group_id" => group_id, "tenant_id" => tenant_id}),
               if_none_match: "*"
             )

    owner = %{"namespace" => "comma_user", "tenant_id" => tenant_id, "subject_id" => "usr_1"}

    assert {:ok, %{"calendars" => [comma]}} = AgentAPI.calendars(group_id, owner)
    calendar_id = comma["calendar_ref"]["calendar_id"]

    event = %{
      "title" => "Reunião",
      "start" => "2026-09-15T19:00:00+09:00",
      "end" => "2026-09-15T20:30:00+09:00",
      "time_zone" => "Asia/Tokyo",
      "location" => "Sala 2",
      "description" => "Pauta"
    }

    {:ok, group_id: group_id, owner: owner, calendar_id: calendar_id, event: event}
  end

  defp create(ctx, request_id \\ "msg1:call1", event \\ nil),
    do:
      AgentAPI.create(
        ctx.group_id,
        %{"calendar_id" => ctx.calendar_id, "event" => event || ctx.event},
        ctx.owner,
        request_id
      )

  defp week(ctx) do
    %{
      "range_start_ms" => ms("2026-09-14T00:00:00+09:00"),
      "range_end_ms" => ms("2026-09-21T00:00:00+09:00")
    }
    |> then(&AgentAPI.events(ctx.group_id, &1, ctx.owner))
  end

  defp ref_params(ctx, event, extra \\ %{}) do
    Map.merge(
      %{
        "calendar_id" => ctx.calendar_id,
        "event_id" => event["event_ref"]["event_id"],
        "etag" => event["event_ref"]["etag"]
      },
      extra
    )
  end

  test "the Comma calendar is listed and writable only with an owner", ctx do
    assert {:ok, %{"calendars" => [%{"name" => "Comma", "writable" => true}]}} =
             AgentAPI.calendars(ctx.group_id, ctx.owner)

    assert {:ok, %{"calendars" => [%{"name" => "Comma", "writable" => false}]}} =
             AgentAPI.calendars(ctx.group_id, nil)
  end

  test "creates an owner Event and lists it in the unified shape", ctx do
    assert {:ok, %{"event" => created}} = create(ctx)

    assert created["title"] == "Reunião"
    assert created["start"] == "2026-09-15T19:00:00+09:00"
    assert created["end"] == "2026-09-15T20:30:00+09:00"
    assert created["location"] == "Sala 2"
    assert created["description"] == "Pauta"
    assert created["writable"] == true
    assert created["event_ref"]["source"] == "comma"
    assert created["event_ref"]["etag"] == "1"

    assert {:ok, %{"events" => [listed], "truncated" => false}} = week(ctx)
    assert listed == created

    assert {:ok, %{"event" => ^created}} =
             AgentAPI.event(ctx.group_id, ref_params(ctx, created), ctx.owner)
  end

  test "retries are idempotent and each request is its own Event", ctx do
    assert {:ok, %{"event" => first}} = create(ctx, "msg1:dup")
    assert {:ok, %{"event" => again}} = create(ctx, "msg1:dup")
    assert first["event_ref"]["event_id"] == again["event_ref"]["event_id"]

    assert {:ok, %{"event" => second}} =
             create(ctx, "msg1:other", %{ctx.event | "title" => "Outra"})

    assert second["event_ref"]["event_id"] != first["event_ref"]["event_id"]
  end

  test "Events are owner-scoped and need an owner and a request id to create", ctx do
    assert {:ok, %{"event" => created}} = create(ctx)
    other = %{ctx.owner | "subject_id" => "usr_2"}

    assert {:ok, %{"events" => []}} =
             AgentAPI.events(
               ctx.group_id,
               %{
                 "range_start_ms" => ms("2026-09-14T00:00:00Z"),
                 "range_end_ms" => ms("2026-09-21T00:00:00Z")
               },
               other
             )

    assert {:error, :not_found} = AgentAPI.event(ctx.group_id, ref_params(ctx, created), other)
    assert {:error, :not_found} = AgentAPI.event(ctx.group_id, ref_params(ctx, created), nil)

    params = %{"calendar_id" => ctx.calendar_id, "event" => ctx.event}
    assert {:error, :missing_principal} = AgentAPI.create(ctx.group_id, params, nil, "m:c")

    foreign = %{ctx.owner | "tenant_id" => Ids.new_tenant_id()}

    assert {:error, :principal_tenant_mismatch} =
             AgentAPI.create(ctx.group_id, params, foreign, "m:c")

    assert {:error, :invalid_creation_request} =
             AgentAPI.create(ctx.group_id, params, ctx.owner, "")
  end

  test "all-day and recurring Events are refused for the Comma calendar", ctx do
    assert {:error, :unsupported_all_day_event} =
             create(ctx, "m:allday", Map.put(ctx.event, "all_day", true))

    assert {:error, :unsupported_recurring_event} =
             create(ctx, "m:rrule", Map.put(ctx.event, "recurrence", ["RRULE:FREQ=DAILY"]))
  end

  test "the owner edits an Event, and a stale etag is a conflict", ctx do
    assert {:ok, %{"event" => created}} = create(ctx)

    patch = %{
      "title" => "Reunião movida",
      "start" => "2026-10-02T09:00:00+09:00",
      "location" => nil
    }

    assert {:ok, %{"event" => moved}} =
             AgentAPI.update(
               ctx.group_id,
               ref_params(ctx, created, %{"patch" => patch}),
               ctx.owner
             )

    assert moved["title"] == "Reunião movida"
    assert moved["start"] == "2026-10-02T09:00:00+09:00"
    # The duration is kept when only the start moves.
    assert moved["end"] == "2026-10-02T10:30:00+09:00"
    assert moved["location"] == nil
    assert moved["description"] == "Pauta"
    assert moved["event_ref"]["etag"] == "2"

    # It left the old week and appears in the new month.
    assert {:ok, %{"events" => []}} = week(ctx)

    assert {:ok, %{"events" => [^moved]}} =
             AgentAPI.events(
               ctx.group_id,
               %{
                 "range_start_ms" => ms("2026-10-01T00:00:00Z"),
                 "range_end_ms" => ms("2026-10-05T00:00:00Z")
               },
               ctx.owner
             )

    assert {:error, :calendar_event_conflict} =
             AgentAPI.update(
               ctx.group_id,
               ref_params(ctx, created, %{"patch" => %{"title" => "Stale"}}),
               ctx.owner
             )

    other = %{ctx.owner | "subject_id" => "usr_2"}

    assert {:error, :not_found} =
             AgentAPI.update(
               ctx.group_id,
               ref_params(ctx, moved, %{"patch" => %{"title" => "x"}}),
               other
             )
  end

  test "the owner deletes an Event; it disappears and a retried create stays deleted", ctx do
    assert {:ok, %{"event" => created}} = create(ctx)
    other = %{ctx.owner | "subject_id" => "usr_2"}

    assert {:error, :not_found} = AgentAPI.delete(ctx.group_id, ref_params(ctx, created), other)
    assert {:ok, %{}} = AgentAPI.delete(ctx.group_id, ref_params(ctx, created), ctx.owner)

    assert {:ok, %{"events" => []}} = week(ctx)

    assert {:error, :not_found} =
             AgentAPI.event(ctx.group_id, ref_params(ctx, created), ctx.owner)

    assert {:ok, []} =
             Server.list_owner_items(
               ctx.group_id,
               ctx.calendar_id,
               ctx.owner,
               ms("2026-01-01T00:00:00Z"),
               ms("2027-01-01T00:00:00Z")
             )

    assert {:error, :calendar_local_item_deleted} = create(ctx)
  end

  test "an unknown calendar is not found", ctx do
    params = %{"calendar_id" => Ids.new_calendar_id(), "event" => ctx.event}
    assert {:error, :not_found} = AgentAPI.create(ctx.group_id, params, ctx.owner, "m:c")
  end

  defp ms(iso) do
    {:ok, dt, _} = DateTime.from_iso8601(iso)
    DateTime.to_unix(dt, :millisecond)
  end
end
