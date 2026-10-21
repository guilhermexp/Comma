import { describe, expect, it, vi } from "vitest";
import { CommaApiError, type CommaApiClient } from "../../../api";
import { agendaErrorCode } from "../agendaErrors";
import {
  googleCalendarSource,
  listGoogleCalendarAccounts,
} from "../googleCalendarSource";

function harness(reply: (action: string, params: Record<string, unknown>) => unknown) {
  const composioCommand = vi.fn(
    async (_workspace: string, action: string, params: Record<string, unknown> = {}) =>
      reply(action, params) as Record<string, unknown>
  );
  const getComposio = vi.fn();
  const api = { composioCommand, getComposio } as unknown as CommaApiClient;
  return { api, composioCommand, getComposio };
}

const signal = new AbortController().signal;

const timed = {
  id: "evt-1",
  calendar_id: "work@group",
  series_id: "series-1",
  title: "Revisão",
  start: { date_time: "2026-10-22T15:00:00-03:00", time_zone: "America/Sao_Paulo" },
  end: { date_time: "2026-10-22T16:30:00-03:00", time_zone: "America/Sao_Paulo" },
  all_day: false,
  location: null,
  description: null,
  url: "https://www.google.com/calendar/event?eid=abc",
  color: null,
  editable: true,
  etag: '"e1"',
};

describe("googleCalendarSource", () => {
  it("maps the account's calendars with the account e-mail as owner", async () => {
    const { api, composioCommand } = harness(() => ({
      account_email: "ana@gmail.com",
      calendars: [
        {
          id: "ana@gmail.com",
          name: "Ana",
          color: "#1a73e8",
          primary: true,
          selected: true,
          access_role: "owner",
          writable: true,
        },
        {
          id: "pt.brazilian#holiday@group",
          name: "Feriados no Brasil",
          color: "#0b8043",
          primary: false,
          selected: true,
          access_role: "reader",
          writable: false,
        },
      ],
    }));
    const calendars = await googleCalendarSource(api, "ws", "acct").calendars(signal);
    expect(composioCommand).toHaveBeenCalledWith(
      "ws",
      "google_calendar",
      { account_id: "acct", operation: "calendars" },
      { signal }
    );
    expect(calendars).toEqual([
      {
        key: "google:acct:ana@gmail.com",
        source: "google",
        accountId: "acct",
        id: "ana@gmail.com",
        name: "Ana",
        color: "#1a73e8",
        writable: true,
        primary: true,
        ownerEmail: "ana@gmail.com",
      },
      expect.objectContaining({ name: "Feriados no Brasil", writable: false }),
    ]);
  });

  it("reads events in batches of 25 calendars and keeps all-day dates", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `cal-${index}`);
    const { api, composioCommand } = harness((_action, params) => ({
      events:
        (params["calendar_ids"] as string[])[0] === "cal-0"
          ? [
              timed,
              {
                ...timed,
                id: "holiday",
                series_id: null,
                start: { date: "2026-10-25" },
                end: { date: "2026-10-26" },
                all_day: true,
                etag: null,
              },
            ]
          : [],
      truncated: false,
      failed_calendar_ids: (params["calendar_ids"] as string[]).includes("cal-29")
        ? ["cal-29"]
        : [],
    }));
    const result = await googleCalendarSource(api, "ws", "acct").events(
      ids,
      "2026-10-19T00:00:00-03:00",
      "2026-10-26T00:00:00-03:00",
      signal
    );
    expect(composioCommand).toHaveBeenCalledTimes(2);
    expect(composioCommand.mock.calls[0]?.[2]).toMatchObject({
      account_id: "acct",
      operation: "events",
      calendar_ids: ids.slice(0, 25),
      time_min: "2026-10-19T00:00:00-03:00",
      time_max: "2026-10-26T00:00:00-03:00",
    });
    expect(result.failedCalendarIds).toEqual(["cal-29"]);
    expect(result.events).toEqual([
      expect.objectContaining({
        key: "google:acct:work@group:evt-1",
        calendarId: "work@group",
        seriesId: "series-1",
        start: "2026-10-22T15:00:00-03:00",
        end: "2026-10-22T16:30:00-03:00",
        allDay: false,
        etag: '"e1"',
      }),
      expect.objectContaining({ start: "2026-10-25", end: "2026-10-26", allDay: true }),
    ]);
  });

  it("creates in the chosen calendar with the C1 input shape", async () => {
    const { api, composioCommand } = harness(() => ({ event: timed }));
    const created = await googleCalendarSource(api, "ws", "acct").create("work@group", {
      title: "Revisão",
      start: "2026-10-22T15:00:00-03:00",
      end: "2026-10-22T16:30:00-03:00",
      allDay: false,
      timeZone: "America/Sao_Paulo",
      recurrence: "none",
    });
    expect(composioCommand.mock.calls[0]?.[2]).toEqual({
      account_id: "acct",
      operation: "create",
      calendar_id: "work@group",
      event: {
        title: "Revisão",
        start: "2026-10-22T15:00:00-03:00",
        end: "2026-10-22T16:30:00-03:00",
        all_day: false,
        time_zone: "America/Sao_Paulo",
        recurrence: "none",
      },
    });
    expect(created.id).toBe("evt-1");
  });

  it("updates an occurrence by its id and the series by the series id", async () => {
    const { api, composioCommand } = harness(() => ({ event: timed }));
    const source = googleCalendarSource(api, "ws", "acct");
    const [event] = (
      await googleCalendarSource(
        harness(() => ({ events: [timed], truncated: false, failed_calendar_ids: [] }))
          .api,
        "ws",
        "acct"
      ).events(["work@group"], "a", "b", signal)
    ).events;
    await source.update(event!, "instance", { title: "Nova" }, "personal@group");
    await source.update(event!, "series", { allDay: true });
    await source.remove(event!, "series");
    expect(composioCommand.mock.calls.map((call) => call[2])).toEqual([
      {
        account_id: "acct",
        operation: "update",
        calendar_id: "work@group",
        event_id: "evt-1",
        scope: "instance",
        etag: '"e1"',
        patch: { title: "Nova" },
        target_calendar_id: "personal@group",
      },
      {
        account_id: "acct",
        operation: "update",
        calendar_id: "work@group",
        event_id: "series-1",
        scope: "series",
        patch: { all_day: true },
      },
      {
        account_id: "acct",
        operation: "delete",
        calendar_id: "work@group",
        event_id: "series-1",
        scope: "series",
      },
    ]);
  });

  it("sends all_day with a moved time, as C1 needs start, end and all_day together", async () => {
    // A drag moves only the bounds; the backend refuses a time patch without all_day.
    const { api, composioCommand } = harness(() => ({ event: timed }));
    const source = googleCalendarSource(api, "ws", "acct");
    const [event] = (
      await googleCalendarSource(
        harness(() => ({ events: [timed], truncated: false, failed_calendar_ids: [] }))
          .api,
        "ws",
        "acct"
      ).events(["work@group"], "a", "b", signal)
    ).events;

    await source.update(event!, "instance", {
      start: "2026-10-23T14:00:00-03:00",
      end: "2026-10-23T15:30:00-03:00",
      timeZone: "America/Sao_Paulo",
    });

    expect(composioCommand.mock.calls[0]?.[2]).toMatchObject({
      patch: {
        start: "2026-10-23T14:00:00-03:00",
        end: "2026-10-23T15:30:00-03:00",
        all_day: false,
        time_zone: "America/Sao_Paulo",
      },
    });
  });

  it("reads the series repetition", async () => {
    const { api, composioCommand } = harness(() => ({
      event: { ...timed, recurrence: "custom" },
    }));
    const source = googleCalendarSource(api, "ws", "acct");
    const event = {
      ...(await source.create("work@group", input())),
      seriesId: "series-1",
    };
    composioCommand.mockClear();
    await expect(source.recurrence(event)).resolves.toBe("custom");
    expect(composioCommand.mock.calls[0]?.[2]).toEqual({
      account_id: "acct",
      operation: "event",
      calendar_id: "work@group",
      event_id: "series-1",
    });
  });

  it.each([
    ["calendar_write_permission_required", 403, "write_permission"],
    ["calendar_event_conflict", 409, "conflict"],
    ["composio_access_denied", 403, "access"],
    ["provider_timeout", 504, "timeout"],
  ] as const)("names the %s failure", async (error, status, code) => {
    const { api } = harness(() => {
      throw new CommaApiError(status, error, { error });
    });
    const failure = await googleCalendarSource(api, "ws", "acct")
      .create("work@group", input())
      .catch((caught: unknown) => caught);
    expect(agendaErrorCode(failure)).toBe(code);
  });

  it("rejects a response outside C1", async () => {
    const { api } = harness(() => ({ event: { id: 4 } }));
    await expect(
      googleCalendarSource(api, "ws", "acct").create("work@group", input())
    ).rejects.toThrow();
  });
});

describe("listGoogleCalendarAccounts", () => {
  it("keeps the active googlecalendar accounts of the workspace mode", async () => {
    const { api, getComposio } = harness(() => ({}));
    getComposio.mockResolvedValue({
      mode: "connect",
      status: "connected",
      user_id: "u",
      next_cursor: null,
      capabilities: { catalog: true, search: true, account_management: true },
      expires_at: null,
      accounts: [
        account("cal-1", "googlecalendar"),
        account("drive-1", "googledrive"),
        { ...account("cal-2", "googlecalendar"), enabled: false },
      ],
    });
    const result = await listGoogleCalendarAccounts(api, "ws", signal);
    expect(result.accounts.map((item) => item.id)).toEqual(["cal-1"]);
  });

  it("asks the backend to reconcile when none is connected yet", async () => {
    const { api, getComposio, composioCommand } = harness(() => ({
      mode: "connect",
      status: "connected",
      user_id: "u",
      next_cursor: null,
      capabilities: { catalog: true, search: true, account_management: true },
      expires_at: null,
      accounts: [],
      remote_accounts: [account("remote", "googlecalendar")],
    }));
    getComposio.mockResolvedValue({
      mode: "connect",
      status: "connected",
      user_id: "u",
      next_cursor: null,
      capabilities: { catalog: true, search: true, account_management: true },
      expires_at: null,
      accounts: [],
    });
    const result = await listGoogleCalendarAccounts(api, "ws", signal);
    expect(composioCommand).toHaveBeenCalledWith(
      "ws",
      "reconcile_accounts",
      { toolkit: "googlecalendar" },
      { signal }
    );
    expect(result.accounts).toEqual([]);
    expect(result.candidates.map((item) => item.id)).toEqual(["remote"]);
  });
});

function account(id: string, toolkit: string) {
  return {
    id,
    toolkit,
    name: `${id}@gmail.com`,
    email: `${id}@gmail.com`,
    status: "ACTIVE",
    enabled: true,
    mode: "connect" as const,
  };
}

function input() {
  return {
    title: "Revisão",
    start: "2026-10-22T15:00:00-03:00",
    end: "2026-10-22T16:30:00-03:00",
    allDay: false,
    timeZone: "America/Sao_Paulo",
    recurrence: "none" as const,
  };
}
