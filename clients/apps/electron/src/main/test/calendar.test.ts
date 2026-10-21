import type { CalendarEvent, CalendarState } from "@comma/native-bridge";
import { describe, expect, it, vi } from "vitest";
import type { CalendarKitAddon } from "../../../native/macos/CalendarKit";
import {
  CALENDAR_PRIVACY_SETTINGS_URLS,
  CalendarService,
} from "../modules/calendar/index";

const secretTitle = "Dentist with Ana";
const secretLocation = "Rua Secreta 42";
const secretNotes = "bring the exam results";

function macEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    calendarId: "cal-1",
    detached: false,
    editable: true,
    end: "2026-10-21T11:00:00-03:00",
    eventId: "item-1",
    externalId: null,
    location: secretLocation,
    notes: secretNotes,
    occurrenceDate: null,
    occurrenceId: "item-1",
    recurrence: "none",
    start: "2026-10-21T10:00:00-03:00",
    title: secretTitle,
    url: null,
    ...overrides,
  };
}

function fakeAddon(overrides: Partial<CalendarKitAddon> = {}) {
  let listener: (() => void) | undefined;
  const addon: CalendarKitAddon = {
    loaded: true,
    accessStatus: () => "fullAccess",
    requestAccess: async () => "fullAccess",
    calendars: async () => ({ calendars: [] }),
    events: async () => ({ events: [], truncated: false }),
    event: async () => macEvent(),
    createEvent: async () => macEvent(),
    updateEvent: async () => macEvent(),
    deleteEvent: async () => undefined,
    observeChanges: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    ...overrides,
  };
  return { addon, change: () => listener?.(), observing: () => listener !== undefined };
}

function service(addon: CalendarKitAddon, extra: Partial<ConstructorParameters<typeof CalendarService>[0]> = {}) {
  const published: CalendarState[] = [];
  const logger = { warn: vi.fn() };
  const calendar = new CalendarService({
    addon,
    logger,
    onStateChanged: (state) => published.push(state),
    openExternal: async () => undefined,
    ...extra,
  });
  return { calendar, logger, published };
}

const week = { start: "2026-10-19T00:00:00-03:00", end: "2026-10-26T00:00:00-03:00" };

describe("CalendarService limits", () => {
  it("returns at most 500 calendars", async () => {
    const calendars = Array.from({ length: 501 }, (_, index) => ({
      color: "#ff0000",
      id: `cal-${index}`,
      isDefault: false,
      sourceTitle: "iCloud",
      sourceType: "calDAV" as const,
      title: `Calendar ${index}`,
      writable: true,
    }));
    const { calendar } = service(fakeAddon({ calendars: async () => ({ calendars }) }).addon);
    const result = await calendar.calendars();
    expect("calendars" in result && result.calendars).toHaveLength(500);
  });

  it("asks the addon for at most 2,500 occurrences and marks a cut list truncated", async () => {
    const events = vi.fn(async ({ limit }: { limit: number }) => ({
      events: Array.from({ length: limit + 1 }, (_, index) =>
        macEvent({ occurrenceId: `item-${index}` })
      ),
      truncated: false,
    }));
    const { calendar } = service(fakeAddon({ events }).addon);
    const result = await calendar.events({ calendarIds: ["cal-1"], ...week });
    expect(events).toHaveBeenCalledWith({ calendarIds: ["cal-1"], ...week, limit: 2_500 });
    expect(result).toMatchObject({ truncated: true });
    expect("events" in result && result.events).toHaveLength(2_500);
  });

  it("refuses a range longer than 62 days or one that ends before it starts", async () => {
    const events = vi.fn();
    const { calendar } = service(fakeAddon({ events }).addon);
    await expect(
      calendar.events({
        calendarIds: ["cal-1"],
        start: "2026-10-01T00:00:00Z",
        end: "2026-12-03T00:00:01Z",
      })
    ).rejects.toThrow(RangeError);
    await expect(
      calendar.events({ calendarIds: ["cal-1"], start: week.end, end: week.start })
    ).rejects.toThrow(RangeError);
    await expect(
      calendar.events({ calendarIds: Array.from({ length: 501 }, (_, i) => `c${i}`), ...week })
    ).rejects.toThrow(RangeError);
    expect(events).not.toHaveBeenCalled();
  });

  it("refuses an event whose end is not after its start or mixes all-day forms", async () => {
    const createEvent = vi.fn();
    const { calendar } = service(fakeAddon({ createEvent }).addon);
    const base = {
      allDay: false,
      recurrence: "none" as const,
      timeZone: "America/Sao_Paulo",
      title: "x",
    };
    await expect(
      calendar.createEvent({
        calendarId: "cal-1",
        event: { ...base, start: "2026-10-21T10:00:00Z", end: "2026-10-21T10:00:00Z" },
      })
    ).rejects.toThrow(RangeError);
    await expect(
      calendar.createEvent({
        calendarId: "cal-1",
        event: { ...base, allDay: true, start: "2026-10-21T10:00:00Z", end: "2026-10-22" },
      })
    ).rejects.toThrow(RangeError);
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe("CalendarService access and errors", () => {
  it("answers calendar_access_denied without reading when access is not full", async () => {
    for (const access of ["notDetermined", "denied", "restricted", "writeOnly"] as const) {
      const calendars = vi.fn();
      const { calendar } = service(
        fakeAddon({ accessStatus: () => access, calendars }).addon
      );
      await expect(calendar.calendars()).resolves.toEqual({
        error: "calendar_access_denied",
      });
      await expect(
        calendar.deleteEvent({ eventId: "item-1", occurrenceDate: null, scope: "instance" })
      ).resolves.toEqual({ error: "calendar_access_denied" });
      expect(calendars).not.toHaveBeenCalled();
    }
  });

  it("passes the addon's domain errors through", async () => {
    const { calendar } = service(
      fakeAddon({ createEvent: async () => ({ error: "calendar_read_only" }) }).addon
    );
    await expect(
      calendar.createEvent({
        calendarId: "subscribed",
        event: {
          allDay: false,
          end: "2026-10-21T11:00:00Z",
          recurrence: "none",
          start: "2026-10-21T10:00:00Z",
          timeZone: "UTC",
          title: "x",
        },
      })
    ).resolves.toEqual({ error: "calendar_read_only" });
  });

  it("maps an unexpected addon failure to calendar_unavailable", async () => {
    const { calendar } = service(
      fakeAddon({
        event: async () => {
          throw new Error("XPC connection interrupted");
        },
      }).addon
    );
    await expect(
      calendar.event({ eventId: "item-1", occurrenceDate: null })
    ).resolves.toEqual({ error: "calendar_unavailable" });
  });

  it("is unavailable without the addon and never asks the OS", async () => {
    const requestAccess = vi.fn();
    const { calendar } = service(
      fakeAddon({ loaded: false, accessStatus: () => "unavailable", requestAccess }).addon
    );
    await expect(calendar.state()).resolves.toEqual({
      access: "unavailable",
      available: false,
      revision: 1,
    });
    await expect(calendar.requestAccess()).resolves.toBe("unavailable");
    await expect(calendar.calendars()).resolves.toEqual({ error: "calendar_unavailable" });
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("does not ask for access on its own and publishes the answer of a request", async () => {
    let access: "notDetermined" | "fullAccess" = "notDetermined";
    const requestAccess = vi.fn(async () => {
      access = "fullAccess";
      return access;
    });
    const fake = fakeAddon({ accessStatus: () => access, requestAccess });
    const { calendar, published } = service(fake.addon);
    calendar.start();
    expect(requestAccess).not.toHaveBeenCalled();
    expect(fake.observing()).toBe(false);

    await expect(calendar.requestAccess()).resolves.toBe("fullAccess");
    expect(published.at(-1)).toEqual({ access: "fullAccess", available: true, revision: 2 });
    expect(fake.observing()).toBe(true);
  });

  it("opens Privacy > Calendars, falling back through the known Settings URLs", async () => {
    const opened: string[] = [];
    const openExternal = vi.fn(async (url: string) => {
      opened.push(url);
      if (opened.length < 3) throw new Error("no handler");
    });
    const { calendar } = service(fakeAddon().addon, { openExternal });
    await calendar.openPrivacySettings();
    expect(opened).toEqual(CALENDAR_PRIVACY_SETTINGS_URLS.slice(0, 3));
    expect(CALENDAR_PRIVACY_SETTINGS_URLS).toEqual([
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
      "x-apple.systempreferences:com.apple.preference.security",
    ]);
  });
});

describe("CalendarService change notices", () => {
  it("coalesces a burst of database changes into one revision per 500 ms", () => {
    vi.useFakeTimers();
    try {
      const fake = fakeAddon();
      const { calendar, published } = service(fake.addon);
      calendar.start();
      fake.change();
      fake.change();
      vi.advanceTimersByTime(499);
      fake.change();
      expect(published).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(published).toEqual([{ access: "fullAccess", available: true, revision: 2 }]);
      fake.change();
      vi.advanceTimersByTime(500);
      expect(published.map((state) => state.revision)).toEqual([2, 3]);
      calendar.close();
      expect(fake.observing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CalendarService logs", () => {
  it("logs only the error code, never the event's title, location or notes", async () => {
    const { calendar, logger } = service(
      fakeAddon({
        updateEvent: async () => {
          throw new Error(`failed to save ${secretTitle} at ${secretLocation}: ${secretNotes}`);
        },
        events: async () => ({ error: "calendar_unavailable" }),
      }).addon
    );
    await calendar.updateEvent({
      eventId: "item-1",
      occurrenceDate: null,
      patch: { location: secretLocation, title: secretTitle, description: secretNotes },
      scope: "instance",
    });
    await calendar.events({ calendarIds: ["cal-1"], ...week });
    expect(logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain("calendar_unavailable");
    for (const secret of [secretTitle, secretLocation, secretNotes]) {
      expect(logged).not.toContain(secret);
    }
  });
});
