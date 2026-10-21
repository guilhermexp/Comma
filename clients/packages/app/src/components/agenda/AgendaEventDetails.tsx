import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import { Button, Dropdown, InputField, ScrollArea, XIcon } from "@comma/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";
import {
  addDays,
  dateKey,
  eventBounds,
  localIsoString,
  parseDateKey,
  systemTimeZone,
} from "./agendaDates";
import { formatDayMonth, formatEventTime, formatWeekday } from "./agendaFormat";
import type {
  AgendaCalendar,
  AgendaEvent,
  AgendaEventInput,
  AgendaRecurrence,
} from "./agendaSource";

export type AgendaDetailsTarget =
  | { kind: "event"; event: AgendaEvent }
  | { kind: "new"; start: Date; end: Date; allDay: boolean };

export type AgendaDetailsSave = {
  calendar: AgendaCalendar;
  input: AgendaEventInput;
  /** Only the fields the reader changed, for an existing event. */
  patch: Partial<AgendaEventInput>;
};

type Form = {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  calendarKey: string;
  recurrence: AgendaRecurrence | "custom" | null;
};

const timePattern = /^(\d{2}):(\d{2})$/;

function timeOf(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function initialForm(target: AgendaDetailsTarget, calendarKey: string): Form {
  if (target.kind === "new") {
    return {
      title: "",
      allDay: target.allDay,
      startDate: dateKey(target.start),
      startTime: timeOf(target.start),
      endDate: dateKey(target.allDay ? addDays(target.end, -1) : target.end),
      endTime: timeOf(target.end),
      location: "",
      description: "",
      calendarKey,
      recurrence: "none",
    };
  }
  const { event } = target;
  const { start, end } = eventBounds(event);
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: dateKey(start),
    startTime: timeOf(start),
    endDate: dateKey(event.allDay ? addDays(end, -1) : end),
    endTime: timeOf(end),
    location: event.location ?? "",
    description: event.description ?? "",
    calendarKey,
    recurrence: event.seriesId ? null : "none",
  };
}

function at(date: string, time: string) {
  const day = parseDateKey(date);
  const match = timePattern.exec(time);
  if (!match || Number.isNaN(day.getTime())) return null;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number(match[1]),
    Number(match[2])
  );
}

function boundsOf(form: Form) {
  if (form.allDay) {
    const start = parseDateKey(form.startDate);
    const last = parseDateKey(form.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || last < start)
      return null;
    return { start: form.startDate, end: dateKey(addDays(last, 1)) };
  }
  const start = at(form.startDate, form.startTime);
  const end = at(form.endDate, form.endTime);
  if (!start || !end || end <= start) return null;
  return { start: localIsoString(start), end: localIsoString(end) };
}

// All-day dates compare as dates; timed boundaries as instants, whatever
// offset the source wrote them with.
function sameBoundary(a: string, b: string, allDay: boolean) {
  return allDay ? a === b : new Date(a).getTime() === new Date(b).getTime();
}

function safeGoogleCalendarUrl(value: string | null) {
  if (!value || value.length > 2083) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ["www.google.com", "calendar.google.com"].includes(url.hostname) &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    /* An invalid provider link stays unavailable. */
  }
}

export function AgendaEventDetails({
  target,
  calendars,
  calendar,
  sourceLabelOf,
  defaultCalendarKey,
  loadRecurrence,
  onSave,
  onDelete,
  onClose,
}: {
  target: AgendaDetailsTarget;
  calendars: readonly AgendaCalendar[];
  /** The event's own calendar; absent for a new event. */
  calendar: AgendaCalendar | undefined;
  sourceLabelOf: (calendar: AgendaCalendar) => string;
  defaultCalendarKey: string | undefined;
  loadRecurrence: (event: AgendaEvent) => Promise<AgendaRecurrence | "custom">;
  onSave: (save: AgendaDetailsSave) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const id = useId();
  const event = target.kind === "event" ? target.event : null;
  const writable = calendars.filter((item) => item.writable);
  const readOnly = Boolean(event && (!event.editable || !calendar?.writable));
  const [form, setForm] = useState(() =>
    initialForm(target, calendar?.key ?? defaultCalendarKey ?? writable[0]?.key ?? "")
  );
  const set = (patch: Partial<Form>) => setForm((value) => ({ ...value, ...patch }));
  const [originalRecurrence, setOriginalRecurrence] = useState(form.recurrence);

  const load = useRef(loadRecurrence);
  load.current = loadRecurrence;
  useEffect(() => {
    if (!event?.seriesId) return;
    let live = true;
    load.current(event).then(
      (recurrence) => {
        if (!live) return;
        setOriginalRecurrence(recurrence);
        set({ recurrence });
      },
      () => {
        // An unreadable repetition is shown as one this screen cannot edit.
        if (!live) return;
        setOriginalRecurrence("custom");
        set({ recurrence: "custom" });
      }
    );
    return () => {
      live = false;
    };
  }, [event]);

  // A new event starts at its title; Escape closes the panel.
  const titleRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!event) titleRef.current?.querySelector("input")?.focus();
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && !document.querySelector("[role='dialog']"))
        close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [event]);

  const bounds = boundsOf(form);
  const selected = calendars.find((item) => item.key === form.calendarKey);
  const canSave = Boolean(
    !readOnly && bounds && selected?.writable && form.recurrence !== null
  );
  const url = event?.source === "google" ? safeGoogleCalendarUrl(event.url) : undefined;

  const calendarItems = useMemo(
    () =>
      writable.map((item) => ({
        id: item.key,
        label: item.name,
        group: sourceLabelOf(item),
        leading: (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
          />
        ),
      })),
    [writable, sourceLabelOf]
  );
  const recurrenceItems = (
    ["none", "daily", "weekly", "monthly", "yearly"] as const
  ).map((value) => ({
    id: value,
    label: {
      none: m.agenda_recurrence_none(),
      daily: m.agenda_recurrence_daily(),
      weekly: m.agenda_recurrence_weekly(),
      monthly: m.agenda_recurrence_monthly(),
      yearly: m.agenda_recurrence_yearly(),
    }[value],
  }));

  const save = () => {
    if (!canSave || !bounds || !selected) return;
    const recurrence = form.recurrence === "custom" ? undefined : form.recurrence;
    const input: AgendaEventInput = {
      title: form.title.trim(),
      start: bounds.start,
      end: bounds.end,
      allDay: form.allDay,
      timeZone: systemTimeZone(),
      location: form.location.trim() || null,
      description: form.description.trim() || null,
      recurrence: recurrence ?? "none",
    };
    const patch: Partial<AgendaEventInput> = {};
    if (event) {
      if (input.title !== event.title) patch.title = input.title;
      if (
        form.allDay !== event.allDay ||
        !sameBoundary(bounds.start, event.start, form.allDay) ||
        !sameBoundary(bounds.end, event.end, form.allDay)
      ) {
        patch.start = input.start;
        patch.end = input.end;
        patch.allDay = input.allDay;
        patch.timeZone = input.timeZone;
      }
      if (input.location !== (event.location ?? null))
        patch.location = input.location ?? null;
      if (input.description !== (event.description ?? null))
        patch.description = input.description ?? null;
      if (recurrence && recurrence !== originalRecurrence)
        patch.recurrence = recurrence;
    }
    onSave({ calendar: selected, input, patch });
  };

  const readOnlyWhen = event
    ? event.allDay
      ? `${formatWeekday(eventBounds(event).start, locale)}, ${formatDayMonth(eventBounds(event).start, locale)} · ${m.agenda_all_day()}`
      : `${formatWeekday(eventBounds(event).start, locale)}, ${formatDayMonth(eventBounds(event).start, locale)} · ${formatEventTime(event, locale)}`
    : "";

  return (
    <aside
      aria-label={event ? m.agenda_event_details() : m.agenda_new_event()}
      className="flex w-80 shrink-0 flex-col rounded-lg border border-secondary bg-primary"
      data-testid="agenda-event-details"
    >
      <div className="flex items-center justify-between gap-sm px-lg pt-lg">
        <h2 className="m-0 text-sm font-semibold text-primary">
          {event ? m.agenda_event_details() : m.agenda_new_event()}
        </h2>
        <Button
          aria-label={m.agenda_close()}
          hierarchy="tertiary-gray"
          iconLeading={<XIcon />}
          iconOnly
          onPress={onClose}
          size="xs"
        />
      </div>
      <ScrollArea
        className="min-h-0 flex-1"
        contentClassName="flex flex-col gap-md p-lg"
      >
        {readOnly && event ? (
          <>
            <p className="m-0 text-md font-semibold text-primary">{event.title}</p>
            <p className="m-0 text-sm text-secondary">{readOnlyWhen}</p>
            {calendar && (
              <p className="m-0 text-sm text-secondary">
                {calendar.name} · {sourceLabelOf(calendar)}
              </p>
            )}
            {event.location && (
              <p className="m-0 text-sm text-secondary">{event.location}</p>
            )}
            {event.description && (
              <p className="m-0 text-sm whitespace-pre-wrap text-secondary">
                {event.description}
              </p>
            )}
            <p
              className="m-0 rounded-sm bg-secondary px-md py-sm text-sm text-primary"
              role="note"
            >
              {m.agenda_read_only()}
            </p>
          </>
        ) : (
          <form
            className="flex flex-col gap-md"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              save();
            }}
          >
            <div ref={titleRef}>
              <InputField
                label={m.agenda_field_title()}
                maxLength={1024}
                onChange={(change) => set({ title: change.target.value })}
                value={form.title}
              />
            </div>
            <label className="flex items-center gap-sm text-sm text-secondary">
              <input
                checked={form.allDay}
                onChange={(change) => set({ allDay: change.target.checked })}
                type="checkbox"
              />
              {m.agenda_field_all_day()}
            </label>
            <div className="grid grid-cols-2 gap-sm">
              <DateTimeInput
                label={form.allDay ? m.agenda_field_date() : m.agenda_field_start()}
                onChange={(value) => set({ startDate: value })}
                type="date"
                value={form.startDate}
              />
              {!form.allDay && (
                <DateTimeInput
                  label={m.agenda_field_start()}
                  onChange={(value) => set({ startTime: value })}
                  type="time"
                  value={form.startTime}
                />
              )}
              <DateTimeInput
                label={form.allDay ? m.agenda_field_end_date() : m.agenda_field_end()}
                onChange={(value) => set({ endDate: value })}
                type="date"
                value={form.endDate}
              />
              {!form.allDay && (
                <DateTimeInput
                  label={m.agenda_field_end()}
                  onChange={(value) => set({ endTime: value })}
                  type="time"
                  value={form.endTime}
                />
              )}
            </div>
            <Dropdown
              ariaLabel={m.agenda_field_calendar()}
              items={calendarItems}
              label={m.agenda_field_calendar()}
              onChange={(key) => set({ calendarKey: key })}
              size="sm"
              value={form.calendarKey}
            />
            {form.recurrence === "custom" ? (
              <div className="flex flex-col gap-xxs text-sm">
                <span className="font-medium text-secondary">
                  {m.agenda_field_recurrence()}
                </span>
                <span className="text-primary">{m.agenda_recurrence_custom()}</span>
                <span className="text-xs text-tertiary">
                  {m.agenda_recurrence_custom_hint()}
                </span>
              </div>
            ) : (
              <Dropdown
                ariaLabel={m.agenda_field_recurrence()}
                disabled={form.recurrence === null}
                items={recurrenceItems}
                label={m.agenda_field_recurrence()}
                onChange={(value) => set({ recurrence: value as AgendaRecurrence })}
                size="sm"
                value={form.recurrence ?? "none"}
              />
            )}
            <InputField
              label={m.agenda_field_location()}
              onChange={(change) => set({ location: change.target.value })}
              value={form.location}
            />
            <label
              className="flex flex-col gap-xs text-sm font-medium text-secondary"
              htmlFor={`${id}-description`}
            >
              {m.agenda_field_description()}
              <textarea
                className="min-h-20 resize-y rounded-md border border-primary bg-primary px-md py-sm text-sm font-normal text-primary shadow-xs focus:shadow-focus-gray-shadow-xs focus:outline-none"
                id={`${id}-description`}
                maxLength={8192}
                onChange={(change) => set({ description: change.target.value })}
                value={form.description}
              />
            </label>
            <div className="flex items-center justify-between gap-sm">
              {event ? (
                <Button hierarchy="destructive" onPress={onDelete} size="sm">
                  {m.agenda_delete()}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-sm">
                <Button hierarchy="secondary-gray" onPress={onClose} size="sm">
                  {m.agenda_cancel()}
                </Button>
                <Button isDisabled={!canSave} size="sm" type="submit">
                  {m.agenda_save()}
                </Button>
              </div>
            </div>
          </form>
        )}
        {url && (
          <Button
            className="self-start"
            hierarchy="link-color"
            onPress={() => void openNativePlatformExternalUrl(url).catch(() => {})}
            size="sm"
          >
            {m.agenda_open_in_google()}
          </Button>
        )}
      </ScrollArea>
    </aside>
  );
}

function DateTimeInput({
  label,
  type,
  value,
  onChange,
}: {
  label: string;
  type: "date" | "time";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-xs text-sm font-medium text-secondary">
      {label}
      <input
        className="h-9 rounded-md border border-primary bg-primary px-sm text-sm font-normal text-primary shadow-xs focus:shadow-focus-gray-shadow-xs focus:outline-none"
        onChange={(change) => onChange(change.target.value)}
        step={type === "time" ? 900 : undefined}
        type={type}
        value={value}
      />
    </label>
  );
}
