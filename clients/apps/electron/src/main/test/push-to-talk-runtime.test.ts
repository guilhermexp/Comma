import { describe, expect, it, vi } from "vitest";
import {
  defaultCommaClientSettings,
  type CommaClientSettings,
  type PushToTalkShortcutBinding,
} from "@comma/native-bridge";
import { PushToTalkController } from "../push-to-talk/controller";
import {
  choosePushToTalkTranscriber,
  PushToTalkRuntime,
  reportPushToTalkInputMonitoring,
  type PushToTalkRuntimeInputs,
} from "../push-to-talk/runtime";
import type { PushToTalkTranscriber } from "../push-to-talk/transcriber";
import type {
  PushToTalkHotkey,
  PushToTalkInputMonitoring,
} from "../push-to-talk/types";
import { FakeClock } from "./support/fake-clock";

const shortcut = {
  key: "k",
  modifiers: { alt: true, control: false, meta: true, shift: false },
} as const;

function withSettings(patch: Partial<CommaClientSettings>) {
  return { clientSettings: { ...defaultCommaClientSettings, ...patch } };
}

function unused(): never {
  throw new Error("No turn runs in these tests.");
}

function transcriber(): PushToTalkTranscriber {
  return { ready: async () => true, transcribe: async () => ({ text: "" }) };
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

function setup(initial: Partial<PushToTalkRuntimeInputs> = {}) {
  let inputs: PushToTalkRuntimeInputs = {
    clientSettings: defaultCommaClientSettings,
    sideChatEnabled: true,
    signedIn: true,
    ...initial,
  };
  const hotkey = {
    register: vi.fn(async (_shortcut: PushToTalkShortcutBinding) => ({
      inputMonitoring: "not-needed" as const,
    })),
    requestInputMonitoring: async () => undefined,
    onPressed: () => () => undefined,
    onReleased: () => () => undefined,
    onInputMonitoring: () => () => undefined,
    onHelperRestarted: () => () => undefined,
  } satisfies PushToTalkHotkey;
  const runtime = new PushToTalkRuntime({
    read: () => inputs,
    createController: (settings) =>
      new PushToTalkController({
        hotkey,
        companion: {
          show: unused,
          setState: unused,
          setLevel: unused,
          setCaption: unused,
          hide: () => undefined,
          onStroke: unused,
          onCaptionClick: () => () => undefined,
        },
        status: { visible: unused, set: unused, setLevel: unused },
        openSideChat: unused,
        microphone: { start: unused },
        screen: { locate: unused, capture: unused },
        transcriber: { ready: unused, transcribe: unused },
        delivery: { send: unused },
        speaker: { speak: unused, stop: () => undefined },
        replies: { arm: unused, cancel: () => undefined },
        clock: new FakeClock(),
        powerMonitor: { on: () => undefined, removeListener: () => undefined },
        removeFile: async () => undefined,
        settings,
      }),
  });
  const change = async (patch: Partial<PushToTalkRuntimeInputs>) => {
    inputs = { ...inputs, ...patch };
    runtime.refresh();
    await flush();
  };
  const registered = () => hotkey.register.mock.calls.map(([binding]) => binding);
  return { change, hotkey, registered, runtime };
}

describe("PushToTalkRuntime", () => {
  it("registers the shortcut when Talk to agent is turned on and clears it when turned off", async () => {
    const { change, registered, runtime } = setup();
    runtime.start();
    await flush();
    expect(registered()).toEqual([null]);

    await change(
      withSettings({ pushToTalkEnabled: true, pushToTalkShortcut: shortcut })
    );
    expect(registered()).toEqual([null, shortcut]);

    await change(
      withSettings({ pushToTalkEnabled: false, pushToTalkShortcut: shortcut })
    );
    expect(registered()).toEqual([null, shortcut, null]);
    runtime.dispose();
  });

  it("follows a new shortcut without a restart", async () => {
    const { change, registered, runtime } = setup(
      withSettings({ pushToTalkEnabled: true })
    );
    runtime.start();
    await flush();
    expect(registered()).toEqual([defaultCommaClientSettings.pushToTalkShortcut]);

    await change(
      withSettings({ pushToTalkEnabled: true, pushToTalkShortcut: shortcut })
    );
    expect(registered()).toEqual([
      defaultCommaClientSettings.pushToTalkShortcut,
      shortcut,
    ]);
    runtime.dispose();
  });

  it("clears the shortcut while Side Chat is off and restores it when Side Chat returns", async () => {
    const { change, registered, runtime } = setup(
      withSettings({ pushToTalkEnabled: true, pushToTalkShortcut: shortcut })
    );
    runtime.start();
    await flush();

    await change({ sideChatEnabled: false });
    expect(registered()).toEqual([shortcut, null]);
    await change({ sideChatEnabled: true });
    expect(registered()).toEqual([shortcut, null, shortcut]);
    runtime.dispose();
  });

  it("clears the shortcut when the session ends and registers nothing before sign-in", async () => {
    const { change, registered, runtime } = setup({
      ...withSettings({ pushToTalkEnabled: true, pushToTalkShortcut: shortcut }),
      signedIn: false,
    });
    runtime.start();
    await flush();
    expect(registered()).toEqual([null]);

    await change({ signedIn: true });
    await change({ signedIn: false });
    expect(registered()).toEqual([null, shortcut, null]);
    runtime.dispose();
  });

  it("reapplies nothing when an unrelated preference changes", async () => {
    const { change, registered, runtime } = setup(
      withSettings({ pushToTalkEnabled: true })
    );
    runtime.start();
    await flush();
    await change(withSettings({ pushToTalkEnabled: true, meetingHideRecorder: true }));
    expect(registered()).toHaveLength(1);
    runtime.dispose();
  });
});

describe("reportPushToTalkInputMonitoring", () => {
  it("reports the state of every registration and every later helper change", async () => {
    const listeners = new Set<(state: PushToTalkInputMonitoring) => void>();
    const register = vi.fn(async (binding: PushToTalkShortcutBinding) => ({
      inputMonitoring: (binding?.key === null ? "denied" : "not-needed") as
        | "denied"
        | "not-needed",
    }));
    const report = vi.fn();
    const hotkey = reportPushToTalkInputMonitoring(
      {
        register,
        requestInputMonitoring: async () => undefined,
        onPressed: () => () => undefined,
        onReleased: () => () => undefined,
        onInputMonitoring: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onHelperRestarted: () => () => undefined,
      },
      report
    );

    await expect(
      hotkey.register(defaultCommaClientSettings.pushToTalkShortcut)
    ).resolves.toEqual({
      inputMonitoring: "denied",
    });
    // Granted later in System Settings, without re-registering.
    for (const listener of listeners) listener("granted");
    await hotkey.register(shortcut);
    expect(report.mock.calls).toEqual([["denied"], ["granted"], ["not-needed"]]);
  });
});

describe("choosePushToTalkTranscriber", () => {
  it("uses the local backend's CommaTranscriber in local mode", () => {
    const local = transcriber();
    const remote = vi.fn(transcriber);
    expect(
      choosePushToTalkTranscriber({
        localBackend: { pushToTalkTranscriber: local },
        remote,
      })
    ).toBe(local);
    expect(remote).not.toHaveBeenCalled();
  });

  it("uses the server's recording transcription in remote mode", () => {
    const remoteTranscriber = transcriber();
    expect(
      choosePushToTalkTranscriber({
        localBackend: undefined,
        remote: () => remoteTranscriber,
      })
    ).toBe(remoteTranscriber);
  });

  it("reports transcription unavailable in a local build without the helper", async () => {
    const remote = vi.fn(transcriber);
    const chosen = choosePushToTalkTranscriber({
      localBackend: { pushToTalkTranscriber: undefined },
      remote,
    });
    expect(await chosen.ready()).toBe(false);
    expect(remote).not.toHaveBeenCalled();
  });
});
