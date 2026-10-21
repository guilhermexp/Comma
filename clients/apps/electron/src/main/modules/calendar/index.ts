import {
  calendarMaxCalendars,
  calendarMaxEvents,
  calendarMaxRangeDays,
  type CalendarAccess,
  type CalendarCalendarsResult,
  type CalendarCreateEventInput,
  type CalendarDeleteEventInput,
  type CalendarDeleteEventResult,
  type CalendarError,
  type CalendarErrorCode,
  type CalendarEventPatch,
  type CalendarEventReference,
  type CalendarEventResult,
  type CalendarEventsInput,
  type CalendarEventsResult,
  type CalendarState,
  type CalendarUpdateEventInput,
} from "@comma/native-bridge";
import type { CalendarKitAddon } from "../../../../native/macos/CalendarKit";

/** Operation names and error codes only; never event content. */
export type CalendarLogger = {
  warn(message: string, context: { code: CalendarErrorCode }): void;
};

/** EventKit posts a change per saved item; the Agenda needs at most one per window. */
const CHANGE_COALESCE_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Privacy > Calendars, newest Settings first. Older macOS has no extension
 * URL, and a build that drops the anchor still opens the privacy pane.
 */
export const CALENDAR_PRIVACY_SETTINGS_URLS = [
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
  "x-apple.systempreferences:com.apple.preference.security",
] as const;

export interface CalendarProvider {
  state(input: void): Promise<CalendarState>;
  requestAccess(input: void): Promise<CalendarAccess>;
  openPrivacySettings(input: void): Promise<void>;
  calendars(input: void): Promise<CalendarCalendarsResult>;
  events(input: CalendarEventsInput): Promise<CalendarEventsResult>;
  event(input: CalendarEventReference): Promise<CalendarEventResult>;
  createEvent(input: CalendarCreateEventInput): Promise<CalendarEventResult>;
  updateEvent(input: CalendarUpdateEventInput): Promise<CalendarEventResult>;
  deleteEvent(input: CalendarDeleteEventInput): Promise<CalendarDeleteEventResult>;
}

function isCalendarError(value: unknown): value is CalendarError {
  return typeof value === "object" && value !== null && "error" in value;
}

/** Refuses bounds EventKit would store wrongly: inverted, or half all-day. */
function assertEventBounds(
  { allDay, end, start }: Pick<CalendarEventPatch, "allDay" | "end" | "start">,
  operation: string
) {
  if (allDay !== undefined) {
    for (const bound of [start, end]) {
      if (bound !== undefined && dateOnlyPattern.test(bound) !== allDay) {
        throw new RangeError(
          `${operation}: all-day bounds are dates and timed bounds are instants.`
        );
      }
    }
  }
  if (
    start !== undefined &&
    end !== undefined &&
    !(Date.parse(end) > Date.parse(start))
  ) {
    throw new RangeError(`${operation}: the event must end after it starts.`);
  }
}

/**
 * Main's owner of the Mac Calendar. The addon talks to EventKit with the
 * permission macOS grants Comma itself; this service applies the C2 limits,
 * turns failures into error codes, and coalesces database changes into the
 * `revision` the renderer refetches on. Logs carry operation names and
 * error codes only: event titles, locations and notes stay on this Mac.
 */
export class CalendarService implements CalendarProvider {
  readonly #addon: CalendarKitAddon;
  readonly #logger: CalendarLogger;
  readonly #onStateChanged: (state: CalendarState) => void;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  #revision = 1;
  #changeTimer: unknown;
  #stopObserving: (() => void) | undefined;
  #closed = false;

  constructor({
    addon,
    clearTimeout: clearTimeoutImpl = (handle) => clearTimeout(handle as never),
    logger = console,
    onStateChanged,
    openExternal,
    setTimeout: setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  }: {
    addon: CalendarKitAddon;
    clearTimeout?: (handle: unknown) => void;
    logger?: CalendarLogger;
    onStateChanged: (state: CalendarState) => void;
    openExternal: (url: string) => Promise<void>;
    setTimeout?: (fn: () => void, ms: number) => unknown;
  }) {
    this.#addon = addon;
    this.#logger = logger;
    this.#onStateChanged = onStateChanged;
    this.#openExternal = openExternal;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
  }

  /** Starts watching the database if access was already granted; never prompts. */
  start() {
    if (this.#access() === "fullAccess") this.#observe();
  }

  close() {
    this.#closed = true;
    this.#stopObserving?.();
    this.#stopObserving = undefined;
    if (this.#changeTimer !== undefined) this.#clearTimeout(this.#changeTimer);
    this.#changeTimer = undefined;
  }

  async state(): Promise<CalendarState> {
    return this.#snapshot();
  }

  async requestAccess(): Promise<CalendarAccess> {
    if (!this.#addon.loaded) return "unavailable";
    let access: CalendarAccess;
    try {
      access = await this.#addon.requestAccess();
    } catch {
      this.#warn("requestAccess", "calendar_unavailable");
      return "unavailable";
    }
    if (access === "fullAccess") this.#observe();
    // A new answer can reveal calendars the renderer has not read yet.
    this.#revision += 1;
    this.#onStateChanged(this.#snapshot());
    return access;
  }

  async openPrivacySettings(): Promise<void> {
    for (const url of CALENDAR_PRIVACY_SETTINGS_URLS) {
      try {
        await this.#openExternal(url);
        return;
      } catch {
        // The next URL targets an older System Settings.
      }
    }
    this.#warn("openPrivacySettings", "calendar_unavailable");
  }

  calendars(): Promise<CalendarCalendarsResult> {
    return this.#read("calendars", async () => {
      const result = await this.#addon.calendars();
      if (isCalendarError(result)) return result;
      return { calendars: result.calendars.slice(0, calendarMaxCalendars) };
    });
  }

  events(input: CalendarEventsInput): Promise<CalendarEventsResult> {
    const span = Date.parse(input.end) - Date.parse(input.start);
    if (!(span > 0 && span <= calendarMaxRangeDays * DAY_MS)) {
      return Promise.reject(
        new RangeError(
          `events: the range must be positive and at most ${calendarMaxRangeDays} days.`
        )
      );
    }
    if (input.calendarIds.length > calendarMaxCalendars) {
      return Promise.reject(
        new RangeError(`events: at most ${calendarMaxCalendars} calendars.`)
      );
    }
    return this.#read("events", async () => {
      const result = await this.#addon.events({ ...input, limit: calendarMaxEvents });
      if (isCalendarError(result)) return result;
      return {
        events: result.events.slice(0, calendarMaxEvents),
        truncated: result.truncated || result.events.length > calendarMaxEvents,
      };
    });
  }

  event(input: CalendarEventReference): Promise<CalendarEventResult> {
    return this.#read("event", () => this.#addon.event(input));
  }

  createEvent(input: CalendarCreateEventInput): Promise<CalendarEventResult> {
    try {
      assertEventBounds(input.event, "createEvent");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read("createEvent", () => this.#addon.createEvent(input));
  }

  updateEvent(input: CalendarUpdateEventInput): Promise<CalendarEventResult> {
    try {
      assertEventBounds(input.patch, "updateEvent");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#read("updateEvent", () => this.#addon.updateEvent(input));
  }

  deleteEvent(input: CalendarDeleteEventInput): Promise<CalendarDeleteEventResult> {
    return this.#read("deleteEvent", () => this.#addon.deleteEvent(input));
  }

  #access(): CalendarAccess {
    if (!this.#addon.loaded) return "unavailable";
    try {
      return this.#addon.accessStatus();
    } catch {
      return "unavailable";
    }
  }

  #snapshot(): CalendarState {
    return {
      access: this.#access(),
      available: this.#addon.loaded,
      revision: this.#revision,
    };
  }

  /** Runs one EventKit operation behind the access check, as an error code on failure. */
  async #read<Result>(
    operation: string,
    run: () => Promise<Result | CalendarError>
  ): Promise<Result | CalendarError> {
    if (!this.#addon.loaded) return this.#fail(operation, "calendar_unavailable");
    if (this.#access() !== "fullAccess") {
      return this.#fail(operation, "calendar_access_denied");
    }
    try {
      const result = await run();
      if (isCalendarError(result)) return this.#fail(operation, result.error);
      return result;
    } catch {
      // The thrown text can quote what EventKit was saving; only the code is logged.
      return this.#fail(operation, "calendar_unavailable");
    }
  }

  #fail(operation: string, code: CalendarErrorCode): CalendarError {
    this.#warn(operation, code);
    return { error: code };
  }

  #warn(operation: string, code: CalendarErrorCode) {
    this.#logger.warn(`[calendar] ${operation} failed`, { code });
  }

  #observe() {
    if (this.#stopObserving || this.#closed) return;
    this.#stopObserving = this.#addon.observeChanges(() => this.#noteChange());
  }

  /** At most one notice per window: later changes in it ride on the same one. */
  #noteChange() {
    if (this.#changeTimer !== undefined || this.#closed) return;
    this.#changeTimer = this.#setTimeout(() => {
      this.#changeTimer = undefined;
      this.#revision += 1;
      this.#onStateChanged(this.#snapshot());
    }, CHANGE_COALESCE_MS);
  }
}
