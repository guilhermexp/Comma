import { z } from "zod";
import {
  composioAccountSchema,
  composioStatusSchema,
  type CommaApiClient,
  type ComposioAccount,
  type JsonValue,
} from "../../api";
import {
  agendaCalendarKey,
  agendaEventKey,
  type AgendaCalendar,
  type AgendaEvent,
  type AgendaEventInput,
  type AgendaScope,
  type AgendaSource,
} from "./agendaSource";

// The Agenda's Google source: the closed `google_calendar` Composio action
// (contract C1). The client names an operation, never a tool slug.

const recurrenceSchema = z.enum(["none", "daily", "weekly", "monthly", "yearly"]);
const boundarySchema = z.union([
  z.object({ date: z.string().min(10).max(10) }),
  z.object({
    date_time: z.string().min(1).max(64),
    time_zone: z.string().max(64).nullish(),
  }),
]);
const eventSchema = z.object({
  id: z.string().min(1).max(1024),
  calendar_id: z.string().min(1).max(1024),
  series_id: z.string().max(1024).nullable(),
  title: z.string().max(1024),
  start: boundarySchema,
  end: boundarySchema,
  all_day: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  color: z.string().nullable(),
  editable: z.boolean(),
  etag: z.string().nullable(),
});
const calendarsSchema = z.object({
  account_email: z.string().nullable(),
  calendars: z
    .array(
      z.object({
        id: z.string().min(1).max(1024),
        name: z.string().max(1024),
        color: z.string().max(32),
        primary: z.boolean(),
        selected: z.boolean(),
        access_role: z.string(),
        writable: z.boolean(),
      })
    )
    .max(250),
});
const eventsSchema = z.object({
  events: z.array(eventSchema).max(2500),
  truncated: z.boolean(),
  failed_calendar_ids: z.array(z.string()),
});
const eventReplySchema = z.object({ event: eventSchema });
const eventWithRecurrenceSchema = z.object({
  event: eventSchema.extend({ recurrence: recurrenceSchema.or(z.literal("custom")) }),
});

const maxCalendarsPerRead = 25;

type GoogleEvent = z.infer<typeof eventSchema>;

function boundary(value: GoogleEvent["start"]) {
  return "date" in value ? value.date : value.date_time;
}

function inputBody(input: Partial<AgendaEventInput>) {
  const body: Record<string, JsonValue> = {};
  if (input.title !== undefined) body["title"] = input.title;
  if (input.start !== undefined) body["start"] = input.start;
  if (input.end !== undefined) body["end"] = input.end;
  if (input.allDay !== undefined) body["all_day"] = input.allDay;
  if (input.timeZone !== undefined) body["time_zone"] = input.timeZone;
  if (input.location !== undefined) body["location"] = input.location;
  if (input.description !== undefined) body["description"] = input.description;
  if (input.recurrence !== undefined) body["recurrence"] = input.recurrence;
  return body;
}

// A series is addressed by its series id; an occurrence by its own id and
// the etag it was read with.
function target(event: AgendaEvent, scope: AgendaScope) {
  return {
    calendar_id: event.calendarId,
    event_id: scope === "series" ? (event.seriesId ?? event.id) : event.id,
    scope,
    ...(scope === "instance" && event.etag ? { etag: event.etag } : {}),
  };
}

export function googleCalendarSource(
  api: CommaApiClient,
  workspace: string,
  accountId: string
): AgendaSource {
  const command = (params: Record<string, JsonValue>, signal?: AbortSignal) =>
    api.composioCommand(
      workspace,
      "google_calendar",
      { account_id: accountId, ...params },
      signal ? { signal } : {}
    );
  const toEvent = (event: GoogleEvent): AgendaEvent => ({
    key: agendaEventKey("google", accountId, event.calendar_id, event.id),
    source: "google",
    accountId,
    calendarId: event.calendar_id,
    id: event.id,
    seriesId: event.series_id,
    occurrenceDate: null,
    title: event.title,
    start: boundary(event.start),
    end: boundary(event.end),
    allDay: event.all_day,
    location: event.location,
    description: event.description,
    url: event.url,
    color: event.color,
    editable: event.editable,
    etag: event.etag,
  });

  return {
    async calendars(signal) {
      const reply = calendarsSchema.parse(
        await command({ operation: "calendars" }, signal)
      );
      return reply.calendars.map(
        (calendar): AgendaCalendar => ({
          key: agendaCalendarKey("google", accountId, calendar.id),
          source: "google",
          accountId,
          id: calendar.id,
          name: calendar.name,
          color: calendar.color,
          writable: calendar.writable,
          primary: calendar.primary,
          ownerEmail: reply.account_email,
        })
      );
    },
    async events(calendarIds, start, end, signal) {
      const events: AgendaEvent[] = [];
      const failedCalendarIds: string[] = [];
      let truncated = false;
      for (let index = 0; index < calendarIds.length; index += maxCalendarsPerRead) {
        const reply = eventsSchema.parse(
          await command(
            {
              operation: "events",
              calendar_ids: calendarIds.slice(index, index + maxCalendarsPerRead),
              time_min: start,
              time_max: end,
              time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            signal
          )
        );
        events.push(...reply.events.map(toEvent));
        failedCalendarIds.push(...reply.failed_calendar_ids);
        truncated ||= reply.truncated;
      }
      return { events, truncated, failedCalendarIds };
    },
    async recurrence(event) {
      const reply = eventWithRecurrenceSchema.parse(
        await command({
          operation: "event",
          calendar_id: event.calendarId,
          event_id: event.seriesId ?? event.id,
        })
      );
      return reply.event.recurrence;
    },
    async create(calendarId, input) {
      const reply = eventReplySchema.parse(
        await command({
          operation: "create",
          calendar_id: calendarId,
          event: inputBody(input),
        })
      );
      return toEvent(reply.event);
    },
    async update(event, scope, patch, targetCalendarId) {
      const reply = eventReplySchema.parse(
        await command({
          operation: "update",
          ...target(event, scope),
          patch: inputBody(patch),
          ...(targetCalendarId && targetCalendarId !== event.calendarId
            ? { target_calendar_id: targetCalendarId }
            : {}),
        })
      );
      return toEvent(reply.event);
    },
    async remove(event, scope) {
      await command({ operation: "delete", ...target(event, scope) });
    },
  };
}

function usable(item: ComposioAccount, mode: string) {
  return (
    item.toolkit === "googlecalendar" &&
    item.status === "ACTIVE" &&
    item.enabled &&
    item.mode === mode
  );
}

export type GoogleCalendarAccounts = {
  accounts: ComposioAccount[];
  /** Remote accounts the reader may adopt when none is connected yet. */
  candidates: ComposioAccount[];
};

/**
 * The reader's connected `googlecalendar` accounts, the way Google Drive
 * finds its accounts: when none is active yet, the backend reconciles the
 * remote accounts once, and an explicit choice adopts one of them.
 */
export async function listGoogleCalendarAccounts(
  api: CommaApiClient,
  workspace: string,
  signal: AbortSignal,
  chosenAccountId?: string
): Promise<GoogleCalendarAccounts> {
  let result = await api.getComposio(workspace, { signal });
  let candidates: ComposioAccount[] = [];
  if (
    result.mode === "connect" &&
    result.status === "connected" &&
    (chosenAccountId || !result.accounts.some((item) => usable(item, "connect")))
  ) {
    const reconciled = composioStatusSchema
      .extend({ remote_accounts: z.array(composioAccountSchema).default([]) })
      .parse(
        await api.composioCommand(
          workspace,
          "reconcile_accounts",
          {
            toolkit: "googlecalendar",
            ...(chosenAccountId ? { account_id: chosenAccountId } : {}),
          },
          { signal }
        )
      );
    result = reconciled;
    candidates = reconciled.remote_accounts.filter(
      (item) =>
        item.toolkit === "googlecalendar" &&
        item.mode === "connect" &&
        item.status === "ACTIVE"
    );
  }
  const accounts = result.accounts.filter((item) => usable(item, result.mode));
  return { accounts, candidates: accounts.length === 0 ? candidates : [] };
}
