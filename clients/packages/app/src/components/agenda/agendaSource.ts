// The one client-side shape every Agenda source maps into (design D5). Events
// are a transient read of their source: the Agenda keeps no copy of them.

export type AgendaSourceKind = "google" | "mac";

export type AgendaRecurrence = "none" | "daily" | "weekly" | "monthly" | "yearly";

export type AgendaCalendar = {
  key: string;
  source: AgendaSourceKind;
  accountId: string | null;
  id: string;
  name: string;
  color: string;
  writable: boolean;
  primary: boolean;
  ownerEmail: string | null;
  /** The Mac account a calendar belongs to; null for subscriptions. */
  sourceLabel?: string | null;
};

/**
 * One occurrence. A timed event's `start` and `end` are ISO instants with an
 * offset; an all-day event's are `YYYY-MM-DD` calendar dates with an
 * exclusive `end`, never shifted by time zone.
 */
export type AgendaEvent = {
  key: string;
  source: AgendaSourceKind;
  accountId: string | null;
  calendarId: string;
  id: string;
  seriesId: string | null;
  occurrenceDate: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  url: string | null;
  color: string | null;
  editable: boolean;
  etag: string | null;
};

export type AgendaEventInput = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location?: string | null;
  description?: string | null;
  recurrence: AgendaRecurrence;
};

export type AgendaScope = "instance" | "series";

export interface AgendaSource {
  calendars(signal: AbortSignal): Promise<AgendaCalendar[]>;
  events(
    calendarIds: string[],
    start: string,
    end: string,
    signal: AbortSignal
  ): Promise<{
    events: AgendaEvent[];
    truncated: boolean;
    failedCalendarIds: string[];
  }>;
  recurrence(event: AgendaEvent): Promise<AgendaRecurrence | "custom">;
  create(calendarId: string, input: AgendaEventInput): Promise<AgendaEvent>;
  update(
    event: AgendaEvent,
    scope: AgendaScope,
    patch: Partial<AgendaEventInput>,
    targetCalendarId?: string
  ): Promise<AgendaEvent>;
  remove(event: AgendaEvent, scope: AgendaScope): Promise<void>;
  subscribe?(onChange: () => void): () => void;
}

/**
 * A source the Agenda shows as one group of its calendar panel: one per
 * connected Google account, and one for the Mac calendar when the host has it.
 */
export type AgendaSourceEntry = {
  key: string;
  kind: AgendaSourceKind;
  accountId: string | null;
  label: string;
  email: string | null;
  source: AgendaSource;
};

export function agendaEventKey(
  source: AgendaSourceKind,
  accountId: string | null,
  calendarId: string,
  id: string
) {
  return `${source}:${accountId ?? "mac"}:${calendarId}:${id}`;
}

export function agendaCalendarKey(
  source: AgendaSourceKind,
  accountId: string | null,
  calendarId: string
) {
  return `${source}:${accountId ?? "mac"}:${calendarId}`;
}
