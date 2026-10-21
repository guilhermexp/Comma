import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import { ScrollArea, cx } from "@comma/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  atMinute,
  busyMinutes,
  eventBounds,
  eventsOnDay,
  minuteOfDay,
  sameDay,
  startOfDay,
} from "./agendaDates";
import {
  eventColorStyle,
  eventTitle,
  formatBusy,
  formatDayMonth,
  formatEventTime,
  formatTime,
  formatWeekday,
} from "./agendaFormat";
import {
  agendaHourHeight,
  agendaSnapMinutes,
  layoutAllDayEvents,
  layoutTimedEvents,
  snapMinutes,
} from "./agendaLayout";
import type { AgendaEvent } from "./agendaSource";

// The 3-day and week grid: day headers with their busy time, the all-day row,
// the hour grid and the "now" line. Pointer gestures on the hour grid create
// (press or drag over empty time), move (drag an event) and resize (drag an
// event's bottom edge), always in 15-minute steps.

const dragThreshold = 4;
const autoScrollEdge = 40;
const autoScrollStep = 12;
const allDayRowHeight = 24;
const gutterClassName = "w-16 shrink-0";

export type AgendaGridProps = {
  days: readonly Date[];
  events: readonly AgendaEvent[];
  zoom: number;
  now: Date;
  selectedKey: string | null;
  draft: { start: Date; end: Date; allDay: boolean } | null;
  colorOf: (event: AgendaEvent) => string;
  calendarNameOf: (event: AgendaEvent) => string;
  onSelect: (event: AgendaEvent) => void;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
  onMove: (event: AgendaEvent, start: Date, end: Date) => void;
};

type GridDrag =
  | {
      kind: "create";
      pointerId: number;
      day: number;
      anchor: number;
      current: number;
      originX: number;
      originY: number;
      moved: boolean;
    }
  | {
      kind: "move" | "resize";
      pointerId: number;
      event: AgendaEvent;
      offset: number;
      duration: number;
      day: number;
      start: number;
      end: number;
      originX: number;
      originY: number;
      moved: boolean;
    };

export function AgendaTimeGrid({
  days,
  events,
  zoom,
  now,
  selectedKey,
  draft,
  colorOf,
  calendarNameOf,
  onSelect,
  onCreate,
  onMove,
}: AgendaGridProps) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const hourHeight = agendaHourHeight(zoom);
  const viewport = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const dragRef = useRef<GridDrag | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const todayIndex = days.findIndex((day) => sameDay(day, now));
  const allDay = layoutAllDayEvents(events, days);
  const allDayRows = Math.max(1, ...allDay.map((item) => item.row + 1));
  const template = `repeat(${days.length}, minmax(0, 1fr))`;

  // Open near the current hour, or at the start of a working day. Only a
  // new period re-anchors the scroll; zoom keeps the reader's place.
  const firstDay = days[0]?.getTime();
  const scrollInputs = useRef({ hourHeight, todayIndex });
  scrollInputs.current = { hourHeight, todayIndex };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || firstDay === undefined) return;
    const { hourHeight: height, todayIndex: today } = scrollInputs.current;
    const minute = today >= 0 ? minuteOfDay(new Date()) : 8 * 60;
    element.scrollTop = Math.max(0, (minute / 60 - 1.5) * height);
  }, [firstDay]);

  const position = useCallback(
    (clientX: number, clientY: number) => {
      const rect = columns.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { day: 0, minute: 0 };
      const day = Math.min(
        days.length - 1,
        Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * days.length))
      );
      const minute = Math.min(
        1440,
        Math.max(0, ((clientY - rect.top) / hourHeight) * 60)
      );
      return { day, minute };
    },
    [days.length, hourHeight]
  );

  const update = useCallback((next: GridDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const track = useCallback(
    (clientX: number, clientY: number) => {
      const current = dragRef.current;
      if (!current) return;
      pointer.current = { x: clientX, y: clientY };
      const moved =
        current.moved ||
        Math.hypot(clientX - current.originX, clientY - current.originY) >=
          dragThreshold;
      const { day, minute } = position(clientX, clientY);
      if (current.kind === "create") {
        update({ ...current, moved, current: minute });
        return;
      }
      if (!moved) return;
      if (current.kind === "resize") {
        const end = Math.min(
          1440,
          Math.max(current.start + agendaSnapMinutes, snapMinutes(minute))
        );
        update({ ...current, moved, end });
        return;
      }
      const start = Math.min(
        1440 - agendaSnapMinutes,
        Math.max(0, snapMinutes(minute - current.offset))
      );
      update({ ...current, moved, day, start, end: start + current.duration });
    },
    [position, update]
  );

  // Near the top or bottom edge a held drag scrolls the hour grid.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const step = () => {
      const element = viewport.current;
      if (element) {
        const rect = element.getBoundingClientRect();
        const y = pointer.current.y;
        const delta =
          y < rect.top + autoScrollEdge
            ? -autoScrollStep
            : y > rect.bottom - autoScrollEdge
              ? autoScrollStep
              : 0;
        if (delta !== 0 && rect.height > 0) {
          element.scrollTop += delta;
          track(pointer.current.x, pointer.current.y);
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") update(null);
    };
    window.addEventListener("keydown", cancel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", cancel);
    };
  }, [dragging, track, update]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const { day, minute } = position(event.clientX, event.clientY);
    const chip = target.closest<HTMLElement>("[data-agenda-event]");
    const origin = { originX: event.clientX, originY: event.clientY, moved: false };
    pointer.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (chip) {
      const item = events.find(
        (candidate) => candidate.key === chip.dataset["agendaEvent"]
      );
      if (!item) return;
      const bounds = eventBounds(item);
      const dayStart = startOfDay(days[day]!).getTime();
      const start = Math.round((bounds.start.getTime() - dayStart) / 60_000);
      const duration = Math.round(
        (bounds.end.getTime() - bounds.start.getTime()) / 60_000
      );
      update({
        kind: target.closest("[data-agenda-resize]") ? "resize" : "move",
        pointerId: event.pointerId,
        event: item,
        offset: minute - start,
        duration,
        day,
        start,
        end: start + duration,
        ...origin,
      });
      return;
    }
    update({
      kind: "create",
      pointerId: event.pointerId,
      day,
      anchor: minute,
      current: minute,
      ...origin,
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    track(event.clientX, event.clientY);
    const settled = dragRef.current ?? current;
    update(null);
    const day = days[settled.day];
    if (!day) return;
    if (settled.kind === "create") {
      if (!settled.moved) {
        const start = Math.min(1410, Math.floor(settled.anchor / 15) * 15);
        onCreate(atMinute(day, start), atMinute(day, start + 30), false);
        return;
      }
      const from = snapMinutes(Math.min(settled.anchor, settled.current));
      const to = Math.max(
        from + agendaSnapMinutes,
        snapMinutes(Math.max(settled.anchor, settled.current))
      );
      onCreate(atMinute(day, from), atMinute(day, to), false);
      return;
    }
    if (!settled.moved || !settled.event.editable) {
      onSelect(settled.event);
      return;
    }
    const original = eventBounds(settled.event);
    const start = atMinute(day, settled.start);
    const end = atMinute(day, settled.end);
    if (
      start.getTime() !== original.start.getTime() ||
      end.getTime() !== original.end.getTime()
    )
      onMove(settled.event, start, end);
  };

  const preview =
    drag?.kind === "create" && drag.moved
      ? {
          day: drag.day,
          start: snapMinutes(Math.min(drag.anchor, drag.current)),
          end: Math.max(
            snapMinutes(Math.min(drag.anchor, drag.current)) + agendaSnapMinutes,
            snapMinutes(Math.max(drag.anchor, drag.current))
          ),
        }
      : draft && !draft.allDay
        ? (() => {
            const day = days.findIndex((candidate) => sameDay(candidate, draft.start));
            return day >= 0
              ? {
                  day,
                  start: minuteOfDay(draft.start),
                  end:
                    minuteOfDay(draft.start) +
                    Math.round((draft.end.getTime() - draft.start.getTime()) / 60_000),
                }
              : null;
          })()
        : null;
  const movingKey =
    drag && drag.kind !== "create" && drag.moved && drag.event.editable
      ? drag.event.key
      : null;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-secondary bg-primary"
      data-testid="agenda-time-grid"
    >
      <div className="flex border-b border-secondary">
        <div className={gutterClassName} />
        <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: template }}>
          {days.map((day, index) => {
            const today = index === todayIndex;
            return (
              <div
                className="min-w-0 border-l border-secondary px-md py-sm"
                data-testid="agenda-day-header"
                key={day.getTime()}
              >
                <div
                  className={cx(
                    "text-xs font-semibold uppercase",
                    today ? "text-error-primary" : "text-tertiary"
                  )}
                >
                  {formatWeekday(day, locale)}
                </div>
                <div
                  className={cx(
                    "text-md font-semibold",
                    today ? "text-error-primary" : "text-primary"
                  )}
                >
                  {formatDayMonth(day, locale)}
                </div>
                <div className="text-xs text-tertiary" data-testid="agenda-day-busy">
                  {formatBusy(busyMinutes(eventsOnDay(events, day), day), m)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex border-b border-secondary">
        <div
          className={cx(
            gutterClassName,
            "px-sm pt-xs text-right text-xs leading-tight text-tertiary"
          )}
        >
          {m.agenda_all_day()}
        </div>
        <div
          className="relative grid min-w-0 flex-1"
          data-testid="agenda-all-day-row"
          style={{
            gridTemplateColumns: template,
            height: allDayRows * allDayRowHeight + 12,
          }}
        >
          {days.map((day, index) => (
            <button
              aria-label={`${m.agenda_new_event()} · ${m.agenda_all_day()} · ${formatDayMonth(day, locale)}`}
              className={cx(
                "border-0 border-l border-secondary bg-transparent p-0",
                index === todayIndex && "bg-secondary/60"
              )}
              key={day.getTime()}
              onClick={() =>
                onCreate(
                  day,
                  new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
                  true
                )
              }
              type="button"
            />
          ))}
          {allDay.map((item) => (
            <button
              aria-label={eventTitle(item.event, m)}
              className={cx(
                "absolute flex cursor-pointer items-center truncate rounded-sm border-0 border-l-[3px] border-solid px-sm text-left text-xs font-medium text-primary",
                selectedKey === item.event.key &&
                  "ring-2 ring-[var(--agenda-event-color)]"
              )}
              data-testid="agenda-all-day-event"
              key={item.event.key}
              onClick={() => onSelect(item.event)}
              style={{
                ...eventColorStyle(colorOf(item.event)),
                left: `calc(${(item.startColumn / days.length) * 100}% + 4px)`,
                width: `calc(${(item.span / days.length) * 100}% - 8px)`,
                top: item.row * allDayRowHeight + 6,
                height: allDayRowHeight - 4,
              }}
              type="button"
            >
              <span className="truncate">{eventTitle(item.event, m)}</span>
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" ref={viewport} scrollbarVisibility="hover">
        <div className="flex" style={{ height: 24 * hourHeight }}>
          <div className={cx(gutterClassName, "relative")}>
            {Array.from({ length: 23 }, (_, index) => (
              <span
                className="absolute right-sm -translate-y-1/2 text-xs text-tertiary tabular-nums"
                key={index}
                style={{ top: (index + 1) * hourHeight }}
              >
                {formatTime(atMinute(new Date(2000, 0, 1), (index + 1) * 60), locale)}
              </span>
            ))}
          </div>
          <div
            className="relative grid min-w-0 flex-1 touch-none select-none"
            data-testid="agenda-hour-columns"
            onLostPointerCapture={() => update(null)}
            onPointerCancel={() => update(null)}
            onPointerDown={onPointerDown}
            onPointerMove={(event) => track(event.clientX, event.clientY)}
            onPointerUp={onPointerUp}
            ref={columns}
            style={{
              gridTemplateColumns: template,
              backgroundImage: `repeating-linear-gradient(to bottom, var(--color-border-secondary) 0 1px, transparent 1px ${hourHeight}px)`,
            }}
          >
            {days.map((day, index) => (
              <div
                className={cx(
                  "relative border-l border-secondary",
                  index === todayIndex && "bg-secondary/60"
                )}
                data-testid="agenda-day-column"
                key={day.getTime()}
              >
                {layoutTimedEvents(events, day).map((item) => (
                  <button
                    aria-label={`${eventTitle(item.event, m)}, ${formatEventTime(item.event, locale)}`}
                    className={cx(
                      "absolute block overflow-hidden rounded-sm border-0 border-l-[3px] border-solid px-sm py-xxs text-left",
                      item.event.editable ? "cursor-grab" : "cursor-pointer",
                      movingKey === item.event.key && "opacity-40",
                      selectedKey === item.event.key &&
                        "z-10 ring-2 ring-[var(--agenda-event-color)]"
                    )}
                    data-agenda-event={item.event.key}
                    data-testid="agenda-event"
                    key={item.event.key}
                    // A pointer press selects on release; a keyboard press
                    // (a click without a pointer) selects here.
                    onClick={(event) => {
                      if (event.detail === 0) onSelect(item.event);
                    }}
                    style={{
                      ...eventColorStyle(colorOf(item.event)),
                      top: (item.startMinute / 60) * hourHeight + 1,
                      height: Math.max(
                        16,
                        ((item.endMinute - item.startMinute) / 60) * hourHeight - 2
                      ),
                      left: `calc(${(item.column / item.columns) * 100}% + 2px)`,
                      width: `calc(${100 / item.columns}% - 4px)`,
                    }}
                    type="button"
                  >
                    <EventChipText
                      calendar={calendarNameOf(item.event)}
                      time={formatEventTime(item.event, locale)}
                      title={eventTitle(item.event, m)}
                    />
                    {item.event.editable && (
                      <span
                        aria-hidden
                        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                        data-agenda-resize=""
                      />
                    )}
                  </button>
                ))}
                {preview?.day === index && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded-sm border border-brand bg-brand-secondary/70 px-sm text-xs text-primary"
                    data-testid="agenda-create-preview"
                    style={{
                      top: (preview.start / 60) * hourHeight,
                      height: Math.max(
                        12,
                        ((preview.end - preview.start) / 60) * hourHeight
                      ),
                    }}
                  >
                    {formatTime(atMinute(day, preview.start), locale)}–
                    {formatTime(atMinute(day, preview.end), locale)}
                  </div>
                )}
                {drag && drag.kind !== "create" && movingKey && drag.day === index && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 z-20 overflow-hidden rounded-sm border-l-[3px] px-sm py-xxs shadow-md"
                    data-testid="agenda-drag-preview"
                    style={{
                      ...eventColorStyle(colorOf(drag.event)),
                      top: (drag.start / 60) * hourHeight,
                      height: Math.max(16, ((drag.end - drag.start) / 60) * hourHeight),
                    }}
                  >
                    <EventChipText
                      calendar={calendarNameOf(drag.event)}
                      time={`${formatTime(atMinute(day, drag.start), locale)}–${formatTime(atMinute(day, drag.end), locale)}`}
                      title={eventTitle(drag.event, m)}
                    />
                  </div>
                )}
              </div>
            ))}
            {todayIndex >= 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 z-30"
                data-now={formatTime(now, locale)}
                data-testid="agenda-now-line"
                style={{ top: (minuteOfDay(now) / 60) * hourHeight }}
              >
                <div className="h-px bg-error-solid/50" />
                <div
                  className="absolute -top-px h-0.5 bg-error-solid"
                  style={{
                    left: `${(todayIndex / days.length) * 100}%`,
                    width: `${100 / days.length}%`,
                  }}
                >
                  <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-error-solid" />
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

export function EventChipText({
  title,
  time,
  calendar,
}: {
  title: string;
  time: string;
  calendar: string;
}) {
  return (
    <>
      <span className="block truncate text-xs font-medium text-primary">{title}</span>
      <span className="block truncate text-xs text-tertiary">
        {time} · {calendar}
      </span>
    </>
  );
}
