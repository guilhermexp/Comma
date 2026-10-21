import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import { Dialog, cx } from "@comma/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dateKey, eventsOnDay, sameDay } from "./agendaDates";
import {
  eventColorStyle,
  eventTitle,
  formatDayMonth,
  formatTime,
  formatWeekday,
} from "./agendaFormat";
import { visibleItemCount } from "./agendaLayout";
import { eventBounds } from "./agendaDates";
import type { AgendaEvent } from "./agendaSource";

// Month: Monday-to-Sunday weeks; each day lists its events by start and, when
// they do not fit, a "+N" that opens the whole day. How many fit is measured
// from the cell and one chip, with one shared observer for the grid.

export function AgendaMonthGrid({
  days,
  month,
  events,
  now,
  selectedKey,
  colorOf,
  onSelect,
}: {
  days: readonly Date[];
  month: number;
  events: readonly AgendaEvent[];
  now: Date;
  selectedKey: string | null;
  colorOf: (event: AgendaEvent) => string;
  onSelect: (event: AgendaEvent) => void;
}) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const lists = useRef(new Map<string, HTMLElement>());
  const totals = useRef(new Map<string, number>());
  // How many chips fit, measured for a given number of events: a new count
  // of events shows every chip again until it is measured.
  const [fits, setFits] = useState<Record<string, { total: number; count: number }>>(
    {}
  );
  const [openDay, setOpenDay] = useState<Date | null>(null);
  const byDay = useMemo(
    () => days.map((day) => ({ day, items: eventsOnDay(events, day) })),
    [days, events]
  );

  const measure = useCallback((element: HTMLElement) => {
    const key = element.dataset["agendaDay"]!;
    const total = totals.current.get(key) ?? 0;
    const chip = element.firstElementChild as HTMLElement | null;
    const gap = Number.parseFloat(getComputedStyle(element).rowGap) || 0;
    const count = visibleItemCount(
      element.clientHeight,
      chip?.offsetHeight ?? 0,
      gap,
      total
    );
    if (total === 0 || !chip?.offsetHeight) return;
    setFits((value) =>
      value[key]?.total === total && value[key]?.count === count
        ? value
        : { ...value, [key]: { total, count } }
    );
  }, []);

  useEffect(() => {
    for (const { day, items } of byDay) totals.current.set(dateKey(day), items.length);
    lists.current.forEach((element) => measure(element));
    const observer = new ResizeObserver((entries) =>
      entries.forEach((entry) => measure(entry.target as HTMLElement))
    );
    lists.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [byDay, measure]);

  const weeks = Math.ceil(days.length / 7);
  const openItems = openDay ? eventsOnDay(events, openDay) : [];

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-secondary bg-primary"
      data-testid="agenda-month-grid"
    >
      <div className="grid grid-cols-7 border-b border-secondary">
        {days.slice(0, 7).map((day) => (
          <div
            className="border-l border-secondary px-md py-sm text-xs font-semibold text-tertiary uppercase first:border-l-0"
            key={day.getTime()}
          >
            {formatWeekday(day, locale)}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}
      >
        {byDay.map(({ day, items }, index) => {
          const key = dateKey(day);
          const fit = fits[key];
          const shown =
            fit?.total === items.length
              ? Math.min(items.length, fit.count)
              : items.length;
          const hidden = items.length - shown;
          const today = sameDay(day, now);
          return (
            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-col gap-xxs border-t border-l border-secondary p-xs",
                index % 7 === 0 && "border-l-0",
                index < 7 && "border-t-0",
                day.getMonth() !== month && "bg-secondary/50"
              )}
              data-testid="agenda-month-day"
              key={key}
            >
              <span
                className={cx(
                  "flex size-6 items-center justify-center self-end rounded-full text-xs font-medium",
                  today
                    ? "bg-error-solid text-white"
                    : day.getMonth() === month
                      ? "text-primary"
                      : "text-quaternary"
                )}
              >
                {day.getDate()}
              </span>
              <div
                className="flex min-h-0 flex-1 flex-col gap-xxs overflow-hidden"
                data-agenda-day={key}
                ref={(element) => {
                  if (element) lists.current.set(key, element);
                  else lists.current.delete(key);
                }}
              >
                {items.slice(0, shown).map((item) => (
                  <MonthChip
                    color={colorOf(item)}
                    event={item}
                    key={item.key}
                    label={
                      item.allDay
                        ? eventTitle(item, m)
                        : `${formatTime(eventBounds(item).start, locale)} ${eventTitle(item, m)}`
                    }
                    onSelect={onSelect}
                    selected={selectedKey === item.key}
                  />
                ))}
                {hidden > 0 && (
                  <button
                    className="h-5 shrink-0 rounded-sm px-xs text-left text-xs font-medium text-tertiary hover:bg-secondary"
                    onClick={() => setOpenDay(day)}
                    type="button"
                  >
                    {m.agenda_more_events({ count: String(hidden) })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {openDay && (
        <Dialog
          actions={[
            {
              hierarchy: "secondary-gray",
              label: m.agenda_close(),
              onPress: () => setOpenDay(null),
            },
          ]}
          isOpen
          onOpenChange={(open) => {
            if (!open) setOpenDay(null);
          }}
          title={m.agenda_day_events({ day: formatDayMonth(openDay, locale) })}
        >
          <ul
            className="m-0 flex list-none flex-col gap-xxs p-0"
            data-testid="agenda-day-list"
          >
            {openItems.map((item) => (
              <li key={item.key}>
                <MonthChip
                  color={colorOf(item)}
                  event={item}
                  label={
                    item.allDay
                      ? `${m.agenda_all_day()} · ${eventTitle(item, m)}`
                      : `${formatTime(eventBounds(item).start, locale)} ${eventTitle(item, m)}`
                  }
                  onSelect={(event) => {
                    setOpenDay(null);
                    onSelect(event);
                  }}
                  selected={false}
                />
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}

function MonthChip({
  event,
  label,
  color,
  selected,
  onSelect,
}: {
  event: AgendaEvent;
  label: string;
  color: string;
  selected: boolean;
  onSelect: (event: AgendaEvent) => void;
}) {
  return (
    <button
      className={cx(
        "flex h-5 w-full shrink-0 items-center truncate rounded-sm border-0 border-l-[3px] border-solid px-xs text-left text-xs text-primary",
        selected && "ring-2 ring-[var(--agenda-event-color)]"
      )}
      data-testid="agenda-month-event"
      onClick={() => onSelect(event)}
      style={eventColorStyle(color)}
      type="button"
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
