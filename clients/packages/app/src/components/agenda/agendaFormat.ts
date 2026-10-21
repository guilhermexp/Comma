import type { useCommaMessages } from "@comma/i18n/react";
import type { CSSProperties } from "react";
import { eventBounds } from "./agendaDates";
import type { AgendaEvent } from "./agendaSource";

type Messages = ReturnType<typeof useCommaMessages>;

export function formatBusy(minutes: number, m: Messages): string {
  if (minutes <= 0) return m.agenda_no_busy_time();
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return m.agenda_duration_minutes({ minutes: String(rest) });
  if (rest === 0) return m.agenda_duration_hours({ hours: String(hours) });
  return m.agenda_duration_hours_minutes({
    hours: String(hours),
    minutes: String(rest),
  });
}

export function formatTime(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
    date
  );
}

export function formatEventTime(event: AgendaEvent, locale: string) {
  const { start, end } = eventBounds(event);
  return `${formatTime(start, locale)}–${formatTime(end, locale)}`;
}

export function formatWeekday(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { weekday: "short" })
    .format(date)
    .replace(/\.$/, "");
}

export function formatDayMonth(date: Date, locale: string) {
  if (locale.startsWith("zh"))
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
      date
    );
  const month = new Intl.DateTimeFormat(locale, { month: "short" })
    .format(date)
    .replace(/\.$/, "");
  return `${date.getDate()} ${month}`;
}

export function eventTitle(event: AgendaEvent, m: Messages): string {
  return event.title.trim() || m.agenda_untitled();
}

/** A tinted fill and a solid side bar in the calendar's colour. */
export function eventColorStyle(color: string) {
  return {
    "--agenda-event-color": color,
    backgroundColor: `color-mix(in srgb, ${color} 14%, var(--color-bg-primary))`,
    borderLeftColor: color,
  } as CSSProperties;
}
