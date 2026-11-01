import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appPreferencesSchema,
  commaClientSettingsSchema,
  defaultCommaClientSettings,
  type AppPreferences,
  type AppPreferencesPatch,
  type CalendarEvent,
} from "@comma/native-bridge";
import type { CalendarKitAddon } from "../../../native/macos/CalendarKit";
import {
  ClientControlApiServer,
  createCommaClientControlRegistry,
} from "../modules/client-control";
import { AirDropService } from "../modules/airdrop";
import { CalendarService } from "../modules/calendar";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Comma Main client-control API", () => {
  it("routes an AirDrop send and returns actionable errors through the authenticated API", async () => {
    const harness = await createHarness();
    const operationId = randomUUID();
    const input = {
      requestId: operationId,
      peerId: "phone-id",
      paths: ["/tmp/report.pdf"],
    };
    const sender = {
      status: () => ({ available: true }),
      find: vi.fn(() => ({ operationId, kind: "find", status: "running" })),
      send: vi.fn((_input: typeof input) => ({
        operationId,
        kind: "send",
        status: "running",
      })),
      operation: vi.fn((_id: string) => ({
        operationId,
        kind: "send",
        status: "succeeded",
      })),
      cancel: vi.fn((_id: string) => ({
        operationId,
        kind: "send",
        status: "cancelled",
      })),
    };
    const server = await ClientControlApiServer.open({
      registry: createCommaClientControlRegistry({
        ...harness,
        airdrop: new AirDropService({ dataDir: harness.artifactRoot }),
        airdropSender: sender,
      }),
      token: "airdrop-control-token",
    });
    const call = async (api: string, args: unknown) => {
      const response = await fetch(`${server.endpoint}/v1/invoke`, {
        method: "POST",
        headers: {
          authorization: "Bearer airdrop-control-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ module: "airdrop", api, input: args }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect(await call("find", {})).toMatchObject({ operationId, status: "running" });
      expect(await call("send", input)).toMatchObject({
        operationId,
        status: "running",
      });
      expect(sender.send).toHaveBeenCalledWith(input);
      // Several files, Drive and Mac paths alike, go to the recipient together.
      const vfsInput = {
        requestId: randomUUID(),
        peerId: "phone-id",
        paths: ["/drive/file.png", "/tmp/report.pdf"],
      };
      expect(await call("send", vfsInput)).toMatchObject({ status: "running" });
      expect(sender.send).toHaveBeenCalledWith(vfsInput);
      expect(await call("operation", { operationId })).toMatchObject({
        status: "succeeded",
      });
      expect(sender.operation).toHaveBeenCalledWith(operationId);
      expect(await call("cancel", { operationId })).toMatchObject({
        status: "cancelled",
      });
      sender.send.mockImplementationOnce(() => {
        throw new Error("Run AirDrop find again.");
      });
      expect(await call("send", input)).toEqual({
        status: "failed",
        error: "Run AirDrop find again.",
      });
    } finally {
      await server.close();
    }
  });

  it("routes remote device access through the local owner", async () => {
    const harness = await createHarness();
    const deviceAccess = vi.fn(async (_workspaceId: string, allow: boolean) => ({
      allows_operations: allow,
    }));
    const registry = createCommaClientControlRegistry({ ...harness, deviceAccess });
    const server = await ClientControlApiServer.open({
      registry,
      token: "device-owner-token",
    });
    try {
      const response = await fetch(`${server.endpoint}/v1/invoke`, {
        method: "POST",
        headers: {
          authorization: "Bearer device-owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          module: "devices",
          api: "set-access",
          input: { workspaceId: "wsp_owned", allow_operations: true },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ allows_operations: true });
      expect(deviceAccess).toHaveBeenCalledWith("wsp_owned", true);
    } finally {
      await server.close();
    }
  });

  it("discovers declarations and rejects absent or incorrect bearer credentials", async () => {
    const harness = await createHarness();
    const server = await ClientControlApiServer.open({
      registry: harness.registry,
      token: "control-token-1",
    });

    try {
      await expect(fetch(`${server.endpoint}/v1/modules`)).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        fetch(`${server.endpoint}/v1/modules`, {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).resolves.toMatchObject({ status: 401 });

      const modules = await request(server.endpoint, "control-token-1", "/v1/modules");
      expect(modules).toEqual({
        modules: [
          expect.objectContaining({ id: "global-settings" }),
          expect.objectContaining({ id: "client-settings" }),
          expect.objectContaining({ id: "in-app-browser" }),
        ],
      });

      const clientSettings = await request(
        server.endpoint,
        "control-token-1",
        "/v1/modules/client-settings"
      );
      expect(clientSettings).toMatchObject({
        apis: [
          expect.objectContaining({ id: "get" }),
          expect.objectContaining({
            id: "update",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                appearance: expect.any(Object),
                appShortcutOverrides: expect.any(Object),
                localePreference: expect.any(Object),
                pushToTalkEnabled: expect.any(Object),
                pushToTalkSendScreen: expect.any(Object),
                pushToTalkShortcut: expect.any(Object),
                sideChatAppearance: expect.any(Object),
                sideChatShortcut: expect.any(Object),
              }),
            }),
          }),
        ],
        id: "client-settings",
      });

      const browser = await request(
        server.endpoint,
        "control-token-1",
        "/v1/modules/in-app-browser"
      );
      expect(browser).toMatchObject({
        apis: [
          expect.objectContaining({ id: "open-tab", usage: expect.any(String) }),
          expect.objectContaining({ id: "list-targets", usage: expect.any(String) }),
          expect.objectContaining({ id: "send-cdp-command" }),
          expect.objectContaining({ id: "capture-screenshot" }),
        ],
        id: "in-app-browser",
      });
    } finally {
      await server.close();
    }
  });

  it("validates invocation inputs and routes settings mutations through Main ownership", async () => {
    const harness = await createHarness();

    await expect(
      harness.registry.invoke({
        api: "update",
        input: { showInDock: false },
        module: "global-settings",
      })
    ).resolves.toEqual({
      airDropName: null,
      keepAwakeWhenLidClosed: false,
      launchAtLogin: false,
      notchSideWidth: 156,
      notificationSound: true,
      notifyRouterMessages: true,
      revision: 1,
      showInAirDrop: true,
      showInDock: false,
      showInMenuBar: true,
      showInNotch: true,
      sideChatEnabled: true,
      systemNotifications: true,
    });
    expect(harness.appPreferences.update).toHaveBeenCalledWith({ showInDock: false });

    // An agent may turn lid-closed keep-awake on or off; Main still owns the
    // daemon approval that only the user can give.
    await expect(
      harness.registry.invoke({
        api: "update",
        input: { keepAwakeWhenLidClosed: true },
        module: "global-settings",
      })
    ).resolves.toMatchObject({ keepAwakeWhenLidClosed: true });
    expect(harness.appPreferences.update).toHaveBeenLastCalledWith({
      keepAwakeWhenLidClosed: true,
    });

    await expect(
      harness.registry.invoke({
        api: "update",
        input: { rendererSecret: "no" },
        module: "global-settings",
      })
    ).rejects.toThrow(/invalid/i);

    await expect(
      harness.registry.invoke({
        api: "update",
        input: {
          appearance: { reducedMotion: true, theme: "dark" },
          localePreference: "zh-CN",
        },
        module: "client-settings",
      })
    ).resolves.toMatchObject({
      appearance: { reducedMotion: true, theme: "dark" },
      localePreference: "zh-CN",
    });
    expect(harness.appPreferences.update).toHaveBeenLastCalledWith({
      clientSettings: {
        appearance: { reducedMotion: true, theme: "dark" },
        localePreference: "zh-CN",
      },
    });
  });

  it("opens and controls exact browser tabs and creates readable screenshot artifacts", async () => {
    const harness = await createHarness();

    await expect(
      harness.registry.invoke({
        api: "open-tab",
        input: { url: "https://example.com/new" },
        module: "in-app-browser",
      })
    ).resolves.toEqual({
      target: expect.objectContaining({
        tabId: "tab-opened",
        url: "https://example.com/new",
      }),
    });
    expect(harness.browser.openClientTab).toHaveBeenCalledWith({
      url: "https://example.com/new",
    });

    await expect(
      harness.registry.invoke({
        api: "list-targets",
        input: {},
        module: "in-app-browser",
      })
    ).resolves.toEqual({
      targets: [
        {
          tabId: "tab-1",
          title: "Linear",
          url: "https://linear.app/",
          visible: true,
        },
      ],
    });

    await expect(
      harness.registry.invoke({
        api: "send-cdp-command",
        input: {
          method: "Runtime.evaluate",
          params: { expression: "document.title", returnByValue: true },
          tabId: "tab-1",
        },
        module: "in-app-browser",
      })
    ).resolves.toEqual({ result: { result: { value: "Linear" } } });
    expect(harness.browser.sendClientCdpCommand).toHaveBeenCalledWith({
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true },
      tabId: "tab-1",
    });

    const captured = (await harness.registry.invoke({
      api: "capture-screenshot",
      input: { tabId: "tab-1" },
      module: "in-app-browser",
    })) as {
      mimeType: string;
      path: string;
      size: number;
      target: { tabId: string };
    };
    expect(captured).toMatchObject({
      mimeType: "image/png",
      size: 8,
      target: { tabId: "tab-1" },
    });
    expect(captured.path.startsWith(harness.artifactRoot)).toBe(true);
    expect(await readFile(captured.path)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  });

  it("caps screenshots at five MiB and uses collision-free temporary artifacts", async () => {
    const harness = await createHarness();
    harness.browser.captureClientScreenshot.mockResolvedValue({
      pngImage: Buffer.alloc(5 * 1024 * 1024 + 1),
      target: browserTarget(),
    });

    await expect(
      harness.registry.invoke({
        api: "capture-screenshot",
        input: { tabId: "tab-1" },
        module: "in-app-browser",
      })
    ).rejects.toThrow(/artifact limit/i);
    expect(await readdir(harness.artifactRoot)).toEqual([]);

    harness.browser.captureClientScreenshot.mockResolvedValue({
      pngImage: Buffer.from([137, 80, 78, 71]),
      target: browserTarget(),
    });
    const captures = await Promise.all(
      Array.from({ length: 9 }, () =>
        harness.registry.invoke({
          api: "capture-screenshot",
          input: { tabId: "tab-1" },
          module: "in-app-browser",
        })
      )
    );
    expect(
      new Set(captures.map((capture) => (capture as { path: string }).path)).size
    ).toBe(9);
    const artifacts = await readdir(harness.artifactRoot);
    expect(artifacts).toHaveLength(8);
    expect(artifacts.some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("rejects oversized bodies before invoking Main handlers", async () => {
    const harness = await createHarness();
    const server = await ClientControlApiServer.open({
      registry: harness.registry,
      token: "control-token-2",
    });

    try {
      const response = await fetch(`${server.endpoint}/v1/invoke`, {
        body: JSON.stringify({
          api: "update",
          input: { value: "x".repeat(70_000) },
          module: "global-settings",
        }),
        headers: {
          authorization: "Bearer control-token-2",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(413);
      expect(harness.appPreferences.update).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

const secretTitle = "Dentist with Ana";
const secretLocation = "Rua Secreta 42";
const secretNotes = "bring the exam results";

function macEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    calendarId: "cal-1",
    detached: false,
    editable: true,
    end: "2026-10-21T11:00:00-03:00",
    eventId: "item-1",
    externalId: null,
    location: secretLocation,
    notes: secretNotes,
    occurrenceDate: null,
    occurrenceId: "item-1",
    recurrence: "none",
    start: "2026-10-21T10:00:00-03:00",
    title: secretTitle,
    url: null,
    ...overrides,
  };
}

async function openCalendarControl(addon: Partial<CalendarKitAddon> = {}) {
  const harness = await createHarness();
  const fake: CalendarKitAddon = {
    loaded: true,
    accessStatus: () => "fullAccess",
    requestAccess: vi.fn(async () => "fullAccess" as const),
    calendars: async () => ({
      calendars: [
        {
          color: "#ff0000",
          id: "cal-1",
          isDefault: true,
          sourceTitle: "iCloud",
          sourceType: "calDAV",
          title: "Home",
          writable: true,
        },
      ],
    }),
    events: vi.fn(async () => ({ events: [macEvent()], truncated: false })),
    event: vi.fn(async () => macEvent()),
    createEvent: vi.fn(async () => macEvent()),
    updateEvent: vi.fn(async () => macEvent({ title: "Moved" })),
    deleteEvent: vi.fn(async () => undefined),
    observeChanges: () => () => undefined,
    ...addon,
  };
  const logger = { warn: vi.fn() };
  const calendar = new CalendarService({
    addon: fake,
    logger,
    onStateChanged: () => undefined,
    openExternal: async () => undefined,
  });
  const server = await ClientControlApiServer.open({
    registry: createCommaClientControlRegistry({ ...harness, calendar }),
    token: "calendar-control-token",
  });
  const call = async (api: string, input: unknown) => {
    const response = await fetch(`${server.endpoint}/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: "Bearer calendar-control-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ module: "calendar", api, input }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { addon: fake, call, logger, server };
}

const week = { start: "2026-10-19T00:00:00-03:00", end: "2026-10-26T00:00:00-03:00" };

describe("Comma Main client-control calendar module", () => {
  it("reads and writes the Mac Calendar through each API", async () => {
    const { addon, call, server } = await openCalendarControl();
    try {
      expect(await call("state", {})).toEqual({
        status: 200,
        body: { access: "fullAccess", available: true, revision: 1 },
      });
      expect((await call("calendars", {})).body).toMatchObject({
        calendars: [{ id: "cal-1", title: "Home", writable: true }],
      });
      expect(await call("events", { calendarIds: ["cal-1"], ...week })).toEqual({
        status: 200,
        body: { events: [macEvent()], truncated: false },
      });
      expect(addon.events).toHaveBeenCalledWith({
        calendarIds: ["cal-1"],
        ...week,
        limit: 2_500,
      });
      const reference = { eventId: "item-1", occurrenceDate: null };
      expect(await call("event", reference)).toEqual({ status: 200, body: macEvent() });
      const created = {
        calendarId: "cal-1",
        event: {
          allDay: false,
          end: "2026-10-22T16:00:00-03:00",
          recurrence: "none",
          start: "2026-10-22T15:00:00-03:00",
          timeZone: "America/Sao_Paulo",
          title: "Meeting",
        },
      };
      expect((await call("create-event", created)).status).toBe(200);
      expect(addon.createEvent).toHaveBeenCalledWith(created);
      const update = { ...reference, patch: { title: "Moved" }, scope: "instance" };
      expect((await call("update-event", update)).body).toMatchObject({
        title: "Moved",
      });
      expect(addon.updateEvent).toHaveBeenCalledWith(update);
      expect(await call("delete-event", { ...reference, scope: "series" })).toEqual({
        status: 200,
        body: {},
      });
      expect(addon.deleteEvent).toHaveBeenCalledWith({ ...reference, scope: "series" });
    } finally {
      await server.close();
    }
  });

  it("creates one event for a replayed creation key", async () => {
    const { addon, call, server } = await openCalendarControl({
      createEvent: vi.fn(async () => macEvent({ eventId: "created-1" })),
    });
    try {
      const created = {
        calendarId: "cal-1",
        creationKey: "msg_1:call_1",
        event: {
          allDay: false,
          end: "2026-10-22T16:00:00-03:00",
          recurrence: "none",
          start: "2026-10-22T15:00:00-03:00",
          timeZone: "America/Sao_Paulo",
          title: "Meeting",
        },
      };
      const [first, concurrent] = await Promise.all([
        call("create-event", created),
        call("create-event", created),
      ]);
      const replay = await call("create-event", created);
      expect(first).toMatchObject({ status: 200, body: { eventId: "created-1" } });
      expect(concurrent.body).toEqual(first.body);
      expect(replay.body).toEqual(first.body);
      expect(addon.createEvent).toHaveBeenCalledTimes(1);
      // The key is Comma's, not EventKit's.
      const { creationKey: _key, ...eventKitInput } = created;
      expect(addon.createEvent).toHaveBeenCalledWith(eventKitInput);

      await call("create-event", { ...created, creationKey: "msg_1:call_2" });
      expect(addon.createEvent).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("refuses invalid input before EventKit and never exposes the access prompt", async () => {
    const { addon, call, server } = await openCalendarControl();
    try {
      // 90 days exceeds the 62-day window.
      expect(
        await call("events", {
          calendarIds: [],
          start: "2026-10-01T00:00:00Z",
          end: "2026-12-30T00:00:00Z",
        })
      ).toEqual({ status: 400, body: { error: "Invalid API input." } });
      expect((await call("event", { eventId: "item-1" })).status).toBe(400);
      expect(
        (
          await call("create-event", {
            calendarId: "cal-1",
            event: {
              allDay: false,
              end: "2026-10-22T15:00:00-03:00",
              recurrence: "none",
              start: "2026-10-22T16:00:00-03:00",
              timeZone: "America/Sao_Paulo",
              title: "Inverted",
            },
          })
        ).status
      ).toBe(400);
      expect(addon.events).not.toHaveBeenCalled();
      expect(addon.createEvent).not.toHaveBeenCalled();
      expect((await call("request-access", {})).status).toBe(404);
      expect(addon.requestAccess).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns calendar_access_denied without full access", async () => {
    const { addon, call, server } = await openCalendarControl({
      accessStatus: () => "notDetermined",
    });
    try {
      expect(await call("events", { calendarIds: [], ...week })).toEqual({
        status: 200,
        body: { error: "calendar_access_denied" },
      });
      expect(await call("calendars", {})).toEqual({
        status: 200,
        body: { error: "calendar_access_denied" },
      });
      expect(addon.events).not.toHaveBeenCalled();
      expect(addon.requestAccess).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("logs failures without event text", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    const { call, logger, server } = await openCalendarControl({
      updateEvent: async () => {
        throw new Error(`EventKit could not save ${secretTitle} at ${secretLocation}`);
      },
      createEvent: async () => ({ error: "calendar_read_only" }),
    });
    try {
      expect(
        await call("update-event", {
          eventId: "item-1",
          occurrenceDate: null,
          patch: {
            title: secretTitle,
            location: secretLocation,
            description: secretNotes,
          },
          scope: "instance",
        })
      ).toEqual({ status: 200, body: { error: "calendar_unavailable" } });
      expect(
        await call("create-event", {
          calendarId: "cal-1",
          event: {
            allDay: false,
            description: secretNotes,
            end: "2026-10-22T16:00:00-03:00",
            location: secretLocation,
            recurrence: "none",
            start: "2026-10-22T15:00:00-03:00",
            timeZone: "America/Sao_Paulo",
            title: secretTitle,
          },
        })
      ).toEqual({ status: 200, body: { error: "calendar_read_only" } });
      expect(logger.warn).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify([
        logger.warn.mock.calls,
        ...consoleSpies.map((spy) => spy.mock.calls),
      ]);
      for (const secret of [secretTitle, secretLocation, secretNotes]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      await server.close();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});

async function createHarness() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "comma-client-control-artifacts-"));
  roots.push(artifactRoot);
  let preferenceState: AppPreferences = {
    airDropName: null,
    keepAwakeWhenLidClosed: false,
    launchAtLogin: false,
    notchSideWidth: 156,
    notificationSound: true,
    notifyRouterMessages: true,
    revision: 0,
    showInAirDrop: true,
    showInDock: true,
    showInMenuBar: true,
    showInNotch: true,
    sideChatEnabled: true,
    systemNotifications: true,
  };
  const appPreferences = {
    state: vi.fn(() => preferenceState),
    update: vi.fn(async (patch: AppPreferencesPatch) => {
      const { clientSettings: clientSettingsPatch, ...topLevelPatch } = patch;
      const currentClientSettings =
        preferenceState.clientSettings ?? structuredClone(defaultCommaClientSettings);
      const nextClientSettings = clientSettingsPatch
        ? commaClientSettingsSchema.parse({
            ...currentClientSettings,
            ...clientSettingsPatch,
            appearance: {
              ...currentClientSettings.appearance,
              ...clientSettingsPatch.appearance,
            },
          })
        : undefined;
      preferenceState = appPreferencesSchema.parse({
        ...preferenceState,
        ...topLevelPatch,
        ...(nextClientSettings ? { clientSettings: nextClientSettings } : {}),
        revision: preferenceState.revision + 1,
      });
      return preferenceState;
    }),
  };
  const browser = {
    captureClientScreenshot: vi.fn(async () => ({
      pngImage: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      target: browserTarget(),
    })),
    listClientTargets: vi.fn(() => [browserTarget()]),
    openClientTab: vi.fn(async ({ url }: { url: string }) => ({
      ...browserTarget(),
      tabId: "tab-opened",
      url,
    })),
    sendClientCdpCommand: vi.fn(async () => ({ result: { value: "Linear" } })),
  };
  const registry = createCommaClientControlRegistry({
    appPreferences,
    artifactRoot,
    browser,
  });
  return { appPreferences, artifactRoot, browser, registry };
}

function browserTarget() {
  return {
    tabId: "tab-1",
    title: "Linear",
    url: "https://linear.app/",
    visible: true,
  };
}

async function request(endpoint: string, token: string, path: string) {
  const response = await fetch(`${endpoint}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}
