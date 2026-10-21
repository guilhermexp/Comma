import type { CalendarEvent, CalendarState } from "@comma/native-bridge";
import { createNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { describe, expect, it, vi } from "vitest";
import { agendaErrorCode } from "../agendaErrors";
import { macCalendarSource } from "../macCalendarSource";

const signal = new AbortController().signal;

function macEvent(extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    calendarId: "home",
    detached: false,
    editable: true,
    end: "2026-10-21T11:00:00-03:00",
    eventId: "evt-1",
    externalId: null,
    location: null,
    notes: null,
    occurrenceDate: null,
    occurrenceId: "evt-1",
    recurrence: "none",
    start: "2026-10-21T10:00:00-03:00",
    title: "[Comma teste]",
    url: null,
    ...extra,
  };
}

// The weekly series' Wednesday occurrence, keyed by its original date.
const wednesday = macEvent({
  eventId: "series-1",
  occurrenceId: "series-1|2026-10-21T13:00:00Z",
  occurrenceDate: "2026-10-21T13:00:00Z",
  recurrence: "weekly",
});

function calendarBridge(overrides: Record<string, unknown>) {
  return createNativeBridgeMock({ platform: "electron", calendar: overrides } as never)
    .calendar;
}

const summary = (id: string, sourceTitle: string, sourceType: string) => ({
  color: "#1badf8",
  id,
  isDefault: id === "home",
  sourceTitle,
  sourceType,
  title: id,
  writable: sourceType !== "subscribed" && sourceType !== "birthdays",
});

describe("macCalendarSource calendars", () => {
  it("keeps an e-mail account as the owner and marks subscriptions ownerless", async () => {
    const source = macCalendarSource(
      calendarBridge({
        calendars: vi.fn(async () => ({
          calendars: [
            summary("work", "ana@gmail.com", "calDAV"),
            summary("home", "iCloud", "calDAV"),
            summary("holidays", "Subscribed Calendars", "subscribed"),
            summary("birthdays", "Other", "birthdays"),
          ],
        })),
      })
    );

    const calendars = await source.calendars(signal);

    expect(
      calendars.map(({ id, ownerEmail, sourceLabel, writable, primary }) => ({
        id,
        ownerEmail,
        sourceLabel,
        writable,
        primary,
      }))
    ).toEqual([
      {
        id: "work",
        ownerEmail: "ana@gmail.com",
        sourceLabel: "ana@gmail.com",
        writable: true,
        primary: false,
      },
      {
        id: "home",
        ownerEmail: null,
        sourceLabel: "iCloud",
        writable: true,
        primary: true,
      },
      {
        id: "holidays",
        ownerEmail: null,
        sourceLabel: null,
        writable: false,
        primary: false,
      },
      {
        id: "birthdays",
        ownerEmail: null,
        sourceLabel: null,
        writable: false,
        primary: false,
      },
    ]);
    expect(calendars[0]).toMatchObject({
      key: "mac:mac:work",
      source: "mac",
      accountId: null,
      color: "#1badf8",
    });
  });

  it("fails with the Mac error code when access is gone", async () => {
    const source = macCalendarSource(
      calendarBridge({
        calendars: vi.fn(async () => ({ error: "calendar_access_denied" })),
      })
    );
    const failure = await source.calendars(signal).catch((error: unknown) => error);
    expect(agendaErrorCode(failure)).toBe("access");
  });
});

describe("macCalendarSource events", () => {
  it("reads the period and keys each occurrence apart from its series", async () => {
    const events = vi.fn(async () => ({
      events: [
        macEvent(),
        wednesday,
        macEvent({
          allDay: true,
          start: "2026-10-25",
          end: "2026-10-26",
          eventId: "trip",
          occurrenceId: "trip",
          notes: "Levar mala",
          url: "https://example.com",
        }),
      ],
      truncated: true,
    }));
    const source = macCalendarSource(calendarBridge({ events }));

    const result = await source.events(
      ["home"],
      "2026-10-19T00:00:00-03:00",
      "2026-10-26T00:00:00-03:00",
      signal
    );

    expect(events).toHaveBeenCalledWith({
      calendarIds: ["home"],
      start: "2026-10-19T00:00:00-03:00",
      end: "2026-10-26T00:00:00-03:00",
    });
    expect(result.truncated).toBe(true);
    expect(result.failedCalendarIds).toEqual([]);
    expect(result.events[0]).toMatchObject({
      key: "mac:mac:home:evt-1",
      id: "evt-1",
      seriesId: null,
      occurrenceDate: null,
      editable: true,
      etag: null,
    });
    expect(result.events[1]).toMatchObject({
      key: "mac:mac:home:series-1|2026-10-21T13:00:00Z",
      seriesId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
    });
    expect(result.events[2]).toMatchObject({
      allDay: true,
      start: "2026-10-25",
      end: "2026-10-26",
      description: "Levar mala",
      url: "https://example.com",
    });
  });

  it("keeps a detached occurrence on its series", async () => {
    const source = macCalendarSource(
      calendarBridge({
        events: vi.fn(async () => ({
          events: [{ ...wednesday, detached: true, recurrence: "custom" as const }],
          truncated: false,
        })),
      })
    );
    const [event] = (
      await source.events(
        ["home"],
        "2026-10-19T00:00:00-03:00",
        "2026-10-26T00:00:00-03:00",
        signal
      )
    ).events;
    expect(event).toMatchObject({
      seriesId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
    });
  });

  it("reads the recurrence of the occurrence's series", async () => {
    const event = vi.fn(async () => ({ ...wednesday, recurrence: "custom" as const }));
    const source = macCalendarSource(
      calendarBridge({
        event,
        events: vi.fn(async () => ({ events: [wednesday], truncated: false })),
      })
    );
    const [occurrence] = (
      await source.events(
        ["home"],
        "2026-10-19T00:00:00-03:00",
        "2026-10-26T00:00:00-03:00",
        signal
      )
    ).events;

    await expect(source.recurrence(occurrence!)).resolves.toBe("custom");
    expect(event).toHaveBeenCalledWith({
      eventId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
    });
  });
});

describe("macCalendarSource writes", () => {
  async function readWednesday(overrides: Record<string, unknown>) {
    const source = macCalendarSource(
      calendarBridge({
        events: vi.fn(async () => ({ events: [wednesday], truncated: false })),
        ...overrides,
      })
    );
    const [event] = (
      await source.events(
        ["home"],
        "2026-10-19T00:00:00-03:00",
        "2026-10-26T00:00:00-03:00",
        signal
      )
    ).events;
    return { source, event: event! };
  }

  it("creates in the chosen calendar with the Agenda input", async () => {
    const createEvent = vi.fn(async () =>
      macEvent({ eventId: "new", occurrenceId: "new" })
    );
    const source = macCalendarSource(calendarBridge({ createEvent }));

    const created = await source.create("home", {
      title: "[Comma teste]",
      start: "2026-10-22T15:00:00-03:00",
      end: "2026-10-22T16:30:00-03:00",
      allDay: false,
      timeZone: "America/Sao_Paulo",
      location: null,
      recurrence: "weekly",
    });

    expect(createEvent).toHaveBeenCalledWith({
      calendarId: "home",
      event: {
        title: "[Comma teste]",
        start: "2026-10-22T15:00:00-03:00",
        end: "2026-10-22T16:30:00-03:00",
        allDay: false,
        timeZone: "America/Sao_Paulo",
        location: null,
        recurrence: "weekly",
      },
    });
    expect(created.key).toBe("mac:mac:home:new");
  });

  it("refuses a read-only calendar with calendar_read_only", async () => {
    const source = macCalendarSource(
      calendarBridge({
        createEvent: vi.fn(async () => ({ error: "calendar_read_only" })),
      })
    );
    const failure = await source
      .create("holidays", {
        title: "x",
        start: "2026-10-22",
        end: "2026-10-23",
        allDay: true,
        timeZone: "UTC",
        recurrence: "none",
      })
      .catch((error: unknown) => error);
    expect(agendaErrorCode(failure)).toBe("read_only");
  });

  it("moves only the dragged occurrence, addressed by its original date", async () => {
    const updateEvent = vi.fn(async () => ({
      ...wednesday,
      detached: true,
      start: "2026-10-23T14:00:00-03:00",
      end: "2026-10-23T15:00:00-03:00",
    }));
    const { source, event } = await readWednesday({ updateEvent });
    const patch = {
      start: "2026-10-23T14:00:00-03:00",
      end: "2026-10-23T15:00:00-03:00",
      timeZone: "America/Sao_Paulo",
    };

    const moved = await source.update(event, "instance", patch);

    expect(updateEvent).toHaveBeenCalledWith({
      eventId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
      scope: "instance",
      patch,
    });
    expect(moved).toMatchObject({
      start: "2026-10-23T14:00:00-03:00",
      seriesId: "series-1",
    });
  });

  it("moves the whole series from the dragged occurrence, leaving the shift to Main", async () => {
    // The UI sends the dragged occurrence's new bounds with scope "series";
    // CalendarKit shifts the series by the day difference from that
    // occurrence, so its first date never becomes the dragged one.
    const updateEvent = vi.fn(async () => wednesday);
    const { source, event } = await readWednesday({ updateEvent });
    const patch = {
      start: "2026-10-22T14:00:00-03:00",
      end: "2026-10-22T15:30:00-03:00",
      timeZone: "America/Sao_Paulo",
    };

    await source.update(event, "series", patch);

    expect(updateEvent).toHaveBeenCalledWith({
      eventId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
      scope: "series",
      patch,
    });
  });

  it("moves to another Mac calendar with targetCalendarId", async () => {
    const updateEvent = vi.fn(async () => macEvent({ calendarId: "work" }));
    const source = macCalendarSource(
      calendarBridge({
        updateEvent,
        events: vi.fn(async () => ({ events: [macEvent()], truncated: false })),
      })
    );
    const [event] = (
      await source.events(
        ["home"],
        "2026-10-19T00:00:00-03:00",
        "2026-10-26T00:00:00-03:00",
        signal
      )
    ).events;

    const moved = await source.update(event!, "instance", { title: "Novo" }, "work");

    expect(updateEvent).toHaveBeenCalledWith({
      eventId: "evt-1",
      occurrenceDate: null,
      scope: "instance",
      patch: { title: "Novo" },
      targetCalendarId: "work",
    });
    expect(moved.key).toBe("mac:mac:work:evt-1");
  });

  it("deletes with the scope and reports a missing event", async () => {
    const deleteEvent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ error: "calendar_event_not_found" });
    const { source, event } = await readWednesday({ deleteEvent });

    await source.remove(event, "series");
    expect(deleteEvent).toHaveBeenCalledWith({
      eventId: "series-1",
      occurrenceDate: "2026-10-21T13:00:00Z",
      scope: "series",
    });
    const failure = await source
      .remove(event, "instance")
      .catch((error: unknown) => error);
    expect(agendaErrorCode(failure)).toBe("not_found");
  });
});

const revisionState = (revision: number): CalendarState => ({
  access: "fullAccess",
  available: true,
  revision,
});

describe("macCalendarSource subscribe", () => {
  it("reports a change only when the revision grows past the replayed one", () => {
    let publish!: (state: CalendarState) => void;
    const stop = vi.fn();
    const source = macCalendarSource(
      calendarBridge({
        state: {
          subscribe: (listener: (state: CalendarState) => void) => {
            publish = listener;
            return stop;
          },
        },
      })
    );
    const onChange = vi.fn();
    const unsubscribe = source.subscribe!(onChange);

    publish(revisionState(3));
    expect(onChange).not.toHaveBeenCalled();
    publish(revisionState(3));
    publish(revisionState(4));
    publish(revisionState(2));
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(stop).toHaveBeenCalled();
  });
});
