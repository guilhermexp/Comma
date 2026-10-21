import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localIsoString, systemTimeZone } from "./agendaDates";
import { agendaErrorCode, type AgendaErrorCode } from "./agendaErrors";
import { clampZoom } from "./agendaLayout";
import {
  agendaCalendarKey,
  type AgendaCalendar,
  type AgendaEvent,
  type AgendaEventInput,
  type AgendaScope,
  type AgendaSourceEntry,
  type AgendaSourceKind,
} from "./agendaSource";

// The Agenda's screen state: the calendars and events of the visible period,
// read from every source and kept only in memory (design D1). Each source
// fails on its own; a read that lost a race to a newer one is dropped.

export const agendaRefreshInterval = 60_000;

export type AgendaGroup = {
  entry: AgendaSourceEntry;
  status: "loading" | "ready" | "error";
  error?: AgendaErrorCode;
  calendars: AgendaCalendar[];
  truncated: boolean;
  failedCalendarIds: string[];
};

export type AgendaWriteError = { code: AgendaErrorCode; source: AgendaSourceKind };

type CalendarState = {
  status: "loading" | "ready" | "error";
  error?: AgendaErrorCode;
  calendars: AgendaCalendar[];
};
type EventState = {
  events: AgendaEvent[];
  truncated: boolean;
  failedCalendarIds: string[];
  error?: AgendaErrorCode;
};
type Pending = { id: number; remove: string[]; add: AgendaEvent[] };

type AgendaPreferences = {
  zoom: number;
  visibility: Record<string, boolean>;
  panelOpen: boolean;
  lastCalendarKey: string | null;
};

const defaultPreferences: AgendaPreferences = {
  zoom: 100,
  visibility: {},
  panelOpen: true,
  lastCalendarKey: null,
};

function preferencesKey(workspaceId: string) {
  return `comma.agenda.v1.${workspaceId}`;
}

function readPreferences(workspaceId: string): AgendaPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(preferencesKey(workspaceId)) ?? "null"
    ) as Partial<AgendaPreferences> | null;
    if (!stored || typeof stored !== "object") return defaultPreferences;
    const visibility: Record<string, boolean> = {};
    if (stored.visibility && typeof stored.visibility === "object") {
      for (const [key, value] of Object.entries(stored.visibility))
        if (typeof value === "boolean") visibility[key] = value;
    }
    return {
      zoom: clampZoom(Number(stored.zoom ?? 100)),
      visibility,
      panelOpen: stored.panelOpen !== false,
      lastCalendarKey:
        typeof stored.lastCalendarKey === "string" ? stored.lastCalendarKey : null,
    };
  } catch {
    return defaultPreferences;
  }
}

function writePreferences(workspaceId: string, preferences: AgendaPreferences) {
  try {
    localStorage.setItem(preferencesKey(workspaceId), JSON.stringify(preferences));
  } catch {
    // Unavailable storage leaves the choice for this session only.
  }
}

export function eventCalendarKey(event: AgendaEvent) {
  return agendaCalendarKey(event.source, event.accountId, event.calendarId);
}

function patchedEvent(
  event: AgendaEvent,
  patch: Partial<AgendaEventInput>,
  target?: AgendaCalendar
): AgendaEvent {
  return {
    ...event,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.start !== undefined ? { start: patch.start } : {}),
    ...(patch.end !== undefined ? { end: patch.end } : {}),
    ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    ...(patch.location !== undefined ? { location: patch.location } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(target
      ? { calendarId: target.id, accountId: target.accountId, source: target.source }
      : {}),
  };
}

function abortedError(signal: AbortSignal) {
  return signal.aborted;
}

export function useAgendaData({
  workspaceId,
  entries,
  start,
  end,
}: {
  workspaceId: string;
  entries: readonly AgendaSourceEntry[];
  start: Date;
  end: Date;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(workspaceId));
  const [calendarStates, setCalendarStates] = useState<Record<string, CalendarState>>(
    {}
  );
  const [eventStates, setEventStates] = useState<Record<string, EventState>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [writeError, setWriteError] = useState<AgendaWriteError | null>(null);
  const [calendarRetry, setCalendarRetry] = useState<Record<string, number>>({});

  const entriesKey = entries.map((entry) => entry.key).join("\n");
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(
    () => writePreferences(workspaceId, preferences),
    [workspaceId, preferences]
  );

  // Mac calendars of an account the reader also connected to Google start
  // hidden, so the same event does not show twice (design D5).
  const googleEmails = useMemo(() => {
    const emails = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== "google") continue;
      if (entry.email) emails.add(entry.email.toLowerCase());
      for (const calendar of calendarStates[entry.key]?.calendars ?? [])
        if (calendar.ownerEmail) emails.add(calendar.ownerEmail.toLowerCase());
    }
    return emails;
  }, [entries, calendarStates]);

  const isVisible = useCallback(
    (calendar: AgendaCalendar) =>
      preferences.visibility[calendar.key] ??
      !(
        calendar.source === "mac" &&
        calendar.ownerEmail !== null &&
        googleEmails.has(calendar.ownerEmail.toLowerCase())
      ),
    [preferences.visibility, googleEmails]
  );

  // Calendars, per source.
  const calendarGeneration = useRef<Record<string, number>>({});
  const calendarRetryKey = JSON.stringify(calendarRetry);
  useEffect(() => {
    const controllers = entriesRef.current.map((entry) => {
      const controller = new AbortController();
      const generation = (calendarGeneration.current[entry.key] ?? 0) + 1;
      calendarGeneration.current[entry.key] = generation;
      const current = () =>
        !controller.signal.aborted &&
        calendarGeneration.current[entry.key] === generation;
      setCalendarStates((states) => ({
        ...states,
        [entry.key]: {
          calendars: states[entry.key]?.calendars ?? [],
          status: states[entry.key]?.status === "ready" ? "ready" : "loading",
        },
      }));
      entry.source.calendars(controller.signal).then(
        (calendars) => {
          if (!current()) return;
          setCalendarStates((states) => ({
            ...states,
            [entry.key]: { status: "ready", calendars },
          }));
        },
        (error: unknown) => {
          if (!current()) return;
          // A failed read removes nothing the last good read listed.
          setCalendarStates((states) => ({
            ...states,
            [entry.key]: {
              status: "error",
              error: agendaErrorCode(error),
              calendars: states[entry.key]?.calendars ?? [],
            },
          }));
        }
      );
      return controller;
    });
    return () => controllers.forEach((controller) => controller.abort());
  }, [entriesKey, calendarRetryKey]);

  const visibleIds = useMemo(() => {
    const ids: Record<string, string[]> = {};
    for (const entry of entries) {
      const state = calendarStates[entry.key];
      if (!state || state.status === "loading") continue;
      ids[entry.key] = state.calendars
        .filter((calendar) => isVisible(calendar))
        .map((calendar) => calendar.id);
    }
    return ids;
  }, [entries, calendarStates, isVisible]);

  // Events of the visible period, per source.
  const startTime = start.getTime();
  const endTime = end.getTime();
  const range = useMemo(
    () => ({
      start: localIsoString(new Date(startTime)),
      end: localIsoString(new Date(endTime)),
    }),
    [startTime, endTime]
  );
  const latest = useRef({ range, visibleIds });
  latest.current = { range, visibleIds };
  const eventGeneration = useRef<Record<string, number>>({});
  const eventControllers = useRef<Record<string, AbortController>>({});

  const loadEvents = useCallback(async (entry: AgendaSourceEntry) => {
    const ids = latest.current.visibleIds[entry.key];
    if (!ids) return;
    eventControllers.current[entry.key]?.abort();
    const controller = new AbortController();
    eventControllers.current[entry.key] = controller;
    const generation = (eventGeneration.current[entry.key] ?? 0) + 1;
    eventGeneration.current[entry.key] = generation;
    const current = () =>
      !abortedError(controller.signal) &&
      eventGeneration.current[entry.key] === generation;
    if (ids.length === 0) {
      setEventStates((states) => ({
        ...states,
        [entry.key]: { events: [], truncated: false, failedCalendarIds: [] },
      }));
      return;
    }
    const { start: from, end: to } = latest.current.range;
    try {
      const result = await entry.source.events(ids, from, to, controller.signal);
      if (!current()) return;
      setEventStates((states) => ({
        ...states,
        [entry.key]: {
          events: result.events,
          truncated: result.truncated,
          failedCalendarIds: result.failedCalendarIds,
        },
      }));
    } catch (error) {
      if (!current()) return;
      setEventStates((states) => ({
        ...states,
        [entry.key]: {
          events: states[entry.key]?.events ?? [],
          truncated: false,
          failedCalendarIds: [],
          error: agendaErrorCode(error),
        },
      }));
    }
  }, []);

  const refresh = useCallback(
    () =>
      Promise.all(entriesRef.current.map((entry) => loadEvents(entry))).then(() => {}),
    [loadEvents]
  );

  const eventsKey = JSON.stringify([range, visibleIds]);
  useEffect(() => {
    void refresh();
  }, [eventsKey, refresh]);
  useEffect(
    () => () => Object.values(eventControllers.current).forEach((c) => c.abort()),
    []
  );

  // Read again on focus, when the window shows, every minute while visible,
  // and when a source reports a change.
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, agendaRefreshInterval);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = entriesRef.current.map(
      (entry) => entry.source.subscribe?.(() => void loadEvents(entry)) ?? (() => {})
    );
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe.forEach((stop) => stop());
    };
  }, [entriesKey, refresh, loadEvents]);

  const groups = useMemo(
    () =>
      entries.map((entry): AgendaGroup => {
        const calendarState = calendarStates[entry.key];
        const eventState = eventStates[entry.key];
        const error = calendarState?.error ?? eventState?.error;
        return {
          entry,
          status:
            calendarState?.status === "error" || eventState?.error
              ? "error"
              : (calendarState?.status ?? "loading"),
          ...(error ? { error } : {}),
          calendars: calendarState?.calendars ?? [],
          truncated: eventState?.truncated ?? false,
          failedCalendarIds: eventState?.failedCalendarIds ?? [],
        };
      }),
    [entries, calendarStates, eventStates]
  );

  const calendars = useMemo(() => groups.flatMap((group) => group.calendars), [groups]);
  const calendarByKey = useMemo(
    () => new Map(calendars.map((calendar) => [calendar.key, calendar])),
    [calendars]
  );

  const events = useMemo(() => {
    const shown = entries.flatMap((entry) => eventStates[entry.key]?.events ?? []);
    const removed = new Set(pending.flatMap((item) => item.remove));
    const visible = (event: AgendaEvent) => {
      const calendar = calendarByKey.get(eventCalendarKey(event));
      return calendar ? isVisible(calendar) : false;
    };
    return [
      ...shown.filter((event) => !removed.has(event.key)),
      ...pending.flatMap((item) => item.add),
    ].filter(visible);
  }, [entries, eventStates, pending, calendarByKey, isVisible]);

  const pendingCounter = useRef(0);
  const addPending = (remove: string[], add: AgendaEvent[]) => {
    const id = ++pendingCounter.current;
    setPending((items) => [...items, { id, remove, add }]);
    return id;
  };
  const replacePending = (id: number, remove: string[], add: AgendaEvent[]) =>
    setPending((items) =>
      items.map((item) => (item.id === id ? { id, remove, add } : item))
    );
  const dropPending = (id: number) =>
    setPending((items) => items.filter((item) => item.id !== id));

  const entryOf = useCallback(
    (owner: { source: AgendaSourceKind; accountId: string | null }) =>
      entriesRef.current.find(
        (entry) =>
          entry.kind === owner.source &&
          (owner.source === "mac" || entry.accountId === owner.accountId)
      ),
    []
  );

  // Every write shows at once, settles with the source's answer and a fresh
  // read, and is undone with the reason when the source refuses it.
  const write = useCallback(
    async (
      kind: AgendaSourceKind,
      remove: string[],
      add: AgendaEvent[],
      run: (settle: (event: AgendaEvent | null) => void) => Promise<void>
    ) => {
      const id = addPending(remove, add);
      setWriteError(null);
      try {
        await run((event) => replacePending(id, remove, event ? [event] : []));
        await refresh();
        return true;
      } catch (error) {
        setWriteError({ code: agendaErrorCode(error), source: kind });
        void refresh();
        return false;
      } finally {
        dropPending(id);
      }
    },
    [refresh]
  );

  const create = useCallback(
    (calendar: AgendaCalendar, input: AgendaEventInput) => {
      const entry = entryOf(calendar);
      if (!entry) return Promise.resolve(false);
      const draft: AgendaEvent = {
        key: `pending:${calendar.key}:${Date.now()}`,
        source: calendar.source,
        accountId: calendar.accountId,
        calendarId: calendar.id,
        id: "",
        seriesId: null,
        occurrenceDate: null,
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: input.allDay,
        location: input.location ?? null,
        description: input.description ?? null,
        url: null,
        color: null,
        editable: false,
        etag: null,
      };
      setPreferences((value) => ({ ...value, lastCalendarKey: calendar.key }));
      return write(calendar.source, [], [draft], async (settle) => {
        settle(await entry.source.create(calendar.id, input));
      });
    },
    [entryOf, write]
  );

  const update = useCallback(
    (
      event: AgendaEvent,
      scope: AgendaScope,
      patch: Partial<AgendaEventInput>,
      target?: AgendaCalendar
    ) => {
      const entry = entryOf(event);
      const targetEntry = target ? entryOf(target) : entry;
      if (!entry || !targetEntry) return Promise.resolve(false);
      const optimistic = patchedEvent(event, patch, target);
      return write(event.source, [event.key], [optimistic], async (settle) => {
        if (targetEntry !== entry && target) {
          // Another source or account: create there, and delete the original
          // only once the copy exists.
          const created = await targetEntry.source.create(target.id, {
            title: event.title,
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            timeZone: systemTimeZone(),
            location: event.location,
            description: event.description,
            recurrence: "none",
            ...patch,
          });
          settle(created);
          await entry.source.remove(event, scope);
          return;
        }
        settle(
          await entry.source.update(
            event,
            scope,
            patch,
            target && target.id !== event.calendarId ? target.id : undefined
          )
        );
      });
    },
    [entryOf, write]
  );

  const remove = useCallback(
    (event: AgendaEvent, scope: AgendaScope) => {
      const entry = entryOf(event);
      if (!entry) return Promise.resolve(false);
      const keys =
        scope === "series" && event.seriesId
          ? events
              .filter(
                (item) =>
                  item.seriesId === event.seriesId &&
                  eventCalendarKey(item) === eventCalendarKey(event)
              )
              .map((item) => item.key)
          : [event.key];
      return write(event.source, keys, [], async () => {
        await entry.source.remove(event, scope);
      });
    },
    [entryOf, events, write]
  );

  return {
    groups,
    calendars,
    calendarByKey,
    events,
    isVisible,
    setVisible: useCallback(
      (calendar: AgendaCalendar, visible: boolean) =>
        setPreferences((value) => ({
          ...value,
          visibility: { ...value.visibility, [calendar.key]: visible },
        })),
      []
    ),
    zoom: preferences.zoom,
    setZoom: useCallback(
      (zoom: number) =>
        setPreferences((value) => ({ ...value, zoom: clampZoom(zoom) })),
      []
    ),
    panelOpen: preferences.panelOpen,
    setPanelOpen: useCallback(
      (panelOpen: boolean) => setPreferences((value) => ({ ...value, panelOpen })),
      []
    ),
    lastCalendarKey: preferences.lastCalendarKey,
    retry: useCallback(
      (entryKey: string) => {
        setCalendarRetry((value) => ({
          ...value,
          [entryKey]: (value[entryKey] ?? 0) + 1,
        }));
        const entry = entriesRef.current.find((item) => item.key === entryKey);
        if (entry) void loadEvents(entry);
      },
      [loadEvents]
    ),
    refresh,
    create,
    update,
    remove,
    writeError,
    clearWriteError: useCallback(() => setWriteError(null), []),
  };
}

export type AgendaData = ReturnType<typeof useAgendaData>;
