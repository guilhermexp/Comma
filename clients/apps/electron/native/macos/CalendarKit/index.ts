import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type {
  CalendarAccess,
  CalendarCalendarsResult,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarDeleteEventResult,
  CalendarEventReference,
  CalendarEventResult,
  CalendarEventsInput,
  CalendarEventsResult,
  CalendarUpdateEventInput,
} from "@comma/native-bridge";

export const calendarKitAddonFileName = "comma-calendar-kit.node";

/**
 * The Mac Calendar through EventKit. Every read and write resolves with either
 * its result or `{ error }`; it rejects only on a broken addon.
 */
export type CalendarKitAddon = {
  readonly loaded: boolean;
  readonly binaryPath?: string;
  readonly loadError?: Error;
  /** The current permission, read without asking the user anything. */
  accessStatus(): CalendarAccess;
  /** Shows the system prompt while undecided; resolves with the answer. */
  requestAccess(): Promise<CalendarAccess>;
  calendars(): Promise<CalendarCalendarsResult>;
  /** Occurrences in the range, expanded from their series, at most `limit`. */
  events(input: CalendarEventsInput & { limit: number }): Promise<CalendarEventsResult>;
  event(input: CalendarEventReference): Promise<CalendarEventResult>;
  createEvent(input: CalendarCreateEventInput): Promise<CalendarEventResult>;
  updateEvent(input: CalendarUpdateEventInput): Promise<CalendarEventResult>;
  deleteEvent(input: CalendarDeleteEventInput): Promise<CalendarDeleteEventResult>;
  /**
   * Calls `listener` on every `EKEventStoreChangedNotification`, uncoalesced.
   * Returns the function that stops observing.
   */
  observeChanges(listener: () => void): () => void;
};

/** The raw binding: requests and results cross as JSON text. */
type NativeCalendarKitAddon = {
  accessStatus(): string;
  requestAccess(): Promise<string>;
  calendars(): Promise<string>;
  events(request: string): Promise<string>;
  event(request: string): Promise<string>;
  createEvent(request: string): Promise<string>;
  updateEvent(request: string): Promise<string>;
  deleteEvent(request: string): Promise<string>;
  startObserving(listener: () => void): void;
  stopObserving(): void;
};

type LoadCalendarKitAddonOptions = {
  binaryPath?: string;
  isPackaged?: boolean;
  logger?: Pick<Console, "warn">;
  platform?: NodeJS.Platform;
};

const nativeMethods = [
  "accessStatus",
  "requestAccess",
  "calendars",
  "events",
  "event",
  "createEvent",
  "updateEvent",
  "deleteEvent",
  "startObserving",
  "stopObserving",
] as const;

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function isNativeAddon(value: unknown): value is NativeCalendarKitAddon {
  if (typeof value !== "object" || value === null) return false;
  const addon = value as Record<string, unknown>;
  return nativeMethods.every((method) => typeof addon[method] === "function");
}

export function calendarKitCandidateBinaryPaths({
  cwd = process.cwd(),
  environmentPath = process.env.COMMA_CALENDAR_KIT_PATH,
  explicitPath,
  isPackaged = false,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath,
}: {
  cwd?: string;
  environmentPath?: string;
  explicitPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
} = {}) {
  // Overrides are exclusive, as for the notification authorization addon.
  if (explicitPath) return [explicitPath];
  if (!isPackaged && environmentPath) return [environmentPath];

  const resourcesCandidate = resourcesPath
    ? resolve(resourcesPath, "native/macos", calendarKitAddonFileName)
    : undefined;
  if (isPackaged) return resourcesCandidate ? [resourcesCandidate] : [];

  const gypOutput = "native/macos/CalendarKit/build";
  const developmentCandidates = [
    resourcesCandidate,
    resolve(cwd, "dist/native/macos", calendarKitAddonFileName),
    resolve(cwd, "apps/electron/dist/native/macos", calendarKitAddonFileName),
    ...["Debug", "Release"].flatMap((configuration) => [
      resolve(cwd, gypOutput, configuration, "comma_calendar_kit.node"),
      resolve(cwd, "apps/electron", gypOutput, configuration, "comma_calendar_kit.node"),
      resolve(
        cwd,
        "clients/apps/electron",
        gypOutput,
        configuration,
        "comma_calendar_kit.node"
      ),
    ]),
  ];
  return [
    ...new Set(developmentCandidates.filter((path): path is string => Boolean(path))),
  ];
}

const unavailable = { error: "calendar_unavailable" } as const;

/** The addon a process without EventKit answers with: every call is unavailable. */
export function unavailableCalendarKitAddon(
  error = new Error("The calendar addon is not loaded.")
): CalendarKitAddon {
  return {
    loaded: false,
    loadError: error,
    accessStatus: () => "unavailable",
    requestAccess: () => Promise.resolve("unavailable"),
    calendars: () => Promise.resolve(unavailable),
    events: () => Promise.resolve(unavailable),
    event: () => Promise.resolve(unavailable),
    createEvent: () => Promise.resolve(unavailable),
    updateEvent: () => Promise.resolve(unavailable),
    deleteEvent: () => Promise.resolve(unavailable),
    observeChanges: () => () => undefined,
  };
}

function wrapNativeAddon(
  nativeAddon: NativeCalendarKitAddon,
  binaryPath: string
): CalendarKitAddon {
  const call = async <Result>(
    method: "events" | "event" | "createEvent" | "updateEvent" | "deleteEvent",
    request: unknown
  ) => JSON.parse(await nativeAddon[method](JSON.stringify(request))) as Result;
  const listeners = new Set<() => void>();
  return {
    loaded: true,
    binaryPath,
    accessStatus: () => nativeAddon.accessStatus() as CalendarAccess,
    requestAccess: async () => (await nativeAddon.requestAccess()) as CalendarAccess,
    calendars: async () =>
      JSON.parse(await nativeAddon.calendars()) as CalendarCalendarsResult,
    events: (input) => call("events", input),
    event: (input) => call("event", input),
    createEvent: (input) => call("createEvent", input),
    updateEvent: (input) => call("updateEvent", input),
    // A successful delete answers `{}` across the binding; the contract says void.
    deleteEvent: async (input) => {
      const result = await call<CalendarDeleteEventResult | object>("deleteEvent", input);
      return result && "error" in result ? result : undefined;
    },
    observeChanges(listener) {
      if (listeners.size === 0) {
        nativeAddon.startObserving(() => {
          for (const next of listeners) next();
        });
      }
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        nativeAddon.stopObserving();
      };
    },
  };
}

export function loadCalendarKitAddon(
  options: LoadCalendarKitAddonOptions = {}
): CalendarKitAddon {
  if ((options.platform ?? process.platform) !== "darwin") {
    return unavailableCalendarKitAddon(
      new Error("The calendar addon is only available on macOS.")
    );
  }

  // See NotificationAuthorization: Vite empties `import.meta` in bundled Main.
  const require = createRequire(resolve(process.cwd(), "comma-calendar-kit-loader.cjs"));
  const candidates = calendarKitCandidateBinaryPaths({
    ...(options.binaryPath !== undefined ? { explicitPath: options.binaryPath } : {}),
    ...(options.isPackaged !== undefined ? { isPackaged: options.isPackaged } : {}),
  });
  let lastError: Error | undefined;

  for (const binaryPath of candidates) {
    if (!existsSync(binaryPath)) continue;
    try {
      const nativeAddon: unknown = require(binaryPath);
      if (!isNativeAddon(nativeAddon)) {
        throw new Error(`Calendar addon at ${binaryPath} has an invalid API.`);
      }
      return wrapNativeAddon(nativeAddon, binaryPath);
    } catch (error) {
      lastError = asError(error);
    }
  }

  const loadError =
    lastError ??
    new Error(`Calendar addon was not found. Checked: ${candidates.join(", ")}`);
  options.logger?.warn("[calendar] native addon unavailable", loadError);
  return unavailableCalendarKitAddon(loadError);
}
