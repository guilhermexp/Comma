import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PushToTalkShortcut } from "@comma/native-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSideChatService } from "../native-side-chat";
import { createNativePushToTalkHotkey } from "../push-to-talk/native-hotkey";

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

const fixturePath = fileURLToPath(
  new URL(
    "../../../test/fixtures/side-chat-shortcut-push-to-talk-host.cjs",
    import.meta.url
  )
);

const controlOptionSpace: PushToTalkShortcut = {
  key: "space",
  modifiers: { alt: true, control: true, meta: false, shift: false },
};
const controlOption: PushToTalkShortcut = { ...controlOptionSpace, key: null };

describe("push-to-talk hotkey over the Side Chat helper", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function startFixture(
    mode:
      | "chord"
      | "crash-while-held"
      | "reject"
      | "crash-before-ack"
      | "stale-ack-crash"
      | "crash-on-second"
  ) {
    const directory = await mkdtemp(join(tmpdir(), "comma-ptt-fixture-"));
    const logPath = join(directory, "frames.jsonl");
    const service = new NativeSideChatService({
      resolveExecutablePath: () => fixturePath,
      spawnHost: (_path, environment) =>
        spawn(process.execPath, [fixturePath], {
          env: {
            ...environment,
            COMMA_PTT_FIXTURE_LOG: logPath,
            COMMA_PTT_FIXTURE_MODE: mode,
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    cleanups.push(() => service.dispose());
    const registrations = async () => {
      const text = await readFile(logPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    };
    return { registrations, service };
  }

  it("registers a shortcut only once when registration starts the helper", async () => {
    const { registrations, service } = await startFixture("chord");
    const hotkey = createNativePushToTalkHotkey(service);

    await hotkey.register(controlOptionSpace);

    expect(await registrations()).toEqual([
      { binding: { keyCode: 49, modifiers: 6_144 } },
    ]);
  });

  it("registers the chord, reports press and release, and replays it after a helper crash", async () => {
    const { registrations, service } = await startFixture("crash-while-held");
    const hotkey = createNativePushToTalkHotkey(service);
    const events: unknown[] = [];
    hotkey.onPressed((event) => events.push({ pressed: event }));
    hotkey.onReleased((event) => events.push({ released: event }));
    hotkey.onHelperRestarted(() => events.push("helper-restarted"));
    service.start();

    // Off by default: starting the helper registers no hold-to-talk chord.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await registrations()).toEqual([]);

    await expect(hotkey.register(controlOptionSpace)).resolves.toEqual({
      inputMonitoring: "not-needed",
    });
    await vi.waitFor(
      () => {
        expect(events).toEqual([
          {
            pressed: {
              frontmostApp: { bundleId: "com.apple.Safari", name: "Safari" },
            },
          },
          // The crashed helper can no longer deliver the release.
          "helper-restarted",
          // The restarted helper received the replayed chord.
          { pressed: { frontmostApp: null } },
          { released: { cancelled: false } },
        ]);
      },
      { interval: 20, timeout: 4_000 }
    );
    expect(await registrations()).toEqual([
      { binding: { keyCode: 49, modifiers: 6_144 } },
      { binding: { keyCode: 49, modifiers: 6_144 } },
    ]);

    await hotkey.register(null);
    expect((await registrations()).at(-1)).toEqual({ binding: null });
  });

  it("rejects a chord the helper cannot register and does not replay it", async () => {
    const { registrations, service } = await startFixture("reject");
    const hotkey = createNativePushToTalkHotkey(service);
    service.start();

    await expect(hotkey.register(controlOptionSpace)).rejects.toThrow(
      "The fixture refused the push-to-talk chord."
    );
    expect(await registrations()).toEqual([
      { binding: { keyCode: 49, modifiers: 6_144 } },
    ]);
  });

  it("registers a modifier-only chord, reports Input Monitoring and a cancelled release", async () => {
    const { registrations, service } = await startFixture("chord");
    const hotkey = createNativePushToTalkHotkey(service);
    const events: unknown[] = [];
    hotkey.onPressed((event) => events.push({ pressed: event }));
    hotkey.onReleased((event) => events.push({ released: event }));
    hotkey.onInputMonitoring((state) => events.push({ inputMonitoring: state }));
    service.start();

    // ⌃⌥ alone: the helper observes it only with Input Monitoring.
    await expect(hotkey.register(controlOption)).resolves.toEqual({
      inputMonitoring: "denied",
    });
    await hotkey.requestInputMonitoring();
    await vi.waitFor(
      () =>
        expect(events).toEqual([
          { inputMonitoring: "denied" },
          { inputMonitoring: "granted" },
          { pressed: { frontmostApp: { bundleId: null, name: "Finder" } } },
          { released: { cancelled: false } },
          { pressed: { frontmostApp: null } },
          // ⌃⌥ joined by another key: a different shortcut.
          { released: { cancelled: true } },
        ]),
      { interval: 20, timeout: 2_000 }
    );

    // A chord with a regular key never needs Input Monitoring.
    await expect(hotkey.register(controlOptionSpace)).resolves.toEqual({
      inputMonitoring: "not-needed",
    });
    await expect(hotkey.register(null)).resolves.toEqual({
      inputMonitoring: "not-needed",
    });
    expect(await registrations()).toEqual([
      { binding: { modifiers: 6_144 } },
      { request: "input-monitoring" },
      { binding: { keyCode: 49, modifiers: 6_144 } },
      { binding: null },
    ]);
  });

  it("asks the helper for Screen Recording and resolves once it confirmed", async () => {
    const { registrations, service } = await startFixture("chord");
    service.start();

    await service.requestPushToTalkScreenRecording();
    expect(await registrations()).toEqual([{ request: "screen-recording" }]);
  });

  it("stops delivering events to a listener after it unsubscribes", async () => {
    const { service } = await startFixture("crash-while-held");
    const hotkey = createNativePushToTalkHotkey(service);
    const pressed = vi.fn();
    const stillListening = vi.fn();
    hotkey.onPressed(pressed)();
    hotkey.onPressed(stillListening);
    service.start();

    await hotkey.register(controlOptionSpace);
    await vi.waitFor(() => expect(stillListening).toHaveBeenCalled(), {
      interval: 20,
      timeout: 2_000,
    });
    expect(pressed).not.toHaveBeenCalled();
  });

  it("re-registers the chord when the helper restarts before first enable registration returns", async () => {
    const { registrations, service } = await startFixture("crash-before-ack");
    const hotkey = createNativePushToTalkHotkey(service);
    service.start();

    // First enable of PTT: helper crashes before registration returns.
    // The original register promise may settle/reject on host loss, but desired registration must recover.
    const initialPromise = hotkey.register(controlOptionSpace).catch(() => undefined);
    await initialPromise;

    // Helper restarts and replays desired registration
    await vi.waitFor(
      async () => {
        const reg = await registrations();
        expect(reg).toEqual([
          { binding: { keyCode: 49, modifiers: 6_144 } },
          { binding: { keyCode: 49, modifiers: 6_144 } },
        ]);
      },
      { interval: 20, timeout: 4_000 }
    );
  });

  it("re-registers the updated chord when the helper restarts before shortcut change registration returns", async () => {
    const { registrations, service } = await startFixture("crash-on-second");
    const hotkey = createNativePushToTalkHotkey(service);
    service.start();

    // 1. Initial chord registration succeeds
    await expect(hotkey.register(controlOption)).resolves.toEqual({
      inputMonitoring: "denied",
    });
    expect(await registrations()).toEqual([{ binding: { modifiers: 6_144 } }]);

    // 2. Change to new chord (controlOptionSpace) on the SAME service; helper crashes before ack
    const changePromise = hotkey.register(controlOptionSpace).catch(() => undefined);
    await changePromise;

    // 3. Restarted replacement helper must receive the desired updated chord (controlOptionSpace, keyCode 49),
    // not the old chord (controlOption)
    await vi.waitFor(
      async () => {
        const reg = await registrations();
        expect(reg).toEqual([
          { binding: { modifiers: 6_144 } },
          { binding: { keyCode: 49, modifiers: 6_144 } },
          { binding: { keyCode: 49, modifiers: 6_144 } },
        ]);
      },
      { interval: 20, timeout: 4_000 }
    );
  });

  it("fences stale helper registration results across helper restarts against newer user intent", async () => {
    const { registrations, service } = await startFixture("stale-ack-crash");
    const hotkey = createNativePushToTalkHotkey(service);
    service.start();

    // Initial registration starts with chord 1 (controlOptionSpace)
    const firstRegister = hotkey.register(controlOptionSpace);

    // Newer intent is submitted: chord 2 (controlOption)
    const secondRegister = hotkey.register(controlOption).catch(() => undefined);

    // Older update must reject explicitly as superseded
    await expect(firstRegister).rejects.toThrow(
      "The push-to-talk shortcut update was superseded."
    );

    await secondRegister;

    // Across helper crash and restart, the newer intent must win and be the eventual helper state
    await vi.waitFor(
      async () => {
        const reg = await registrations();
        const bindings = reg.filter(
          (r): r is { binding: unknown } =>
            typeof r === "object" && r !== null && "binding" in r
        );
        const lastBinding = bindings.at(-1);
        expect(lastBinding).toEqual({ binding: { modifiers: 6_144 } });
      },
      { interval: 20, timeout: 4_000 }
    );
  });
});
