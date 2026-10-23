import { describe, expect, it, vi } from "vitest";
import { MicrophoneDeniedError } from "../modules/audio-capture/microphone";
import {
  errorPillMs,
  maxRecordingMs,
  PushToTalkController,
  type PushToTalkControllerDeps,
  type PushToTalkRecording,
} from "../push-to-talk/controller";
import type {
  PushToTalkCursorLocation,
  PushToTalkScreenCaptureResult,
  PushToTalkScreenContext,
} from "../push-to-talk/screen-capture";
import { PushToTalkTranscriptionError } from "../push-to-talk/transcriber";
import type {
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkOverlay,
  PushToTalkPillState,
  PushToTalkRect,
  PushToTalkSettings,
} from "../push-to-talk/types";
import { FakeClock } from "./support/fake-clock";

const shortcut = {
  key: "space",
  modifiers: { alt: true, control: true, meta: false, shift: false },
} as const;
const settings: PushToTalkSettings = {
  enabled: true,
  shortcut,
  speakReplies: true,
  sendScreen: true,
};
const safari: PushToTalkFrontmostApp = { name: "Safari", bundleId: "com.apple.Safari" };
const target = { conversationId: "cnv_home", groupId: "grp_1", workspaceId: "wsp_1" };
const location: PushToTalkCursorLocation = {
  displayId: 2,
  cursor: { x: 2000, y: 500 },
  bounds: { x: 1440, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

class FakeHotkey implements PushToTalkHotkey {
  pressed = new Set<(event: { frontmostApp: PushToTalkFrontmostApp | null }) => void>();
  released = new Set<(event: { cancelled: boolean }) => void>();
  restarted = new Set<() => void>();
  register = vi.fn(async () => ({ inputMonitoring: "not-needed" as const }));
  requestInputMonitoring = vi.fn(async () => undefined);
  onInputMonitoring() {
    return () => undefined;
  }
  onPressed(
    listener: (event: { frontmostApp: PushToTalkFrontmostApp | null }) => void
  ) {
    this.pressed.add(listener);
    return () => this.pressed.delete(listener);
  }
  onReleased(listener: (event: { cancelled: boolean }) => void) {
    this.released.add(listener);
    return () => this.released.delete(listener);
  }
  onHelperRestarted(listener: () => void) {
    this.restarted.add(listener);
    return () => this.restarted.delete(listener);
  }
  press(frontmostApp: PushToTalkFrontmostApp | null = safari) {
    for (const listener of this.pressed) listener({ frontmostApp });
  }
  release(cancelled = false) {
    for (const listener of this.released) listener({ cancelled });
  }
  restart() {
    for (const listener of this.restarted) listener();
  }
}

class FakeOverlay implements PushToTalkOverlay {
  events: string[] = [];
  states: PushToTalkPillState[] = [];
  shown: Parameters<PushToTalkOverlay["show"]>[0][] = [];
  visible = false;
  regionListeners = new Set<(rect: PushToTalkRect | null) => void>();
  constructor(private readonly log: string[]) {}
  show(input: Parameters<PushToTalkOverlay["show"]>[0]) {
    this.visible = true;
    this.shown.push(input);
    this.states.push(input.state);
    this.log.push(`overlay.show ${input.state.kind}`);
  }
  setState(state: PushToTalkPillState) {
    this.states.push(state);
    this.log.push(`overlay.state ${state.kind}`);
  }
  hide() {
    this.visible = false;
    this.log.push("overlay.hide");
  }
  onRegion(listener: (rect: PushToTalkRect | null) => void) {
    this.regionListeners.add(listener);
    return () => this.regionListeners.delete(listener);
  }
  mark(rect: PushToTalkRect | null) {
    for (const listener of this.regionListeners) listener(rect);
  }
  last() {
    return this.states.at(-1);
  }
}

class FakePowerMonitor {
  listeners = new Map<string, Set<() => void>>();
  on(event: "lock-screen" | "suspend", listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  removeListener(event: "lock-screen" | "suspend", listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: "lock-screen" | "suspend") {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

const screenshot: PushToTalkScreenContext = {
  width: 2560,
  height: 1655,
  cursor: { x: 830, y: 741 },
  images: [
    { name: "screen.png", mediaType: "image/png", data: Buffer.from("screen") },
    { name: "detail.png", mediaType: "image/png", data: Buffer.from("detail") },
  ],
};

function setup(
  options: {
    settings?: Partial<PushToTalkSettings>;
    capture?: () => Promise<PushToTalkScreenCaptureResult>;
    microphone?: () => Promise<PushToTalkRecording>;
    transcript?: () => Promise<{ text: string }>;
    ready?: boolean;
    send?: () => Promise<typeof target>;
  } = {}
) {
  const log: string[] = [];
  const clock = new FakeClock();
  const hotkey = new FakeHotkey();
  const overlay = new FakeOverlay(log);
  const powerMonitor = new FakePowerMonitor();
  const finalize = vi.fn((region: PushToTalkRect | null) => ({
    ...screenshot,
    ...(region ? { region } : {}),
  }));
  const recordings: { stop: ReturnType<typeof vi.fn> }[] = [];
  let wavCount = 0;
  const startMicrophone =
    options.microphone ??
    (async () => {
      const path = `/tmp/ptt-${++wavCount}.wav`;
      const recording = {
        stop: vi.fn(async () => {
          log.push(`mic.stop ${path}`);
          return path;
        }),
      };
      recordings.push(recording);
      return recording;
    });
  const replies = { arm: vi.fn(), cancel: vi.fn() };
  const deps = {
    hotkey,
    overlay,
    clock,
    powerMonitor,
    microphone: {
      start: vi.fn(() => {
        log.push("mic.start");
        return startMicrophone();
      }),
    },
    screen: {
      locate: vi.fn(() => location),
      capture: vi.fn(() => {
        log.push("screen.capture");
        return (
          options.capture?.() ??
          Promise.resolve({ status: "captured" as const, finalize })
        );
      }),
    },
    transcriber: {
      ready: vi.fn(async () => options.ready ?? true),
      transcribe: vi.fn((path: string) => {
        log.push(`transcribe ${path}`);
        return options.transcript?.() ?? Promise.resolve({ text: "What is this?" });
      }),
    },
    delivery: {
      send: vi.fn(() => {
        log.push("delivery.send");
        return options.send?.() ?? Promise.resolve(target);
      }),
    },
    speaker: {
      speak: vi.fn(),
      stop: vi.fn(() => void log.push("speaker.stop")),
    },
    replies,
    removeFile: vi.fn(async (path: string) => void log.push(`rm ${path}`)),
    settings: { ...settings, ...options.settings },
    log: () => undefined,
  } satisfies PushToTalkControllerDeps;
  const controller = new PushToTalkController(deps);
  controller.start();
  /** Presses, waits for the turn to start, holds for `ms` and releases. */
  const hold = async (ms: number, app: PushToTalkFrontmostApp | null = safari) => {
    hotkey.press(app);
    await flush();
    clock.advance(ms);
    hotkey.release();
    await flush();
  };
  return {
    controller,
    deps,
    hotkey,
    overlay,
    clock,
    powerMonitor,
    log,
    finalize,
    hold,
  };
}

describe("PushToTalkController", () => {
  // Padrão desligado
  it("registers nothing and ignores the shortcut while the feature is off", async () => {
    const { deps, hotkey, overlay } = setup({ settings: { enabled: false } });
    await flush();
    expect(hotkey.register).toHaveBeenCalledWith(null);
    hotkey.press();
    await flush();
    expect(deps.microphone.start).not.toHaveBeenCalled();
    expect(deps.screen.capture).not.toHaveBeenCalled();
    expect(overlay.shown).toEqual([]);
  });

  // Trocar o atalho
  it("registers the chosen shortcut and replaces it when the settings change", async () => {
    const { controller, hotkey } = setup();
    expect(hotkey.register).toHaveBeenLastCalledWith(shortcut);
    const other = {
      key: "d",
      modifiers: { alt: false, control: false, meta: true, shift: true },
    } as const;
    controller.update({ ...settings, shortcut: other });
    expect(hotkey.register).toHaveBeenLastCalledWith(other);
    controller.update({ ...settings, enabled: false });
    expect(hotkey.register).toHaveBeenLastCalledWith(null);
  });

  // Janela principal fechada / Ciclo normal / Interromper a leitura
  it("stops speech, captures and starts the mic in parallel, then shows Listening", async () => {
    const capture = deferred<PushToTalkScreenCaptureResult>();
    const { hotkey, overlay, log, finalize } = setup({
      capture: () => capture.promise,
    });
    hotkey.press();
    await flush();
    expect(log).toEqual(["speaker.stop", "screen.capture", "mic.start"]);
    // The pill never appears before the screenshot is taken.
    expect(overlay.shown).toEqual([]);
    capture.resolve({ status: "captured", finalize });
    await flush();
    expect(overlay.shown).toEqual([
      { displayId: 2, cursor: { x: 2000, y: 500 }, state: { kind: "listening" } },
    ]);
  });

  // Segurar e soltar / Ciclo normal / Pergunta com print / Apontar sem arrastar
  it("records the hold, transcribes, sends text, context and both images, then hides", async () => {
    const { deps, overlay, log, finalize, hold } = setup();
    await hold(4_000);
    expect(log).toEqual([
      "speaker.stop",
      "screen.capture",
      "mic.start",
      "overlay.show listening",
      "mic.stop /tmp/ptt-1.wav",
      "overlay.state transcribing",
      "transcribe /tmp/ptt-1.wav",
      "rm /tmp/ptt-1.wav",
      "delivery.send",
      "overlay.hide",
    ]);
    expect(finalize).toHaveBeenCalledWith(null);
    const sent = deps.delivery.send.mock.calls[0] as unknown as [
      { text: string; attachments: { name: string }[] },
    ];
    expect(sent[0].text).toContain("What is this?");
    expect(sent[0].text).toContain("- Frontmost app: Safari");
    expect(sent[0].text).toContain("- Cursor: (830, 741) px");
    expect(sent[0].attachments.map((image) => image.name)).toEqual([
      "screen.png",
      "detail.png",
    ]);
    expect(overlay.visible).toBe(false);
  });

  // Tela muda depois do aperto
  it("takes the screenshot at the press, never at the release", async () => {
    const { deps, hotkey } = setup();
    hotkey.press();
    await flush();
    expect(deps.screen.capture).toHaveBeenCalledOnce();
    hotkey.release();
    await flush();
    expect(deps.screen.capture).toHaveBeenCalledOnce();
  });

  // Vários monitores
  it("shows the overlay on the display the cursor was on", async () => {
    const { overlay, hotkey } = setup();
    hotkey.press();
    await flush();
    expect(overlay.shown[0]?.displayId).toBe(2);
  });

  // Marcar uma área
  it("sends the latest marked area, a new one replacing the previous", async () => {
    const { deps, overlay, hotkey, finalize, clock } = setup();
    hotkey.press();
    await flush();
    overlay.mark({ x: 1, y: 2, width: 3, height: 4 });
    overlay.mark({ x: 10, y: 20, width: 300, height: 400 });
    clock.advance(2_000);
    hotkey.release();
    await flush();
    expect(finalize).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 400 });
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [{ text: string }];
    expect(input.text).toContain("- Marked area: 10, 20, 300 × 400 px");
  });

  // Toque acidental
  it("discards a 0.2 s tap without transcribing or sending", async () => {
    const { deps, overlay, log, hold } = setup();
    await hold(200);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(overlay.visible).toBe(false);
  });

  // Outro atalho com os mesmos modificadores
  it("drops a turn whose modifier-only chord was joined by another key, silently", async () => {
    const { deps, hotkey, overlay, clock, log } = setup();
    hotkey.press();
    await flush();
    expect(overlay.shown).toHaveLength(1);
    clock.advance(1_500);
    hotkey.release(true);
    await flush();
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(overlay.visible).toBe(false);
    expect(overlay.states.filter((state) => state.kind === "error")).toEqual([]);
    // The next hold is a normal turn.
    hotkey.press();
    await flush();
    clock.advance(1_000);
    hotkey.release();
    await flush();
    expect(deps.delivery.send).toHaveBeenCalledOnce();
  });

  it("drops a turn cancelled before the microphone is ready", async () => {
    const mic = deferred<PushToTalkRecording>();
    const stop = vi.fn(async () => "/tmp/early.wav");
    const { deps, hotkey, overlay, clock } = setup({ microphone: () => mic.promise });
    hotkey.press();
    await flush();
    clock.advance(1_000);
    hotkey.release(true);
    mic.resolve({ stop });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/early.wav");
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(overlay.visible).toBe(false);
  });

  it("handles a release that arrives before the microphone is ready", async () => {
    const mic = deferred<PushToTalkRecording>();
    const stop = vi.fn(async () => "/tmp/early.wav");
    const { deps, hotkey, overlay } = setup({ microphone: () => mic.promise });
    hotkey.press();
    await flush();
    hotkey.release();
    mic.resolve({ stop });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/early.wav");
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(overlay.visible).toBe(false);
  });

  // Limite de duração
  it("stops the recording at 120 s and continues to transcription", async () => {
    const { deps, hotkey, clock } = setup();
    hotkey.press();
    await flush();
    clock.advance(maxRecordingMs);
    await flush();
    expect(deps.transcriber.transcribe).toHaveBeenCalledWith("/tmp/ptt-1.wav");
    expect(deps.delivery.send).toHaveBeenCalledOnce();
    hotkey.release();
    await flush();
    expect(deps.delivery.send).toHaveBeenCalledOnce();
  });

  // Aperto durante a transcrição
  it("ignores a press while the previous turn transcribes and shows busy", async () => {
    const transcript = deferred<{ text: string }>();
    const { deps, hotkey, overlay, hold } = setup({
      transcript: () => transcript.promise,
    });
    await hold(1_000);
    hotkey.press();
    await flush();
    expect(deps.microphone.start).toHaveBeenCalledOnce();
    expect(overlay.last()).toEqual({ kind: "busy" });
    transcript.resolve({ text: "First" });
    await flush();
    expect(deps.delivery.send).toHaveBeenCalledOnce();
  });

  // Mac bloqueado durante a gravação (and suspend, helper restart)
  it.each(["lock-screen", "suspend", "helper-restart"] as const)(
    "cancels the recording on %s and starts fresh on the next press",
    async (interruption) => {
      const { deps, hotkey, overlay, powerMonitor, log } = setup();
      hotkey.press();
      await flush();
      if (interruption === "helper-restart") hotkey.restart();
      else powerMonitor.emit(interruption);
      await flush();
      expect(log).toContain("rm /tmp/ptt-1.wav");
      expect(overlay.visible).toBe(false);
      hotkey.release();
      await flush();
      expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
      expect(deps.delivery.send).not.toHaveBeenCalled();

      hotkey.press();
      await flush();
      expect(deps.microphone.start).toHaveBeenCalledTimes(2);
      expect(overlay.last()).toEqual({ kind: "listening" });
    }
  );

  it("stops a microphone that becomes ready after the turn was cancelled", async () => {
    const mic = deferred<PushToTalkRecording>();
    const stop = vi.fn(async () => "/tmp/late.wav");
    const { deps, hotkey, powerMonitor } = setup({ microphone: () => mic.promise });
    hotkey.press();
    await flush();
    powerMonitor.emit("lock-screen");
    mic.resolve({ stop });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/late.wav");
  });

  // Microfone negado
  it("shows the microphone permission error and sends nothing when macOS denies it", async () => {
    const { deps, overlay, hold } = setup({
      microphone: () => Promise.reject(new MicrophoneDeniedError()),
    });
    await hold(1_000);
    expect(overlay.last()).toEqual({ kind: "error", code: "microphone_denied" });
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
  });

  // Permissão negada
  it("sends without the screenshot and warns when Screen Recording is denied", async () => {
    const { deps, overlay, hold, clock } = setup({
      capture: async () => ({ status: "denied" }),
    });
    await hold(1_000);
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [
      { text: string; attachments: unknown[] },
    ];
    expect(input.attachments).toEqual([]);
    expect(input.text).toContain("- No screenshot was included.");
    expect(input.text).toContain("- Cursor: (560, 500) pt on a 1728 × 1117 pt display");
    expect(overlay.last()).toEqual({ kind: "error", code: "screen_denied" });
    clock.advance(errorPillMs);
    expect(overlay.visible).toBe(false);
  });

  // Print desligado
  it("captures nothing with the screenshot off and sends the text with the app", async () => {
    const { deps, overlay, hold } = setup({ settings: { sendScreen: false } });
    await hold(1_000);
    expect(deps.screen.capture).not.toHaveBeenCalled();
    expect(overlay.shown[0]?.state).toEqual({ kind: "listening" });
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [
      { text: string; attachments: unknown[] },
    ];
    expect(input.attachments).toEqual([]);
    expect(input.text).toContain("- Frontmost app: Safari");
    expect(input.text).not.toContain("Cursor");
    expect(overlay.visible).toBe(false);
  });

  // Transcrição indisponível
  it("reports unavailable transcription at the press without recording", async () => {
    const { deps, overlay, hold } = setup({ ready: false });
    await hold(1_000);
    expect(deps.microphone.start).not.toHaveBeenCalled();
    expect(overlay.shown.at(-1)?.state).toEqual({
      kind: "error",
      code: "transcription_unavailable",
    });
    expect(deps.delivery.send).not.toHaveBeenCalled();
  });

  // Silêncio
  it("shows nothing_heard for an empty transcript, sends nothing and deletes the WAV", async () => {
    const { deps, overlay, log, hold } = setup({
      transcript: async () => ({ text: "  " }),
    });
    await hold(1_000);
    expect(overlay.last()).toEqual({ kind: "error", code: "nothing_heard" });
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
  });

  it.each([
    "transcription_busy",
    "transcription_unavailable",
    "transcription_failed",
  ] as const)("shows %s and still deletes the WAV", async (code) => {
    const { deps, overlay, log, hold } = setup({
      transcript: () => Promise.reject(new PushToTalkTranscriptionError(code)),
    });
    await hold(1_000);
    expect(overlay.last()).toEqual({ kind: "error", code });
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(deps.delivery.send).not.toHaveBeenCalled();
  });

  // Falha de envio
  it("shows send_failed with the transcript to copy", async () => {
    const { overlay, hold } = setup({ send: () => Promise.reject(new Error("413")) });
    await hold(1_000);
    expect(overlay.last()).toEqual({
      kind: "error",
      code: "send_failed",
      transcript: "What is this?",
    });
  });

  // Leitura da resposta / Interromper a leitura
  it("speaks the reply to the sent turn and stops it on the next press", async () => {
    const { deps, hotkey, hold } = setup();
    await hold(1_000);
    expect(deps.replies.arm).toHaveBeenCalledWith(target, expect.any(Function));
    const onReply = deps.replies.arm.mock.calls[0]![1] as (text: string) => void;
    onReply("**Done.** See [the doc](https://x.test).");
    expect(deps.speaker.speak).toHaveBeenCalledWith("Done. See the doc.");

    deps.speaker.stop.mockClear();
    hotkey.press();
    await flush();
    expect(deps.speaker.stop).toHaveBeenCalledOnce();
    expect(deps.replies.cancel).toHaveBeenCalled();
  });

  it("does not wait for a reply with spoken replies off", async () => {
    const { deps, hold } = setup({ settings: { speakReplies: false } });
    await hold(1_000);
    expect(deps.delivery.send).toHaveBeenCalledOnce();
    expect(deps.replies.arm).not.toHaveBeenCalled();
  });

  // Fora de um turno
  it("leaves nothing on screen after an error pill times out", async () => {
    const { overlay, hold, clock } = setup({ transcript: async () => ({ text: "" }) });
    await hold(1_000);
    expect(overlay.visible).toBe(true);
    clock.advance(errorPillMs);
    expect(overlay.visible).toBe(false);
  });
});
