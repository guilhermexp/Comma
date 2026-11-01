import { describe, expect, it, vi } from "vitest";
import {
  defaultCommaClientSettings,
  type PushToTalkShortcutBinding,
} from "@comma/native-bridge";
import type { VoiceCallEvent } from "@comma/app/api";
import { PushToTalkController, warmSessionMs } from "../push-to-talk/controller";
import {
  PushToTalkRuntime,
  type PushToTalkRuntimeInputs,
} from "../push-to-talk/runtime";
import type {
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkSettings,
  PushToTalkTurnState,
} from "../push-to-talk/types";
import type { PushToTalkScreenCaptureResult } from "../push-to-talk/screen-capture";
import {
  GptLiveVoice,
  type PushToTalkCallEvent,
  type PushToTalkLiveCall,
  type PushToTalkVoiceApi,
} from "../push-to-talk/live-voice";
import { FakeClock } from "./support/fake-clock";

const flush = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};

const shortcut: PushToTalkShortcutBinding = {
  key: "k",
  modifiers: { alt: true, control: false, meta: true, shift: false },
};

const target = { workspaceId: "wsp_1", groupId: "grp_1", conversationId: "cnv_home" };

const defaultSettings: PushToTalkSettings = {
  enabled: true,
  sendScreen: true,
  shortcut: {
    key: null,
    modifiers: { alt: true, control: true, meta: false, shift: false },
  },
};

const captured: PushToTalkScreenCaptureResult = {
  status: "captured",
  finalize: () => ({
    width: 2560,
    height: 1600,
    cursor: { x: 50, y: 60 },
    images: [
      { name: "screen.png", mediaType: "image/png", data: Buffer.from([1, 2, 3]) },
    ],
  }),
};

class FakeVoiceCall implements PushToTalkLiveCall {
  listeners = new Set<(event: PushToTalkCallEvent) => void>();
  active = false;
  listening = false;
  warmCalls = 0;
  openCalls = 0;
  openingDeferred = Promise.withResolvers<typeof target>();

  warm = vi.fn(async () => {
    this.warmCalls++;
  });

  close = vi.fn(() => {
    this.active = false;
    this.listening = false;
  });

  destroy = vi.fn(() => {
    this.close();
  });

  beginContext = vi.fn(async (_contextId: number): Promise<void> => undefined);
  appendContext = vi.fn(
    async (_input: Parameters<PushToTalkLiveCall["appendContext"]>[0]): Promise<void> =>
      undefined
  );
  cancelContext = vi.fn((_contextId: number): void => undefined);
  failContext = vi.fn(async (_contextId: number): Promise<void> => undefined);

  open = vi.fn(() => {
    this.openCalls++;
    this.active = true;
    return this.openingDeferred.promise;
  });

  setListening(value: boolean) {
    this.listening = value;
  }

  onEvent(listener: (event: PushToTalkCallEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PushToTalkCallEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function setupControllerHarness(
  options: {
    voice?: FakeVoiceCall;
    settings?: PushToTalkSettings;
  } = {}
) {
  const clock = new FakeClock();
  const voice = options.voice ?? new FakeVoiceCall();

  let press:
    | ((input: { frontmostApp: PushToTalkFrontmostApp | null }) => void)
    | undefined;
  let release: ((input: { cancelled: boolean }) => void) | undefined;
  let status: PushToTalkTurnState | null = null;

  const hotkey: PushToTalkHotkey = {
    register: vi.fn(async () => ({ inputMonitoring: "granted" as const })),
    requestInputMonitoring: async () => undefined,
    onInputMonitoring: () => () => undefined,
    onPressed: (fn) => {
      press = fn;
      return () => {
        press = undefined;
      };
    },
    onReleased: (fn) => {
      release = fn;
      return () => {
        release = undefined;
      };
    },
    onHelperRestarted: () => () => undefined,
  };

  const companion = {
    show: vi.fn(),
    setState: vi.fn(),
    setDrawing: vi.fn(),
    setLevel: vi.fn(),
    setCaption: vi.fn(),
    hide: vi.fn(),
    onStroke: () => () => undefined,
    onCaptionClick: () => () => undefined,
  };

  const controller = new PushToTalkController({
    hotkey,
    voice,
    clock,
    companion,
    screenRecording: {
      status: vi.fn(() => "granted"),
      request: vi.fn(async () => undefined),
    },
    screen: {
      locate: () => ({
        displayId: 1,
        cursor: { x: 500, y: 300 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2,
      }),
      capture: vi.fn(async () => captured),
    },
    status: {
      visible: () => true,
      set: vi.fn((state: PushToTalkTurnState | null) => {
        status = state;
      }),
      setLevel: vi.fn(),
    },
    powerMonitor: { on: () => undefined, removeListener: () => undefined },
    openSideChat: vi.fn(),
    isCurrentCaller: () => true,
    settings: options.settings ?? defaultSettings,
    sessionGeneration: 1,
  });

  return {
    clock,
    controller,
    voice,
    companion,
    status: () => status,
    press: (frontmostApp: PushToTalkFrontmostApp | null = null) =>
      press?.({ frontmostApp }),
    release: (cancelled = false) => release?.({ cancelled }),
  };
}

describe("PushToTalk E1 voice window warmup and delayed getUserMedia regression", () => {
  it("warms hidden PTT voice window and peer on availability via controller and closes when disabled", async () => {
    const voice = new FakeVoiceCall();
    const h = setupControllerHarness({ voice, settings: defaultSettings });

    h.controller.start();
    await flush();

    // Availability warming: voice.warm is called without opening a live service call
    expect(voice.warm).toHaveBeenCalledTimes(1);
    expect(voice.open).not.toHaveBeenCalled();

    // Disabling closes and cleans up the voice window/session
    h.controller.update({ ...defaultSettings, enabled: false });
    await flush();

    expect(voice.close).toHaveBeenCalled();
    h.controller.dispose();
  });

  it("exercises real PushToTalkRuntime wiring to warm voice on availability and update across preference changes", async () => {
    let inputs: PushToTalkRuntimeInputs = {
      clientSettings: {
        ...defaultCommaClientSettings,
        pushToTalkEnabled: false,
      },
      sideChatEnabled: true,
      signedIn: true,
      sessionGeneration: 1,
    };

    const voice = new FakeVoiceCall();

    const runtime = new PushToTalkRuntime({
      read: () => inputs,
      createController: (settings, sessionGeneration) => {
        const h = setupControllerHarness({ voice, settings });
        return {
          start: () => h.controller.start(),
          update: (s) => h.controller.update(s, sessionGeneration),
          dispose: () => h.controller.dispose(),
        };
      },
    });

    runtime.start();
    await flush();

    // Initially disabled: voice.warm is not called
    expect(voice.warm).not.toHaveBeenCalled();

    // User enables Talk to agent: availability triggers voice.warm()
    inputs = {
      ...inputs,
      clientSettings: {
        ...defaultCommaClientSettings,
        pushToTalkEnabled: true,
        pushToTalkShortcut: shortcut,
      },
    };
    runtime.refresh();
    await flush();

    expect(voice.warm).toHaveBeenCalledTimes(1);
    expect(voice.open).not.toHaveBeenCalled();

    // User disables Talk to agent: voice.close() is called
    inputs = {
      ...inputs,
      clientSettings: {
        ...defaultCommaClientSettings,
        pushToTalkEnabled: false,
      },
    };
    runtime.refresh();
    await flush();

    expect(voice.close).toHaveBeenCalled();

    runtime.dispose();
  });

  it("first press reuses already-warmed voice without opening an extra service call", async () => {
    const voice = new FakeVoiceCall();
    const h = setupControllerHarness({ voice });

    h.controller.start();
    await flush();

    // Warmed once on start
    expect(voice.warm).toHaveBeenCalledTimes(1);
    expect(voice.open).not.toHaveBeenCalled();

    // First press initiates the call
    h.press();
    await flush();

    expect(voice.open).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("delayed getUserMedia after valid release sends no audio or context and clears presentation via media_delayed event", async () => {
    const voice = new FakeVoiceCall();
    const h = setupControllerHarness({ voice });

    h.controller.start();
    await flush();

    // 1. User presses shortcut: starts gesture while media is pending
    h.press();
    await flush();

    // While held, notch presents listening
    expect(h.status()).toEqual({ kind: "listening" });

    // 2. Gesture is held for a valid duration (400ms >= 300ms minGestureMs)
    h.clock.advance(400);

    // 3. User releases shortcut: valid release
    h.release(false);
    await flush();

    // 4. Renderer media initializes late (after release) and reports media_delayed
    voice.emit({ kind: "media_delayed", contextId: 1 });
    await flush();

    // Opening resolves after media delayed report
    voice.openingDeferred.resolve(target);
    await flush();

    // Under E1: if media becomes ready only after valid release, end gesture with NO context sent
    expect(voice.appendContext).not.toHaveBeenCalled();

    // Under E1: presentation is cleared immediately, notch is not stuck in Ouvindo or Pensando
    expect(h.status()).toBeNull();
    expect(h.companion.hide).toHaveBeenCalled();

    h.controller.dispose();
  });

  it("stale media_delayed from an older gesture does not cancel a newer gesture", async () => {
    const voice = new FakeVoiceCall();
    voice.openingDeferred.resolve(target);
    const h = setupControllerHarness({ voice });
    h.controller.start();
    await flush();

    // Gesture 1 pressed and released
    h.press();
    await flush();
    h.clock.advance(400);
    h.release(false);
    await flush();

    // Newer gesture 2 begins
    h.press();
    await flush();
    expect(h.status()).toEqual({ kind: "listening" });

    // Stale media_delayed event arrives for older contextId (1)
    voice.emit({ kind: "media_delayed", contextId: 1 });
    await flush();

    // Newer gesture 2 is NOT cancelled by the stale report
    expect(h.status()).toEqual({ kind: "listening" });

    h.controller.dispose();
  });

  it("ordinary idle/end keeps voice pre-warmed while PTT remains enabled", async () => {
    const voice = new FakeVoiceCall();
    voice.openingDeferred.resolve(target);
    const h = setupControllerHarness({ voice });
    h.controller.start();
    await flush();

    expect(voice.warm).toHaveBeenCalledTimes(1);

    // Turn runs and releases
    h.press();
    await flush();
    h.clock.advance(400);
    h.release(false);
    await flush();

    // Still idle, waiting for warmSessionMs (90,000 ms)
    expect(voice.warm).toHaveBeenCalledTimes(1);

    // Advance clock past warmSessionMs (90,000 ms) so session reaches idle timeout
    h.clock.advance(warmSessionMs);
    await flush();

    // Voice call was closed for the finished turn, and voice window is re-warmed
    expect(voice.warm).toHaveBeenCalledTimes(2);
    expect(voice.destroy).not.toHaveBeenCalled();

    // Disabling destroys the prewarmed window
    h.controller.update({ ...defaultSettings, enabled: false });
    await flush();
    expect(voice.destroy).toHaveBeenCalled();

    h.controller.dispose();
  });

  it("real integrated GptLiveVoice and controller send no context after delayed media and clear presentation", async () => {
    const clock = new FakeClock();
    const batches: VoiceCallEvent[][] = [];
    let cursor = 0;
    const api: PushToTalkVoiceApi = {
      startVoiceCall: vi.fn(async () => ({ call_id: "vc_real", sdp: "sdp_answer" })),
      appendVoiceCallContext: vi.fn(async () => ({ accepted: true as const })),
      uploadGroupFile: vi.fn(async () => ({
        path: "/uploads/file.png",
        name: "screen.png",
        size: 10,
      })),
      voiceCallEvents: vi.fn(async () => {
        const events = batches.shift() ?? [];
        cursor += events.length;
        return { events, cursor, truncated: false };
      }),
      endVoiceCall: vi.fn(async () => ({ ending: true })),
    };

    let statusState: PushToTalkTurnState | null = null;
    let companionHidden = false;
    const companion = {
      show: vi.fn(),
      setState: vi.fn(),
      setDrawing: vi.fn(),
      setLevel: vi.fn(),
      setCaption: vi.fn(),
      hide: vi.fn(() => {
        companionHidden = true;
      }),
      onStroke: () => () => undefined,
      onCaptionClick: () => () => undefined,
    };

    let press:
      | ((input: { frontmostApp: PushToTalkFrontmostApp | null }) => void)
      | undefined;
    let release: ((input: { cancelled: boolean }) => void) | undefined;
    const hotkey: PushToTalkHotkey = {
      register: vi.fn(async () => ({ inputMonitoring: "granted" as const })),
      requestInputMonitoring: async () => undefined,
      onInputMonitoring: () => () => undefined,
      onPressed: (fn) => {
        press = fn;
        return () => undefined;
      },
      onReleased: (fn) => {
        release = fn;
        return () => undefined;
      },
      onHelperRestarted: () => () => undefined,
    };

    const realVoice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (fn) => fn(),
      host: { open: vi.fn(async () => undefined), close: vi.fn(), publish: vi.fn() },
      clock,
    });

    const controller = new PushToTalkController({
      hotkey,
      voice: realVoice,
      clock,
      companion,
      screenRecording: {
        status: vi.fn(() => "granted"),
        request: vi.fn(async () => undefined),
      },
      screen: {
        locate: () => ({
          displayId: 1,
          cursor: { x: 500, y: 300 },
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 2,
        }),
        capture: vi.fn(async () => captured),
      },
      status: {
        visible: () => true,
        set: vi.fn((state: PushToTalkTurnState | null) => {
          statusState = state;
        }),
        setLevel: vi.fn(),
      },
      powerMonitor: { on: () => undefined, removeListener: () => undefined },
      openSideChat: vi.fn(),
      isCurrentCaller: () => true,
      settings: defaultSettings,
      sessionGeneration: 1,
    });

    controller.start();
    await flush();

    // Prewarmed
    const warmSession = realVoice.voiceSession();
    expect(warmSession.active).toBe(true);
    expect(warmSession.listening).toBe(false);

    // 1. User presses shortcut
    press?.({ frontmostApp: null });
    await flush();
    expect(statusState).toEqual({ kind: "listening" });

    // 2. Gesture held for valid duration
    clock.advance(400);

    // 3. User releases shortcut before getUserMedia completes
    release?.({ cancelled: false });
    await flush();

    // 4. Renderer reports delayed media for context 1 via real voiceReport
    realVoice.voiceReport({
      generation: warmSession.generation,
      event: { kind: "media_delayed", contextId: 1 },
    });
    await flush();

    // Proven: no context is ever sent to backend API, and presentation is cleared
    expect(api.appendVoiceCallContext).not.toHaveBeenCalled();
    expect(statusState).toBeNull();
    expect(companionHidden).toBe(true);

    controller.dispose();
  });
});
