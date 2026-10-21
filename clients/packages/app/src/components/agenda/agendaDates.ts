import type { AgendaEvent } from "./agendaSource";

// Dates are local calendar days in the system time zone. A day is named by
// its `YYYY-MM-DD` key; all-day dates are never parsed as UTC instants.

export type AgendaView = "3days" | "week" | "month";

export const agendaViews: readonly AgendaView[] = ["3days", "week", "month"];

export type AgendaPeriod = {
  /** First shown day, local midnight. */
  start: Date;
  /** Day after the last shown day, local midnight. */
  end: Date;
  days: Date[];
  /** The day the view is about: the anchor, or the 1st for Month. */
  focus: Date;
};

const dateKeyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: string) {
  const match = dateKeyPattern.exec(value);
  if (!match) return false;
  const date = parseDateKey(value);
  return dateKey(date) === value;
}

export function parseDateKey(value: string): Date {
  const match = dateKeyPattern.exec(value);
  if (!match) return new Date(Number.NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function dateKey(date: Date) {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function sameDay(a: Date, b: Date) {
  return dateKey(a) === dateKey(b);
}

/** Monday of the week that contains `date`. */
export function startOfWeek(date: Date) {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7));
}

function dayRange(start: Date, count: number) {
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function agendaPeriod(view: AgendaView, anchor: string): AgendaPeriod {
  const day = parseDateKey(anchor);
  if (view === "3days") {
    return { start: day, end: addDays(day, 3), days: dayRange(day, 3), focus: day };
  }
  if (view === "week") {
    const start = startOfWeek(day);
    return { start, end: addDays(start, 7), days: dayRange(start, 7), focus: day };
  }
  const first = new Date(day.getFullYear(), day.getMonth(), 1);
  const last = new Date(day.getFullYear(), day.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 7);
  const count = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { start, end, days: dayRange(start, count), focus: first };
}

export function shiftAnchor(view: AgendaView, anchor: string, direction: 1 | -1) {
  const day = parseDateKey(anchor);
  if (view === "month") {
    return dateKey(new Date(day.getFullYear(), day.getMonth() + direction, 1));
  }
  return dateKey(addDays(day, (view === "week" ? 7 : 3) * direction));
}

function shortMonth(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short" })
    .format(date)
    .replace(/\.$/, "");
}

/** The period part of the title: "19 – 25 out 2026", "dezembro de 2026". */
export function agendaRangeLabel(
  period: AgendaPeriod,
  view: AgendaView,
  locale: string
) {
  if (view === "month") {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
      period.focus
    );
  }
  const first = period.start;
  const last = addDays(period.end, -1);
  if (locale.startsWith("zh")) {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).formatRange(first, last);
  }
  const lastLabel = `${last.getDate()} ${shortMonth(last, locale)} ${last.getFullYear()}`;
  if (first.getFullYear() !== last.getFullYear()) {
    return `${first.getDate()} ${shortMonth(first, locale)} ${first.getFullYear()} – ${lastLabel}`;
  }
  if (first.getMonth() !== last.getMonth()) {
    return `${first.getDate()} ${shortMonth(first, locale)} – ${lastLabel}`;
  }
  return `${first.getDate()} – ${lastLabel}`;
}

/** Local start and exclusive end of an event, as instants. */
export function eventBounds(event: AgendaEvent): { start: Date; end: Date } {
  if (event.allDay) {
    const start = parseDateKey(event.start);
    const end = parseDateKey(event.end);
    return { start, end: end > start ? end : addDays(start, 1) };
  }
  return { start: new Date(event.start), end: new Date(event.end) };
}

/** Whether an event belongs in the all-day row rather than the hour grid. */
export function isAllDayRowEvent(event: AgendaEvent) {
  if (event.allDay) return true;
  const { start, end } = eventBounds(event);
  return end.getTime() - start.getTime() >= 86_400_000;
}

export function eventsOnDay(events: readonly AgendaEvent[], day: Date) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return events
    .filter((event) => {
      const { start, end } = eventBounds(event);
      return (
        start < dayEnd && (end > dayStart || start.getTime() === dayStart.getTime())
      );
    })
    .toSorted((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return eventBounds(a).start.getTime() - eventBounds(b).start.getTime();
    });
}

/** Minutes of the day covered by timed events, overlaps counted once. */
export function busyMinutes(events: readonly AgendaEvent[], day: Date) {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(day, 1).getTime();
  const spans = events
    .filter((event) => !event.allDay)
    .map((event) => {
      const { start, end } = eventBounds(event);
      return [
        Math.max(start.getTime(), dayStart),
        Math.min(end.getTime(), dayEnd),
      ] as const;
    })
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = dayStart;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) total += end - from;
    cursor = Math.max(cursor, end);
  }
  return Math.round(total / 60_000);
}

/** Minutes since local midnight. */
export function minuteOfDay(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function atMinute(day: Date, minute: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute);
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** ISO instant with the local offset: what C1 calls "ISO com offset". */
export function localIsoString(date: Date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  return (
    `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}
