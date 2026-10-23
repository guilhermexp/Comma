import { describe, expect, it, vi } from "vitest";
import type { CommaConversation } from "@comma/app/api";
import type { ChatMessage, ChatTarget } from "@comma/chat-contract";
import { MicrophoneDeniedError } from "../modules/audio-capture/microphone";
import {
  busyVisibleMs,
  errorVisibleMs,
  maxRecordingMs,
  PushToTalkController,
  type PushToTalkControllerDeps,
  type PushToTalkRecording,
} from "../push-to-talk/controller";
import { PushToTalkReplyWatcher, replyWaitMs } from "../push-to-talk/reply-watcher";
import type {
  PushToTalkCursorLocation,
  PushToTalkScreenCaptureResult,
  PushToTalkScreenContext,
} from "../push-to-talk/screen-capture";
import { PushToTalkTranscriptionError } from "../push-to-talk/transcriber";
import type {
  PushToTalkCompanion,
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkSettings,
  PushToTalkStatus,
  PushToTalkStroke,
  PushToTalkTurnState,
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

function describeState(state: PushToTalkTurnState | null) {
  if (state === null) return "null";
  return state.kind === "error" ? `error ${state.code}` : state.kind;
}

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

class FakeCompanion implements PushToTalkCompanion {
  states: PushToTalkTurnState[] = [];
  shown: Parameters<PushToTalkCompanion["show"]>[0][] = [];
  captions: (string | null)[] = [];
  levels: number[] = [];
  visible = false;
  caption: string | null = null;
  strokeListeners = new Set<(stroke: PushToTalkStroke | null) => void>();
  captionListeners = new Set<() => void>();
  constructor(private readonly log: string[]) {}
  show(input: Parameters<PushToTalkCompanion["show"]>[0]) {
    this.visible = true;
    this.caption = null;
    this.shown.push(input);
    this.states.push(input.state);
    this.log.push(`companion.show ${describeState(input.state)}`);
  }
  setState(state: PushToTalkTurnState) {
    this.states.push(state);
    this.log.push(`companion.state ${describeState(state)}`);
  }
  setLevel(level: number) {
    this.levels.push(level);
  }
  setCaption(text: string | null) {
    this.caption = text;
    this.captions.push(text);
    this.log.push(`companion.caption ${text}`);
  }
  hide() {
    this.visible = false;
    this.caption = null;
    this.log.push("companion.hide");
  }
  onStroke(listener: (stroke: PushToTalkStroke | null) => void) {
    this.strokeListeners.add(listener);
    return () => this.strokeListeners.delete(listener);
  }
  onCaptionClick(listener: () => void) {
    this.captionListeners.add(listener);
    return () => this.captionListeners.delete(listener);
  }
  draw(stroke: PushToTalkStroke | null) {
    for (const listener of this.strokeListeners) listener(stroke);
  }
  clickCaption() {
    for (const listener of this.captionListeners) listener();
  }
  last() {
    return this.states.at(-1);
  }
}

class FakeStatus implements PushToTalkStatus {
  states: (PushToTalkTurnState | null)[] = [];
  levels: number[] = [];
  constructor(
    private readonly log: string[],
    public shownInNotch: boolean
  ) {}
  visible() {
    return this.shownInNotch;
  }
  set(state: PushToTalkTurnState | null) {
    // Repeated clears are no-ops for the notch; keep the sequence readable.
    if (state === null && this.states.at(-1) === null) return;
    this.states.push(state);
    this.log.push(`notch ${describeState(state)}`);
  }
  setLevel(level: number) {
    this.levels.push(level);
  }
  last() {
    return this.states.at(-1);
  }
}

class FakeSpeaker {
  spoken: string[] = [];
  #current: { text: string; done: () => void } | undefined;
  constructor(private readonly log: string[]) {}
  speak = vi.fn((text: string) => {
    this.spoken.push(text);
    this.log.push(`say ${text}`);
    const { promise, resolve } = deferred<void>();
    this.#current = { text, done: () => resolve() };
    return promise;
  });
  stop = vi.fn(() => {
    this.log.push("speaker.stop");
    const current = this.#current;
    this.#current = undefined;
    current?.done();
  });
  /** The running sentence ends by itself. */
  finish() {
    const current = this.#current;
    this.#current = undefined;
    current?.done();
  }
  speaking() {
    return this.#current?.text;
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

/** The stroke's box as the capture reports it, at 1 px per point. */
function strokeBox(stroke: PushToTalkStroke) {
  const xs = stroke.map((point) => point.x);
  const ys = stroke.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const conversation = {
  id: "cnv_home",
  kind: "user_chat",
  messages: [],
  status: "active",
  title: "Home",
  group_id: "grp_1",
} as CommaConversation;

function agentMessage(text: string) {
  return {
    attachments: [],
    delivery: "sent",
    messageId: `msg_${text.length}`,
    refs: [],
    role: "assistant",
    source: "server",
    text,
  } as unknown as ChatMessage;
}

function setup(
  options: {
    settings?: Partial<PushToTalkSettings>;
    notchVisible?: boolean;
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
  const companion = new FakeCompanion(log);
  const status = new FakeStatus(log, options.notchVisible ?? true);
  const speaker = new FakeSpeaker(log);
  const powerMonitor = new FakePowerMonitor();
  const replies = new PushToTalkReplyWatcher({ clock });
  const finalize = vi.fn((stroke: PushToTalkStroke | null) => ({
    ...screenshot,
    ...(stroke?.length ? { strokeBounds: strokeBox(stroke) } : {}),
  }));
  let onLevel: ((level: number) => void) | undefined;
  let wavCount = 0;
  const startMicrophone =
    options.microphone ??
    (async () => {
      const path = `/tmp/ptt-${++wavCount}.wav`;
      return {
        stop: vi.fn(async () => {
          log.push(`mic.stop ${path}`);
          return path;
        }),
      };
    });
  const deps = {
    hotkey,
    companion,
    status,
    clock,
    powerMonitor,
    microphone: {
      start: vi.fn((input: { onLevel: (level: number) => void }) => {
        log.push("mic.start");
        onLevel = input.onLevel;
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
    speaker,
    replies,
    openSideChat: vi.fn(() => void log.push("sideChat.open")),
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
  /** The agent's reply lands in `to` (the turn's conversation by default). */
  const reply = async (text: string, to: ChatTarget = target) => {
    replies.handleAppended({
      conversation: { ...conversation, id: to.conversationId },
      messages: [agentMessage(text)],
      target: to,
    });
    await flush();
  };
  /** The running sentence ends; waits for the next one to start. */
  const finishSentence = async () => {
    speaker.finish();
    await flush();
  };
  return {
    controller,
    deps,
    hotkey,
    companion,
    status,
    speaker,
    clock,
    powerMonitor,
    log,
    finalize,
    hold,
    reply,
    finishSentence,
    level: (value: number) => onLevel?.(value),
  };
}

describe("PushToTalkController", () => {
  // Padrão desligado
  it("registers nothing and ignores the shortcut while the feature is off", async () => {
    const { deps, hotkey, companion, status } = setup({ settings: { enabled: false } });
    await flush();
    expect(hotkey.register).toHaveBeenCalledWith(null);
    hotkey.press();
    await flush();
    expect(deps.microphone.start).not.toHaveBeenCalled();
    expect(deps.screen.capture).not.toHaveBeenCalled();
    expect(companion.shown).toEqual([]);
    expect(status.states).toEqual([]);
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

  // Janela principal fechada
  it("captures while the mic starts, then shows Listening in the notch and the companion", async () => {
    const capture = deferred<PushToTalkScreenCaptureResult>();
    const { hotkey, companion, status, log, finalize } = setup({
      capture: () => capture.promise,
    });
    hotkey.press();
    await flush();
    expect(log).toEqual(["speaker.stop", "screen.capture", "mic.start"]);
    // Nothing of the turn appears before the screenshot is taken.
    expect(companion.shown).toEqual([]);
    expect(status.states).toEqual([]);
    capture.resolve({ status: "captured", finalize });
    await flush();
    expect(companion.shown).toEqual([
      { displayId: 2, cursor: { x: 2000, y: 500 }, state: { kind: "listening" } },
    ]);
    expect(status.last()).toEqual({ kind: "listening" });
  });

  // Estados em sequência / Ciclo normal / Pergunta com print / Apontar sem desenhar
  it("walks listening → transcribing → thinking → speaking on the notch and the companion, then hides", async () => {
    const { deps, companion, status, hold, reply, finishSentence, clock } = setup();
    await hold(4_000);
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
    // Waiting for the agent: the companion stays with its wait indicator.
    expect(companion.visible).toBe(true);
    expect(status.last()).toEqual({ kind: "thinking" });

    await reply("Done.");
    await finishSentence();
    clock.advance(10_000);
    expect(status.states.map(describeState)).toEqual([
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "null",
    ]);
    expect(companion.states.map(describeState)).toEqual([
      "listening",
      "transcribing",
      "thinking",
      "speaking",
    ]);
    expect(companion.visible).toBe(false);
  });

  it("passes the microphone level to the notch and the companion", async () => {
    const { hotkey, companion, status, level } = setup();
    hotkey.press();
    await flush();
    level(0.4);
    level(0.7);
    expect(status.levels).toEqual([0.4, 0.7]);
    expect(companion.levels).toEqual([0.4, 0.7]);
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
  it("shows the companion on the display the cursor was on", async () => {
    const { companion, hotkey } = setup();
    hotkey.press();
    await flush();
    expect(companion.shown[0]?.displayId).toBe(2);
  });

  // Circular um gráfico
  it("draws the latest freehand stroke on the screenshot, a new one replacing the previous", async () => {
    const { deps, companion, hotkey, finalize, clock } = setup();
    hotkey.press();
    await flush();
    companion.draw([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const circle = [
      { x: 10, y: 20 },
      { x: 310, y: 40 },
      { x: 200, y: 420 },
      { x: 12, y: 25 },
    ];
    companion.draw(circle);
    clock.advance(2_000);
    hotkey.release();
    await flush();
    expect(finalize).toHaveBeenCalledWith(circle);
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [{ text: string }];
    expect(input.text).toContain("- Stroke area: 10, 20, 300 × 400 px");
  });

  // Apontar sem desenhar
  it("finalizes without a stroke when nothing was drawn", async () => {
    const { finalize, hold } = setup();
    await hold(1_000);
    expect(finalize).toHaveBeenCalledWith(null);
  });

  // Nada abre
  it("opens no window when the question is sent", async () => {
    const { deps, hold, reply, finishSentence } = setup();
    await hold(1_000);
    expect(deps.delivery.send).toHaveBeenCalledOnce();
    await reply("Done.");
    await finishSentence();
    expect(deps.openSideChat).not.toHaveBeenCalled();
  });

  // Abrir a conversa pelo balão
  it("opens Side Chat when the caption balloon is clicked", async () => {
    const { deps, companion, hold, reply } = setup();
    await hold(1_000);
    await reply("Here it is.");
    expect(companion.caption).toBe("Here it is.");
    companion.clickCaption();
    expect(deps.openSideChat).toHaveBeenCalledOnce();
  });

  // Toque acidental
  it("discards a 0.2 s tap without transcribing or sending", async () => {
    const { deps, companion, status, log, hold } = setup();
    await hold(200);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(companion.visible).toBe(false);
    expect(status.last()).toBeNull();
  });

  // Outro atalho com os mesmos modificadores
  it("drops a turn whose modifier-only chord was joined by another key, silently", async () => {
    const { deps, hotkey, companion, status, clock, log } = setup();
    hotkey.press();
    await flush();
    expect(companion.shown).toHaveLength(1);
    clock.advance(1_500);
    hotkey.release(true);
    await flush();
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(companion.visible).toBe(false);
    expect(status.states.map(describeState)).toEqual(["listening", "null"]);
    expect(companion.states.filter((state) => state.kind === "error")).toEqual([]);
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
    const { deps, hotkey, companion, clock } = setup({
      microphone: () => mic.promise,
    });
    hotkey.press();
    await flush();
    clock.advance(1_000);
    hotkey.release(true);
    mic.resolve({ stop });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/early.wav");
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(companion.visible).toBe(false);
  });

  it("handles a release that arrives before the microphone is ready", async () => {
    const mic = deferred<PushToTalkRecording>();
    const stop = vi.fn(async () => "/tmp/early.wav");
    const { deps, hotkey, companion } = setup({ microphone: () => mic.promise });
    hotkey.press();
    await flush();
    hotkey.release();
    mic.resolve({ stop });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith("/tmp/early.wav");
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(companion.visible).toBe(false);
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
  it("ignores a press while the previous turn transcribes and asks to wait in the notch", async () => {
    const transcript = deferred<{ text: string }>();
    const { deps, hotkey, status, clock, hold } = setup({
      transcript: () => transcript.promise,
    });
    await hold(1_000);
    hotkey.press();
    await flush();
    expect(deps.microphone.start).toHaveBeenCalledOnce();
    expect(status.last()).toEqual({ kind: "busy" });
    clock.advance(busyVisibleMs);
    expect(status.last()).toEqual({ kind: "transcribing" });
    transcript.resolve({ text: "First" });
    await flush();
    expect(deps.delivery.send).toHaveBeenCalledOnce();
  });

  // Mac bloqueado durante a gravação (and suspend, helper restart)
  it.each(["lock-screen", "suspend", "helper-restart"] as const)(
    "cancels the recording on %s and starts fresh on the next press",
    async (interruption) => {
      const { deps, hotkey, companion, status, powerMonitor, log } = setup();
      hotkey.press();
      await flush();
      if (interruption === "helper-restart") hotkey.restart();
      else powerMonitor.emit(interruption);
      await flush();
      expect(log).toContain("rm /tmp/ptt-1.wav");
      expect(companion.visible).toBe(false);
      expect(status.last()).toBeNull();
      hotkey.release();
      await flush();
      expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
      expect(deps.delivery.send).not.toHaveBeenCalled();

      hotkey.press();
      await flush();
      expect(deps.microphone.start).toHaveBeenCalledTimes(2);
      expect(companion.last()).toEqual({ kind: "listening" });
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
  it("shows the microphone permission error in the notch and sends nothing", async () => {
    const { deps, companion, status, hold } = setup({
      microphone: () => Promise.reject(new MicrophoneDeniedError()),
    });
    await hold(1_000);
    expect(status.last()).toEqual({ kind: "error", code: "microphone_denied" });
    expect(companion.visible).toBe(false);
    expect(deps.transcriber.transcribe).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
  });

  // Permissão negada
  it("sends without the screenshot, warns, then waits for the reply", async () => {
    const { deps, status, hold, clock } = setup({
      capture: async () => ({ status: "denied" }),
    });
    await hold(1_000);
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [
      { text: string; attachments: unknown[] },
    ];
    expect(input.attachments).toEqual([]);
    expect(input.text).toContain("- No screenshot was included.");
    expect(input.text).toContain("- Cursor: (560, 500) pt on a 1728 × 1117 pt display");
    expect(status.last()).toEqual({ kind: "error", code: "screen_denied" });
    clock.advance(errorVisibleMs);
    expect(status.last()).toEqual({ kind: "thinking" });
  });

  // Print desligado
  it("captures nothing with the screenshot off and sends the text with the app", async () => {
    const { deps, companion, hold } = setup({ settings: { sendScreen: false } });
    await hold(1_000);
    expect(deps.screen.capture).not.toHaveBeenCalled();
    expect(companion.shown[0]?.state).toEqual({ kind: "listening" });
    const [input] = deps.delivery.send.mock.calls[0] as unknown as [
      { text: string; attachments: unknown[] },
    ];
    expect(input.attachments).toEqual([]);
    expect(input.text).toContain("- Frontmost app: Safari");
    expect(input.text).not.toContain("Cursor");
  });

  // Transcrição indisponível
  it("reports unavailable transcription in the notch at the press without recording", async () => {
    const { deps, companion, status, hold, clock } = setup({ ready: false });
    await hold(1_000);
    expect(deps.microphone.start).not.toHaveBeenCalled();
    expect(status.last()).toEqual({ kind: "error", code: "transcription_unavailable" });
    expect(companion.shown).toEqual([]);
    expect(deps.delivery.send).not.toHaveBeenCalled();
    clock.advance(errorVisibleMs);
    expect(status.last()).toBeNull();
  });

  // Notch desligado
  it("shows the error next to the cursor companion when the notch is off", async () => {
    const { companion, status, hold, clock } = setup({
      ready: false,
      notchVisible: false,
    });
    await hold(1_000);
    expect(companion.shown.at(-1)?.state).toEqual({
      kind: "error",
      code: "transcription_unavailable",
    });
    expect(status.states.filter((state) => state?.kind === "error")).toEqual([]);
    clock.advance(errorVisibleMs);
    expect(companion.visible).toBe(false);
  });

  it("moves a mid-turn error to the companion when the notch is off", async () => {
    const { companion, status, hold } = setup({
      notchVisible: false,
      transcript: async () => ({ text: "" }),
    });
    await hold(1_000);
    expect(companion.last()).toEqual({ kind: "error", code: "nothing_heard" });
    expect(companion.visible).toBe(true);
    expect(status.states.filter((state) => state?.kind === "error")).toEqual([]);
  });

  // Silêncio
  it("shows nothing_heard for an empty transcript, sends nothing and deletes the WAV", async () => {
    const { deps, companion, status, log, hold } = setup({
      transcript: async () => ({ text: "  " }),
    });
    await hold(1_000);
    expect(status.last()).toEqual({ kind: "error", code: "nothing_heard" });
    expect(companion.visible).toBe(false);
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(log).toContain("rm /tmp/ptt-1.wav");
  });

  it.each([
    "transcription_busy",
    "transcription_unavailable",
    "transcription_failed",
  ] as const)("shows %s and still deletes the WAV", async (code) => {
    const { deps, status, log, hold } = setup({
      transcript: () => Promise.reject(new PushToTalkTranscriptionError(code)),
    });
    await hold(1_000);
    expect(status.last()).toEqual({ kind: "error", code });
    expect(log).toContain("rm /tmp/ptt-1.wav");
    expect(deps.delivery.send).not.toHaveBeenCalled();
  });

  // Falha de envio
  it("shows send_failed with the transcript to copy", async () => {
    const { status, hold } = setup({ send: () => Promise.reject(new Error("413")) });
    await hold(1_000);
    expect(status.last()).toEqual({
      kind: "error",
      code: "send_failed",
      transcript: "What is this?",
    });
  });

  // Leitura da resposta
  it("speaks the reply sentence by sentence, each one on the caption once", async () => {
    const { speaker, companion, status, hold, reply, finishSentence } = setup();
    await hold(1_000);
    await reply("**Done.** See [the doc](https://x.test). Anything else?");
    expect(status.last()).toEqual({ kind: "speaking" });
    expect(speaker.speaking()).toBe("Done.");
    expect(companion.caption).toBe("Done.");
    await finishSentence();
    expect(speaker.speaking()).toBe("See the doc.");
    expect(companion.caption).toBe("See the doc.");
    await finishSentence();
    expect(companion.caption).toBe("Anything else?");
    await finishSentence();
    expect(speaker.spoken).toEqual(["Done.", "See the doc.", "Anything else?"]);
    expect(companion.captions.filter(Boolean)).toEqual([
      "Done.",
      "See the doc.",
      "Anything else?",
    ]);
  });

  // Interromper a leitura
  it("stops the voice, clears the caption and drops pending sentences on the next press", async () => {
    const { deps, speaker, companion, status, hotkey, hold, reply, finishSentence } =
      setup();
    await hold(1_000);
    await reply("First sentence. Second sentence.");
    expect(speaker.speaking()).toBe("First sentence.");

    hotkey.press();
    expect(speaker.stop).toHaveBeenCalled();
    expect(companion.caption).toBeNull();
    await flush();
    await finishSentence();
    expect(speaker.spoken).toEqual(["First sentence."]);
    expect(status.last()).toEqual({ kind: "listening" });
    expect(companion.last()).toEqual({ kind: "listening" });
    expect(deps.microphone.start).toHaveBeenCalledTimes(2);
  });

  // Voz desligada
  it.each([
    ["a short reply for 4 s", "All set now.", 4_000],
    [
      "30 words for 9 s",
      Array.from({ length: 30 }, (_, index) => `w${index}`).join(" "),
      9_000,
    ],
    [
      "a long reply for 20 s",
      Array.from({ length: 200 }, (_, index) => `w${index}`).join(" "),
      20_000,
    ],
  ])(
    "shows %s on the caption without a voice when spoken replies are off",
    async (_name, text, ms) => {
      const { speaker, companion, status, hold, reply, clock } = setup({
        settings: { speakReplies: false },
      });
      await hold(1_000);
      await reply(text);
      expect(speaker.speak).not.toHaveBeenCalled();
      expect(companion.caption).toBe(text);
      expect(status.last()).toEqual({ kind: "speaking" });
      clock.advance(ms - 1);
      expect(companion.visible).toBe(true);
      clock.advance(1);
      expect(companion.visible).toBe(false);
      expect(status.last()).toBeNull();
    }
  );

  // Agente demora
  it("hides silently when no reply comes in 180 s and ignores a later one", async () => {
    const { speaker, companion, status, hold, reply, clock } = setup();
    await hold(1_000);
    expect(status.last()).toEqual({ kind: "thinking" });
    clock.advance(replyWaitMs);
    expect(companion.visible).toBe(false);
    expect(status.last()).toBeNull();
    await reply("Too late.");
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(companion.captions).toEqual([]);
  });

  // Mensagem digitada
  it("ignores agent replies in another conversation", async () => {
    const { speaker, companion, hold, reply } = setup();
    await hold(1_000);
    await reply("Other chat.", { ...target, conversationId: "cnv_other" });
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(companion.captions).toEqual([]);
  });

  // Fora de um turno
  it("leaves nothing on screen after an error times out", async () => {
    const { companion, status, hold, clock } = setup({
      notchVisible: false,
      transcript: async () => ({ text: "" }),
    });
    await hold(1_000);
    expect(companion.visible).toBe(true);
    clock.advance(errorVisibleMs);
    expect(companion.visible).toBe(false);
    expect(status.last()).toBeNull();
  });
});
