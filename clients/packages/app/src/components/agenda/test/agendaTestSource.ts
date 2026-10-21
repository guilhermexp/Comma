import { vi } from "vitest";
import {
  agendaCalendarKey,
  agendaEventKey,
  type AgendaCalendar,
  type AgendaEvent,
  type AgendaSource,
  type AgendaSourceEntry,
  type AgendaSourceKind,
} from "../agendaSource";

// An in-memory source for tests only: production sources are Google (C1) and,
// after integration, the Mac calendar (C2).

export function testCalendar(
  source: AgendaSourceKind,
  accountId: string | null,
  id: string,
  extra: Partial<AgendaCalendar> = {}
): AgendaCalendar {
  return {
    key: agendaCalendarKey(source, accountId, id),
    source,
    accountId,
    id,
    name: id,
    color: "#3b82f6",
    writable: true,
    primary: false,
    ownerEmail: null,
    ...extra,
  };
}

export function testEvent(
  calendar: AgendaCalendar,
  id: string,
  start: string,
  end: string,
  extra: Partial<AgendaEvent> = {}
): AgendaEvent {
  return {
    key: agendaEventKey(calendar.source, calendar.accountId, calendar.id, id),
    source: calendar.source,
    accountId: calendar.accountId,
    calendarId: calendar.id,
    id,
    seriesId: null,
    occurrenceDate: null,
    title: id,
    start,
    end,
    allDay: /^\d{4}-\d{2}-\d{2}$/.test(start),
    location: null,
    description: null,
    url: null,
    color: null,
    editable: calendar.writable,
    etag: null,
    ...extra,
  };
}

export function testSource(calendars: AgendaCalendar[], events: AgendaEvent[]) {
  const state = { calendars, events: [...events] };
  let counter = 0;
  const source = {
    calendars: vi.fn(async (_signal: AbortSignal) => state.calendars),
    events: vi.fn(async (calendarIds: string[], start: string, end: string) => ({
      events: state.events.filter(
        (event) =>
          calendarIds.includes(event.calendarId) &&
          (event.allDay ? event.end > start.slice(0, 10) : event.end > start) &&
          (event.allDay ? event.start < end.slice(0, 10) : event.start < end)
      ),
      truncated: false,
      failedCalendarIds: [],
    })),
    recurrence: vi.fn(async (_event: AgendaEvent) => "none" as const),
    create: vi.fn(async (calendarId: string, input) => {
      const calendar = state.calendars.find((item) => item.id === calendarId)!;
      const created = testEvent(calendar, `new-${++counter}`, input.start, input.end, {
        title: input.title,
        allDay: input.allDay,
        location: input.location ?? null,
        description: input.description ?? null,
      });
      state.events.push(created);
      return created;
    }),
    update: vi.fn(
      async (event: AgendaEvent, _scope, patch, targetCalendarId?: string) => {
        const index = state.events.findIndex((item) => item.key === event.key);
        const calendar = state.calendars.find(
          (item) => item.id === (targetCalendarId ?? event.calendarId)
        )!;
        const updated: AgendaEvent = {
          ...event,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.start !== undefined ? { start: patch.start } : {}),
          ...(patch.end !== undefined ? { end: patch.end } : {}),
          ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          calendarId: calendar.id,
          key: agendaEventKey(
            calendar.source,
            calendar.accountId,
            calendar.id,
            event.id
          ),
        };
        state.events[index] = updated;
        return updated;
      }
    ),
    remove: vi.fn(async (event: AgendaEvent) => {
      state.events = state.events.filter((item) => item.key !== event.key);
    }),
  } satisfies AgendaSource;
  return { source, state };
}

export function testEntry(
  key: string,
  kind: AgendaSourceKind,
  source: AgendaSource,
  extra: Partial<AgendaSourceEntry> = {}
): AgendaSourceEntry {
  return {
    key,
    kind,
    accountId: kind === "google" ? key : null,
    label: key,
    email: null,
    source,
    ...extra,
  };
}
