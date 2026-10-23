import type { ChatTarget } from "@comma/chat-contract";
import { MicrophoneDeniedError } from "../modules/audio-capture/microphone";
import type { PushToTalkClock } from "./clock";
import {
  composePushToTalkMessage,
  speakableText,
  splitSentences,
  type PushToTalkMessageScreen,
} from "./message";
import type { PushToTalkLiveVoice } from "./live-voice";
import type { PushToTalkReplies } from "./reply-watcher";
import type {
  PushToTalkCursorLocation,
  PushToTalkImage,
  PushToTalkScreenCaptureResult,
  PushToTalkScreenContext,
} from "./screen-capture";
import type { PushToTalkSpeaker } from "./speaker";
import {
  PushToTalkTranscriptionError,
  type PushToTalkTranscriber,
} from "./transcriber";
import type {
  PushToTalkCompanion,
  PushToTalkErrorCode,
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkSettings,
  PushToTalkStatus,
  PushToTalkStroke,
  PushToTalkTurnState,
} from "./types";

/** Shorter recordings are taps: discarded without transcribing. */
export const minRecordingMs = 300;
/** A recording ends by itself here, as if the shortcut was released. */
export const maxRecordingMs = 120_000;
/** How long an error stays in the notch or on the companion. */
export const errorVisibleMs = 4_000;
/** How long "wait" replaces "Transcribing" after an ignored press. */
export const busyVisibleMs = 1_500;
/** The last spoken sentence stays on the caption this long. */
export const captionLingerMs = 1_500;
/** Spoken replies off: the caption shows the reply for its reading time. */
export const captionMsPerWord = 300;
export const captionMinMs = 4_000;
export const captionMaxMs = 20_000;

/** A running microphone recording; `stop` resolves with the finished WAV. */
export interface PushToTalkRecording {
  stop(): Promise<string>;
}

export interface PushToTalkMicrophone {
  /**
   * Rejects with `MicrophoneDeniedError` when macOS denies the microphone.
   * `onLevel` gets the voice level 0..1 at about 20 Hz.
   */
  start(input: { onLevel: (level: number) => void }): Promise<PushToTalkRecording>;
}

export interface PushToTalkScreenSource {
  locate(): PushToTalkCursorLocation;
  capture(location: PushToTalkCursorLocation): Promise<PushToTalkScreenCaptureResult>;
}

export interface PushToTalkDelivery {
  /**
   * Sends the turn to the active workspace's agent conversation without the
   * side chat's draft or opening any window, and returns its target.
   */
  send(input: { text: string; attachments: PushToTalkImage[] }): Promise<ChatTarget>;
}

type PowerEvent = "lock-screen" | "suspend";

export interface PushToTalkPowerMonitor {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

export type PushToTalkControllerDeps = {
  hotkey: PushToTalkHotkey;
  companion: PushToTalkCompanion;
  status: PushToTalkStatus;
  microphone: PushToTalkMicrophone;
  screen: PushToTalkScreenSource;
  transcriber: PushToTalkTranscriber;
  delivery: PushToTalkDelivery;
  /** The system voice: the fallback of `voice`, or the only voice without it. */
  speaker: PushToTalkSpeaker;
  /** The GPT Live voice of Comma calls (D12), pre-warmed while the agent thinks. */
  voice?: PushToTalkLiveVoice;
  replies: PushToTalkReplies;
  clock: PushToTalkClock;
  powerMonitor: PushToTalkPowerMonitor;
  /** Opens Side Chat on the agent conversation (a click on the caption). */
  openSideChat: () => void;
  removeFile: (path: string) => Promise<void>;
  /** The effective settings; `enabled` is false while the side chat is off. */
  settings: PushToTalkSettings;
  /** What the voice says in place of a code block, in Main's language. */
  codeBlockLabel?: () => string;
  /** Failures worth a warning. */
  log?: (message: string) => void;
  /** One line per step of the turn, for the smoke test and support. */
  trace?: (message: string) => void;
};

type Turn = {
  phase: "starting" | "recording" | "transcribing" | "sending";
  pressedAt: number;
  releasedAt?: number;
  cancelled: boolean;
  frontmostApp: PushToTalkFrontmostApp | null;
  location: PushToTalkCursorLocation;
  /** Present once the microphone was asked to start. */
  recording?: Promise<PushToTalkRecording>;
  started?: PushToTalkRecording;
  /** Undefined while capturing or with the screenshot turned off. */
  screen?: PushToTalkScreenCaptureResult | undefined;
  stroke: PushToTalkStroke | null;
  stopMaxTimer: () => void;
  stopStroke?: () => void;
  stopBusyTimer?: () => void;
};

/** The sent turn while it waits for, shows and reads the agent's reply. */
type Reply = {
  phase: "thinking" | "speaking";
  target: ChatTarget;
  cancelled: boolean;
  stopTimer?: () => void;
};

/**
 * Owns one push-to-talk turn at a time (openspec add-push-to-talk-agent,
 * D2): idle → listening → transcribing → sending → thinking → speaking →
 * idle. The notch status and the cursor companion show each state; errors
 * go to the notch while it is visible, otherwise to the companion. At the
 * press it stops a reply in progress, captures the screen while the
 * microphone starts, and shows the turn only after the capture.
 */
export class PushToTalkController {
  readonly #deps: PushToTalkControllerDeps;
  #settings: PushToTalkSettings;
  #turn: Turn | undefined;
  #reply: Reply | undefined;
  #companionShown = false;
  #statusShown = false;
  #stopErrorTimer: (() => void) | undefined;
  #unsubscribe: (() => void)[] = [];

  constructor(deps: PushToTalkControllerDeps) {
    this.#deps = deps;
    this.#settings = deps.settings;
  }

  start() {
    const { companion, hotkey, powerMonitor } = this.#deps;
    this.#unsubscribe = [
      hotkey.onPressed(({ frontmostApp }) => void this.#press(frontmostApp)),
      hotkey.onReleased(({ cancelled }) => {
        // Another key joined a modifier-only chord: a different shortcut, so
        // the turn goes without a trace (no error, capture and WAV dropped).
        if (cancelled) this.#cancelRecording("the chord was joined by another key");
        else if (this.#turn) void this.#release(this.#turn);
      }),
      hotkey.onHelperRestarted(() =>
        this.#cancelRecording("the shortcut helper restarted")
      ),
      companion.onCaptionClick(() => {
        this.#trace("push-to-talk caption clicked; opening Side Chat");
        this.#deps.openSideChat();
      }),
    ];
    for (const event of ["lock-screen", "suspend"] as const) {
      const interrupt = () => this.#cancelRecording(event);
      powerMonitor.on(event, interrupt);
      this.#unsubscribe.push(() => powerMonitor.removeListener(event, interrupt));
    }
    this.#register();
  }

  /** Applies changed settings without a restart. */
  update(settings: PushToTalkSettings) {
    const previous = this.#settings;
    this.#settings = settings;
    // A voice refused as disabled or without an account is tried again.
    this.#deps.voice?.reset();
    if (!settings.enabled) {
      this.#cancelRecording("Talk to agent was turned off");
      if (this.#reply) {
        this.#interruptReply();
        this.#hideAll("Talk to agent was turned off");
      }
    }
    if (
      previous.enabled !== settings.enabled ||
      JSON.stringify(previous.shortcut) !== JSON.stringify(settings.shortcut)
    )
      this.#register();
  }

  dispose() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#cancelRecording("Main is closing");
    this.#interruptReply();
    this.#clearErrorTimer();
  }

  #register() {
    const { enabled, shortcut } = this.#settings;
    this.#deps.hotkey
      .register(enabled ? shortcut : null)
      .catch((error: unknown) =>
        this.#log(`Push-to-talk shortcut registration failed: ${message(error)}`)
      );
  }

  async #press(frontmostApp: PushToTalkFrontmostApp | null) {
    if (!this.#settings.enabled) return;
    const running = this.#turn;
    if (running) {
      if (running.phase === "transcribing" || running.phase === "sending")
        this.#showBusy(running);
      return;
    }
    const { clock, companion, microphone, screen, status, transcriber } = this.#deps;
    this.#trace(`push-to-talk pressed (frontmost: ${frontmostApp?.name ?? "unknown"})`);
    this.#interruptReply();
    this.#clearErrorTimer();
    // The previous turn's companion and notch scene stay out of the screenshot.
    if (this.#companionShown) companion.hide({ immediate: true });
    this.#companionShown = false;
    if (this.#statusShown) status.set(null);
    this.#statusShown = false;

    const location = screen.locate();
    const turn: Turn = {
      phase: "starting",
      pressedAt: clock.now(),
      cancelled: false,
      frontmostApp,
      location,
      stroke: null,
      stopMaxTimer: () => undefined,
    };
    this.#turn = turn;
    turn.stopMaxTimer = clock.setTimeout(
      () => void this.#release(turn),
      maxRecordingMs
    );

    const capture: Promise<PushToTalkScreenCaptureResult | undefined> = this.#settings
      .sendScreen
      ? screen.capture(location).catch((error: unknown) => {
          this.#log(`Push-to-talk screen capture failed: ${message(error)}`);
          return { status: "unavailable" as const };
        })
      : Promise.resolve(undefined);

    const ready = await transcriber.ready().catch(() => false);
    if (turn.cancelled) return;
    if (!ready) {
      await capture;
      if (turn.cancelled) return;
      this.#endTurn(turn);
      this.#showError("transcription_unavailable", { turn });
      return;
    }

    turn.recording = microphone.start({
      onLevel: (level) => {
        if (this.#turn !== turn) return;
        status.setLevel(level);
        companion.setLevel(level);
      },
    });
    // Observed here so a rejection after a cancel is never unhandled.
    turn.recording.catch(() => undefined);
    turn.screen = await capture;
    if (turn.cancelled) return;
    companion.show({ ...this.#where(turn), state: { kind: "listening" } });
    this.#companionShown = true;
    status.set({ kind: "listening" });
    this.#statusShown = true;
    this.#trace(`push-to-talk listening on display ${turn.location.displayId}`);
    turn.stopStroke = companion.onStroke((stroke) => {
      turn.stroke = stroke;
    });

    try {
      turn.started = await turn.recording;
    } catch (error) {
      if (turn.cancelled) return;
      this.#endTurn(turn);
      if (error instanceof MicrophoneDeniedError) {
        this.#showError("microphone_denied", { turn });
      } else {
        this.#log(`Push-to-talk microphone failed: ${message(error)}`);
        this.#hideAll("the microphone failed");
      }
      return;
    }
    if (turn.cancelled) return;
    turn.phase = "recording";
    if (turn.releasedAt !== undefined) await this.#release(turn);
  }

  async #release(turn: Turn) {
    if (this.#turn !== turn || turn.cancelled) return;
    turn.releasedAt ??= this.#deps.clock.now();
    // The press is still starting: it processes the release when ready.
    if (turn.phase !== "recording" || !turn.started) return;
    turn.phase = "transcribing";
    turn.stopMaxTimer();
    turn.stopStroke?.();
    const { transcriber } = this.#deps;
    const heldMs = turn.releasedAt - turn.pressedAt;
    this.#trace(`push-to-talk released after ${heldMs} ms`);

    let path: string;
    try {
      path = await turn.started.stop();
    } catch (error) {
      this.#log(`Push-to-talk recording failed: ${message(error)}`);
      this.#endTurn(turn);
      this.#hideAll("the recording failed");
      return;
    }

    let text: string;
    try {
      if (heldMs < minRecordingMs) {
        this.#endTurn(turn);
        this.#hideAll(`a ${heldMs} ms tap`);
        return;
      }
      this.#showState({ kind: "transcribing" });
      text = (await transcriber.transcribe(path)).text.trim();
    } catch (error) {
      this.#log(`Push-to-talk transcription failed: ${message(error)}`);
      this.#endTurn(turn);
      this.#showError(
        error instanceof PushToTalkTranscriptionError
          ? error.code
          : "transcription_failed",
        { turn }
      );
      return;
    } finally {
      await this.#remove(path);
    }
    if (!text) {
      this.#endTurn(turn);
      this.#showError("nothing_heard", { turn });
      return;
    }
    await this.#send(turn, text);
  }

  async #send(turn: Turn, transcript: string) {
    turn.phase = "sending";
    const { delivery, replies } = this.#deps;
    let context: PushToTalkScreenContext | undefined;
    if (turn.screen?.status === "captured") {
      try {
        context = turn.screen.finalize(turn.stroke);
      } catch (error) {
        this.#log(`Push-to-talk screenshot encoding failed: ${message(error)}`);
      }
    }
    // The screenshot was wanted but is missing: the turn goes without it.
    const screenMissing = turn.screen !== undefined && !context;
    const text = composePushToTalkMessage({
      transcript,
      frontmostApp: turn.frontmostApp,
      ...(context
        ? { screen: screenshotContext(context) }
        : screenMissing
          ? { screen: pointerContext(turn.location) }
          : {}),
    });
    const attachments = context?.images ?? [];
    let target: ChatTarget;
    try {
      target = await delivery.send({ text, attachments });
    } catch (error) {
      this.#log(`Push-to-talk send failed: ${message(error)}`);
      this.#endTurn(turn);
      this.#showError("send_failed", { turn, transcript });
      return;
    }
    this.#endTurn(turn);
    this.#trace(`push-to-talk sent with ${attachments.length} images`);

    const reply: Reply = { phase: "thinking", target, cancelled: false };
    this.#reply = reply;
    replies.arm(target, {
      onReply: (markdown) => void this.#answer(reply, markdown),
      onTimeout: () => {
        if (this.#reply !== reply) return;
        this.#reply = undefined;
        this.#deps.voice?.stop();
        this.#hideAll("no reply within the wait");
      },
    });
    // The voice starts close to the reply's arrival when its call is already open.
    if (this.#settings.speakReplies) this.#deps.voice?.prepare(target.workspaceId);
    if (screenMissing) this.#showError("screen_denied", { turn, keepsTurn: true });
    else this.#showState({ kind: "thinking" });
  }

  /** Shows the reply: sentence by sentence while spoken, or whole for its reading time. */
  async #answer(reply: Reply, markdown: string) {
    if (this.#reply !== reply || reply.cancelled) return;
    const { clock, companion, speaker, voice } = this.#deps;
    this.#clearErrorTimer();
    reply.phase = "speaking";
    const codeBlock = this.#deps.codeBlockLabel?.() ?? "code snippet";
    const text = speakableText(markdown, { codeBlock });
    this.#showState({ kind: "speaking" });
    const finish = (ms: number, reason: string) => {
      reply.stopTimer = clock.setTimeout(() => {
        if (this.#reply !== reply) return;
        this.#reply = undefined;
        this.#hideAll(reason);
      }, ms);
    };

    if (!this.#settings.speakReplies) {
      voice?.stop();
      companion.setCaption(text || null);
      const ms = captionReadingMs(text);
      this.#trace(`push-to-talk caption shown for ${ms} ms`);
      finish(ms, "the caption was read");
      return;
    }
    const sentences = splitSentences(text);
    let spoken = 0;
    if (voice && text) {
      const result = await voice.speak({
        workspaceId: reply.target.workspaceId,
        text,
        onCaption: (sentence) => {
          if (!reply.cancelled) companion.setCaption(sentence);
        },
      });
      if (reply.cancelled || result.status === "stopped") return;
      if (result.status === "done") {
        finish(captionLingerMs, "the reply was read");
        return;
      }
      spoken = result.spokenSentences;
      this.#trace(
        `push-to-talk GPT Live voice unavailable (${result.reason}); system voice reads from sentence ${spoken + 1}`
      );
    }
    for (const [index, sentence] of sentences.entries()) {
      if (index < spoken) continue;
      if (reply.cancelled) return;
      companion.setCaption(sentence);
      this.#trace(`push-to-talk speaking sentence ${index + 1}/${sentences.length}`);
      await speaker.speak(sentence);
    }
    if (reply.cancelled) return;
    finish(captionLingerMs, "the reply was read");
  }

  /** A new press, or the feature turned off: the voice stops at once. */
  #interruptReply() {
    const { companion, replies, speaker, voice } = this.#deps;
    speaker.stop();
    voice?.stop();
    replies.cancel();
    const reply = this.#reply;
    this.#reply = undefined;
    if (!reply) return;
    reply.cancelled = true;
    reply.stopTimer?.();
    if (this.#companionShown) companion.setCaption(null);
    this.#trace(`push-to-talk reply interrupted while ${reply.phase}`);
  }

  /** The release can no longer be trusted: drop the recording. */
  #cancelRecording(reason: string) {
    const turn = this.#turn;
    if (!turn || (turn.phase !== "starting" && turn.phase !== "recording")) return;
    turn.cancelled = true;
    this.#endTurn(turn);
    this.#trace(`push-to-talk cancelled: ${reason}`);
    this.#hideAll("the turn was cancelled");
    turn.recording
      ?.then((recording) => recording.stop())
      .then((path) => this.#remove(path))
      .catch((error: unknown) =>
        this.#log(`Push-to-talk cancelled recording: ${message(error)}`)
      );
  }

  #endTurn(turn: Turn) {
    turn.stopMaxTimer();
    turn.stopStroke?.();
    turn.stopBusyTimer?.();
    if (this.#turn === turn) this.#turn = undefined;
  }

  /** A progress state of a shown turn, on the notch and the companion. */
  #showState(state: PushToTalkTurnState) {
    this.#deps.status.set(state);
    this.#statusShown = true;
    if (this.#companionShown) this.#deps.companion.setState(state);
    this.#trace(`push-to-talk ${state.kind}`);
  }

  #showBusy(turn: Turn) {
    const { clock, companion, status } = this.#deps;
    const show = (state: PushToTalkTurnState) =>
      status.visible() ? status.set(state) : companion.setState(state);
    show({ kind: "busy" });
    this.#trace("push-to-talk busy: a turn is still running");
    turn.stopBusyTimer?.();
    turn.stopBusyTimer = clock.setTimeout(() => {
      if (this.#turn === turn) show({ kind: "transcribing" });
    }, busyVisibleMs);
  }

  /**
   * Errors go to the notch while it is visible, otherwise next to the
   * companion. An error that ends the turn hides everything after a while;
   * one that `keepsTurn` (the screenshot was left out) returns to thinking.
   */
  #showError(
    code: PushToTalkErrorCode,
    options: { turn: Turn; transcript?: string; keepsTurn?: boolean }
  ) {
    const { clock, companion, status } = this.#deps;
    const state: PushToTalkTurnState = {
      kind: "error",
      code,
      ...(options.transcript ? { transcript: options.transcript } : {}),
    };
    const inNotch = status.visible();
    this.#trace(`push-to-talk error ${code} on the ${inNotch ? "notch" : "companion"}`);
    if (inNotch) {
      status.set(state);
      this.#statusShown = true;
      if (!options.keepsTurn && this.#companionShown) {
        companion.hide();
        this.#companionShown = false;
      }
    } else {
      if (this.#statusShown) status.set(null);
      this.#statusShown = false;
      if (this.#companionShown) companion.setState(state);
      else companion.show({ ...this.#where(options.turn), state });
      this.#companionShown = true;
    }
    this.#clearErrorTimer();
    this.#stopErrorTimer = clock.setTimeout(() => {
      this.#stopErrorTimer = undefined;
      if (this.#turn) return;
      if (!options.keepsTurn) {
        if (!this.#reply) this.#hideAll("the error was shown");
        return;
      }
      if (this.#reply?.phase === "thinking") this.#showState({ kind: "thinking" });
    }, errorVisibleMs);
  }

  #hideAll(reason: string) {
    this.#clearErrorTimer();
    if (this.#statusShown) this.#deps.status.set(null);
    this.#statusShown = false;
    if (this.#companionShown) this.#deps.companion.hide();
    this.#companionShown = false;
    this.#trace(`push-to-talk hidden: ${reason}`);
  }

  #clearErrorTimer() {
    this.#stopErrorTimer?.();
    this.#stopErrorTimer = undefined;
  }

  #where(turn: Turn) {
    return { displayId: turn.location.displayId, cursor: turn.location.cursor };
  }

  async #remove(path: string) {
    await this.#deps
      .removeFile(path)
      .catch((error: unknown) =>
        this.#log(`Push-to-talk could not delete its recording: ${message(error)}`)
      );
  }

  #log(text: string) {
    this.#deps.log?.(text);
  }

  #trace(text: string) {
    this.#deps.trace?.(text);
  }
}

/** clamp(words × 300 ms, 4 s, 20 s). */
function captionReadingMs(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(captionMaxMs, Math.max(captionMinMs, words * captionMsPerWord));
}

function screenshotContext(context: PushToTalkScreenContext): PushToTalkMessageScreen {
  return {
    kind: "screenshot",
    width: context.width,
    height: context.height,
    cursor: context.cursor,
    ...(context.strokeBounds ? { strokeBounds: context.strokeBounds } : {}),
  };
}

function pointerContext(location: PushToTalkCursorLocation): PushToTalkMessageScreen {
  const { bounds, cursor } = location;
  return {
    kind: "pointer",
    cursor: { x: Math.round(cursor.x - bounds.x), y: Math.round(cursor.y - bounds.y) },
    display: { width: bounds.width, height: bounds.height },
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
