import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calendarKitAddonFileName,
  calendarKitCandidateBinaryPaths,
  loadCalendarKitAddon,
} from "../native/macos/CalendarKit";

const fixture = (name: string) =>
  resolve(process.cwd(), "apps/electron/test/fixtures", name);

describe("calendar addon candidate paths", () => {
  it("loads only the bundled binary in a packaged app", () => {
    expect(
      calendarKitCandidateBinaryPaths({
        isPackaged: true,
        resourcesPath: "/App/Resources",
      })
    ).toEqual([resolve("/App/Resources/native/macos", calendarKitAddonFileName)]);
  });

  it("prefers dist/native and then the node-gyp output from source", () => {
    const cwd = "/repo/clients";
    const candidates = calendarKitCandidateBinaryPaths({ cwd, resourcesPath: "" });
    expect(candidates[0]).toBe(
      resolve(cwd, "dist/native/macos", calendarKitAddonFileName)
    );
    expect(candidates).toContain(
      resolve(
        cwd,
        "apps/electron/native/macos/CalendarKit/build/Release/comma_calendar_kit.node"
      )
    );
  });
});

describe("loadCalendarKitAddon", () => {
  it("decodes the binding's JSON results", async () => {
    const addon = loadCalendarKitAddon({
      binaryPath: fixture("calendar-kit.cjs"),
      platform: "darwin",
    });
    expect(addon.loaded).toBe(true);
    expect(addon.accessStatus()).toBe("fullAccess");
    await expect(addon.calendars()).resolves.toMatchObject({
      calendars: [{ id: "cal-1", title: "Comma Teste" }],
    });
    await expect(
      addon.events({
        calendarIds: ["cal-1"],
        end: "2026-10-26T00:00:00Z",
        limit: 2_500,
        start: "2026-10-19T00:00:00Z",
      })
    ).resolves.toEqual({ events: [], truncated: false });
    await expect(addon.event({ eventId: "x", occurrenceDate: null })).resolves.toEqual({
      error: "calendar_event_not_found",
    });
    await expect(
      addon.deleteEvent({ eventId: "x", occurrenceDate: null, scope: "series" })
    ).resolves.toBeUndefined();
  });

  it("shares one native observer between listeners and stops it with the last", () => {
    const binaryPath = fixture("calendar-kit.cjs");
    const addon = loadCalendarKitAddon({ binaryPath, platform: "darwin" });
    const native = createRequire(import.meta.url)(binaryPath) as {
      emitChange(): void;
      starts(): number;
    };
    const before = native.starts();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = addon.observeChanges(first);
    const stopSecond = addon.observeChanges(second);
    native.emitChange();
    expect(native.starts() - before).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
    native.emitChange();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("rejects a binding without the write API", async () => {
    const logger = { warn: vi.fn() };
    const addon = loadCalendarKitAddon({
      binaryPath: fixture("calendar-kit-missing-api.cjs"),
      logger,
      platform: "darwin",
    });
    expect(addon.loaded).toBe(false);
    expect(addon.loadError?.message).toContain("has an invalid API");
    expect(logger.warn).toHaveBeenCalled();
    await expect(addon.calendars()).resolves.toEqual({ error: "calendar_unavailable" });
  });

  it("is unavailable off macOS", async () => {
    const addon = loadCalendarKitAddon({ platform: "linux" });
    expect(addon.loaded).toBe(false);
    expect(addon.accessStatus()).toBe("unavailable");
    await expect(addon.requestAccess()).resolves.toBe("unavailable");
  });
});
