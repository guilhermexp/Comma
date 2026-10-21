import {
  addDays,
  eventBounds,
  isAllDayRowEvent,
  minuteOfDay,
  startOfDay,
} from "./agendaDates";
import type { AgendaEvent } from "./agendaSource";

export const agendaZoomMin = 75;
export const agendaZoomMax = 200;
export const agendaZoomStep = 25;
export const agendaSnapMinutes = 15;
const baseHourHeight = 62;

export function agendaHourHeight(zoom: number) {
  return (baseHourHeight * zoom) / 100;
}

export function clampZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return 100;
  const stepped = Math.round(zoom / agendaZoomStep) * agendaZoomStep;
  return Math.min(agendaZoomMax, Math.max(agendaZoomMin, stepped));
}

export function snapMinutes(minutes: number, step = agendaSnapMinutes) {
  const snapped = Math.round(minutes / step) * step;
  return snapped === 0 ? 0 : snapped;
}

export type TimedPlacement = {
  event: AgendaEvent;
  startMinute: number;
  endMinute: number;
  column: number;
  columns: number;
};

/**
 * Timed events of one day, clipped to it. Events that collide share their
 * group's width in columns, each taking the first column free at its start.
 */
export function layoutTimedEvents(
  events: readonly AgendaEvent[],
  day: Date
): TimedPlacement[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const items = events
    .filter((event) => !isAllDayRowEvent(event))
    .flatMap((event) => {
      const { start, end } = eventBounds(event);
      if (start >= dayEnd || end <= dayStart) return [];
      const startMinute = start < dayStart ? 0 : minuteOfDay(start);
      const endMinute = end >= dayEnd ? 1440 : minuteOfDay(end);
      return [{ event, startMinute, endMinute: Math.max(endMinute, startMinute + 15) }];
    })
    .toSorted(
      (a, b) =>
        a.startMinute - b.startMinute ||
        b.endMinute - a.endMinute ||
        a.event.key.localeCompare(b.event.key)
    );

  const placed: TimedPlacement[] = [];
  let group: TimedPlacement[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;
  const closeGroup = () => {
    for (const item of group) item.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  };
  for (const item of items) {
    if (item.startMinute >= groupEnd) closeGroup();
    let column = columnEnds.findIndex((end) => end <= item.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.endMinute);
    } else columnEnds[column] = item.endMinute;
    const placement = { ...item, column, columns: 1 };
    group.push(placement);
    placed.push(placement);
    groupEnd = Math.max(groupEnd, item.endMinute);
  }
  closeGroup();
  return placed;
}

export type AllDayPlacement = {
  event: AgendaEvent;
  startColumn: number;
  span: number;
  row: number;
};

/** All-day and day-spanning events as bars across the shown days. */
export function layoutAllDayEvents(
  events: readonly AgendaEvent[],
  days: readonly Date[]
): AllDayPlacement[] {
  const first = days[0];
  if (!first) return [];
  const columnOf = (date: Date) =>
    Math.round((startOfDay(date).getTime() - first.getTime()) / 86_400_000);
  const items = events
    .filter(isAllDayRowEvent)
    .flatMap((event) => {
      const { start, end } = eventBounds(event);
      const lastDay = event.allDay ? addDays(end, -1) : new Date(end.getTime() - 1);
      const startColumn = Math.max(0, columnOf(start));
      const endColumn = Math.min(days.length - 1, columnOf(lastDay));
      if (endColumn < startColumn) return [];
      return [{ event, startColumn, span: endColumn - startColumn + 1 }];
    })
    .toSorted(
      (a, b) =>
        a.startColumn - b.startColumn ||
        b.span - a.span ||
        a.event.title.localeCompare(b.event.title)
    );
  const rows: number[][] = [];
  return items.map((item) => {
    let row = rows.findIndex((taken) =>
      taken.every(
        (column) => column < item.startColumn || column >= item.startColumn + item.span
      )
    );
    if (row === -1) {
      row = rows.length;
      rows.push([]);
    }
    for (let column = item.startColumn; column < item.startColumn + item.span; column++)
      rows[row]!.push(column);
    return { ...item, row };
  });
}

/**
 * How many chips fit in `available` pixels, keeping room for the "+N" line
 * when not all of them fit.
 */
export function visibleItemCount(
  available: number,
  chipHeight: number,
  gap: number,
  total: number
) {
  if (total === 0 || available <= 0 || chipHeight <= 0) return total;
  if (total * chipHeight + Math.max(0, total - 1) * gap <= available) return total;
  let count = 0;
  let used = 0;
  while (count < total) {
    const next = chipHeight + (count > 0 ? gap : 0);
    const more = total - count - 1 > 0 ? chipHeight + gap : 0;
    if (used + next + more > available) break;
    used += next;
    count++;
  }
  return Math.max(1, count);
}
