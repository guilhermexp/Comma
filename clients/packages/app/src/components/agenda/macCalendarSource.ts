import {
  getNativeBridge,
  type CalendarError,
  type CalendarEvent,
  type CalendarState,
  type CalendarSummary,
  type CommaNativeBridge,
} from "@comma/native-bridge";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  agendaCalendarKey,
  agendaEventKey,
  type AgendaCalendar,
  type AgendaEvent,
  type AgendaEventInput,
  type AgendaSource,
  type AgendaSourceEntry,
} from "./agendaSource";

// The Agenda's Mac source: the `calendar.*` leaves (contract C2), which read
// and write the Mac Calendar through EventKit in Main. Events stay on this
// computer; a domain failure comes back as `{ error }` and is thrown here
// with that code, so the screen maps it like a Google error.

type MacCalendarBridge = CommaNativeBridge["calendar"];

export class MacCalendarError extends Error {
  readonly code: CalendarError["error"];
  constructor(code: CalendarError["error"]) {
    super(code);
    this.code = code;
  }
}

function settled<T extends object>(result: T | CalendarError | void): T {
  if (result && "error" in result) throw new MacCalendarError(result.error);
  if (!result) throw new MacCalendarError("calendar_unavailable");
  return result;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A subscribed or birthdays calendar has no owning account. Only an e-mail
// account title can match a Google account the reader connected.
function calendarOf(summary: CalendarSummary): AgendaCalendar {
  const ownerless =
    summary.sourceType === "subscribed" || summary.sourceType === "birthdays";
  return {
    key: agendaCalendarKey("mac", null, summary.id),
    source: "mac",
    accountId: null,
    id: summary.id,
    name: summary.title,
    color: summary.color,
    writable: summary.writable,
    primary: summary.isDefault,
    ownerEmail:
      !ownerless && emailPattern.test(summary.sourceTitle) ? summary.sourceTitle : null,
    sourceLabel: ownerless ? null : summary.sourceTitle,
  };
}

// An occurrence of a series keeps the series id and its original date, which
// is how C2 addresses it for "only this" and "all".
function eventOf(event: CalendarEvent): AgendaEvent {
  const recurring =
    event.recurrence !== "none" || event.detached || event.occurrenceDate !== null;
  return {
    key: agendaEventKey("mac", null, event.calendarId, event.occurrenceId),
    source: "mac",
    accountId: null,
    calendarId: event.calendarId,
    id: event.occurrenceId,
    seriesId: recurring ? event.eventId : null,
    occurrenceDate: event.occurrenceDate,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.location,
    description: event.notes,
    url: event.url,
    color: null,
    editable: event.editable,
    etag: null,
  };
}

function reference(event: AgendaEvent) {
  return { eventId: event.seriesId ?? event.id, occurrenceDate: event.occurrenceDate };
}

function inputBody<Input extends Partial<AgendaEventInput>>(input: Input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Input;
}

export function macCalendarSource(calendar: MacCalendarBridge): AgendaSource {
  return {
    async calendars() {
      return settled(await calendar.calendars()).calendars.map(calendarOf);
    },
    async events(calendarIds, start, end) {
      const result = settled(await calendar.events({ calendarIds, start, end }));
      return {
        events: result.events.map(eventOf),
        truncated: result.truncated,
        failedCalendarIds: [],
      };
    },
    async recurrence(event) {
      return settled(await calendar.event(reference(event))).recurrence;
    },
    async create(calendarId, input) {
      return eventOf(
        settled(await calendar.createEvent({ calendarId, event: inputBody(input) }))
      );
    },
    async update(event, scope, patch, targetCalendarId) {
      return eventOf(
        settled(
          await calendar.updateEvent({
            ...reference(event),
            scope,
            patch: inputBody(patch),
            ...(targetCalendarId && targetCalendarId !== event.calendarId
              ? { targetCalendarId }
              : {}),
          })
        )
      );
    },
    async remove(event, scope) {
      const result = await calendar.deleteEvent({ ...reference(event), scope });
      if (result && "error" in result) throw new MacCalendarError(result.error);
    },
    subscribe(onChange) {
      // The first snapshot is the replay of the current revision.
      let revision: number | null = null;
      return calendar.state.subscribe((state) => {
        if (revision !== null && state.revision > revision) onChange();
        revision = Math.max(revision ?? 0, state.revision);
      });
    },
  };
}

/** Why the Mac group asks the reader to act instead of listing calendars. */
export type MacCalendarPrompt = {
  access: "notDetermined" | "denied" | "restricted" | "writeOnly";
  enable: () => void;
  openSettings: () => void;
};

/**
 * The Mac Calendar as an Agenda source, only in the desktop app on a Mac
 * where the `calendar.*` capability exists. The system prompt shows only
 * after the reader presses "Turn on"; with full access the source is listed,
 * otherwise the panel shows the prompt for the current access.
 */
export function useMacCalendar(label: string): {
  entry: AgendaSourceEntry | null;
  prompt: MacCalendarPrompt | null;
} {
  const bridge = getNativeBridge();
  const supported = bridge.platform === "electron";
  const [state, setState] = useState<CalendarState | null>(null);

  useEffect(() => {
    if (!supported) return;
    return bridge.calendar.state.subscribe(setState);
  }, [bridge, supported]);

  // macOS sends no notice when access changes in System Settings.
  useEffect(() => {
    if (!supported) return;
    const onFocus = () => void bridge.calendar.state.get().then(setState, () => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bridge, supported]);

  const enable = useCallback(() => {
    void bridge.calendar.requestAccess().then(
      () => bridge.calendar.state.get().then(setState),
      () => {}
    );
  }, [bridge]);
  const openSettings = useCallback(() => {
    void bridge.calendar.openPrivacySettings().catch(() => {});
  }, [bridge]);

  const access = supported && state?.available ? state.access : "unavailable";
  const entry = useMemo(
    (): AgendaSourceEntry | null =>
      access === "fullAccess"
        ? {
            key: "mac",
            kind: "mac",
            accountId: null,
            label,
            email: null,
            source: macCalendarSource(bridge.calendar),
          }
        : null,
    [access, bridge, label]
  );
  const prompt = useMemo(
    (): MacCalendarPrompt | null =>
      access === "notDetermined" ||
      access === "denied" ||
      access === "restricted" ||
      access === "writeOnly"
        ? { access, enable, openSettings }
        : null,
    [access, enable, openSettings]
  );
  return { entry, prompt };
}
