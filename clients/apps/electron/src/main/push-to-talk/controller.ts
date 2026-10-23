import type { ChatTarget } from "@comma/chat-contract";
import { MicrophoneDeniedError } from "../modules/audio-capture/microphone";
import type { PushToTalkClock } from "./clock";
import {
  composePushToTalkMessage,
  speakableText,
  type PushToTalkMessageScreen,
} from "./message";
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
  PushToTalkErrorCode,
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkOverlay,
  PushToTalkPillState,
  PushToTalkRect,
  PushToTalkSettings,
  PushToTalkStroke,
} from "./types";

/** Shorter recordings are taps: discarded without transcribing. */
export const minRecordingMs = 300;
/** A recording ends by itself here, as if the shortcut was released. */
export const maxRecordingMs = 120_000;
/** How long an error pill stays before the overlay hides. */
export const errorPillMs = 4_000;
/** How long the busy pill replaces "Transcribing". */
export const busyPillMs = 1_500;

/** A running microphone recording; `stop` resolves with the finished WAV. */
export interface PushToTalkRecording {
  stop(): Promise<string>;
}

export interface PushToTalkMicrophone {
  /** Rejects with `MicrophoneDeniedError` when macOS denies the microphone. */
  start(): Promise<PushToTalkRecording>;
}

export interface PushToTalkScreenSource {
  locate(): PushToTalkCursorLocation;
  capture(location: PushToTalkCursorLocation): Promise<PushToTalkScreenCaptureResult>;
}

export interface PushToTalkDelivery {
  /**
   * Sends the turn to the active workspace's agent conversation without the
   * side chat's draft, shows it in the side chat and returns its target.
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
  overlay: PushToTalkOverlay;
  microphone: PushToTalkMicrophone;
  screen: PushToTalkScreenSource;
  transcriber: PushToTalkTranscriber;
  delivery: PushToTalkDelivery;
  speaker: PushToTalkSpeaker;
  replies: PushToTalkReplies;
  clock: PushToTalkClock;
  powerMonitor: PushToTalkPowerMonitor;
  removeFile: (path: string) => Promise<void>;
  /** The effective settings; `enabled` is false while the side chat is off. */
  settings: PushToTalkSettings;
  /** What the voice says in place of a code block, in Main's language. */
  codeBlockLabel?: () => string;
  log?: (message: string) => void;
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
  region: PushToTalkRect | null;
  stopMaxTimer: () => void;
  stopRegion?: () => void;
  stopBusyTimer?: () => void;
};

/**
 * Owns one push-to-talk turn at a time (openspec add-push-to-talk-agent,
 * D2): idle → recording → transcribing → sending → idle, with the reply
 * read afterwards. At the press it stops speech, captures the screen while
 * the microphone starts, and shows the overlay only after the capture.
 */
export class PushToTalkController {
  readonly #deps: PushToTalkControllerDeps;
  #settings: PushToTalkSettings;
  #turn: Turn | undefined;
  #stopPillTimer: (() => void) | undefined;
  #unsubscribe: (() => void)[] = [];

  constructor(deps: PushToTalkControllerDeps) {
    this.#deps = deps;
    this.#settings = deps.settings;
  }

  start() {
    const { hotkey, powerMonitor } = this.#deps;
    const interrupt = () => this.#cancelRecording();
    this.#unsubscribe = [
      hotkey.onPressed(({ frontmostApp }) => void this.#press(frontmostApp)),
      hotkey.onReleased(({ cancelled }) => {
        // Another key joined a modifier-only chord: a different shortcut, so
        // the turn goes without a trace (no error, capture and WAV dropped).
        if (cancelled) this.#cancelRecording();
        else if (this.#turn) void this.#release(this.#turn);
      }),
      hotkey.onHelperRestarted(interrupt),
    ];
    for (const event of ["lock-screen", "suspend"] as const) {
      powerMonitor.on(event, interrupt);
      this.#unsubscribe.push(() => powerMonitor.removeListener(event, interrupt));
    }
    this.#register();
  }

  /** Applies changed settings without a restart. */
  update(settings: PushToTalkSettings) {
    const previous = this.#settings;
    this.#settings = settings;
    if (!settings.enabled) this.#cancelRecording();
    if (
      previous.enabled !== settings.enabled ||
      JSON.stringify(previous.shortcut) !== JSON.stringify(settings.shortcut)
    )
      this.#register();
  }

  dispose() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#cancelRecording();
    this.#deps.replies.cancel();
    this.#deps.speaker.stop();
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
    const { clock, microphone, overlay, screen, speaker, replies, transcriber } =
      this.#deps;
    speaker.stop();
    replies.cancel();
    this.#clearPill();

    const location = screen.locate();
    const turn: Turn = {
      phase: "starting",
      pressedAt: clock.now(),
      cancelled: false,
      frontmostApp,
      location,
      region: null,
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
      overlay.show({
        ...this.#where(turn),
        state: errorState("transcription_unavailable"),
      });
      this.#scheduleHide();
      return;
    }

    turn.recording = microphone.start();
    // Observed here so a rejection after a cancel is never unhandled.
    turn.recording.catch(() => undefined);
    turn.screen = await capture;
    if (turn.cancelled) return;
    overlay.show({ ...this.#where(turn), state: { kind: "listening" } });
    turn.stopRegion = overlay.onRegion((rect) => {
      turn.region = rect;
    });

    try {
      turn.started = await turn.recording;
    } catch (error) {
      if (turn.cancelled) return;
      this.#endTurn(turn);
      if (error instanceof MicrophoneDeniedError) {
        this.#showError("microphone_denied");
      } else {
        this.#log(`Push-to-talk microphone failed: ${message(error)}`);
        overlay.hide();
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
    turn.stopRegion?.();
    const { overlay, transcriber } = this.#deps;
    const heldMs = turn.releasedAt - turn.pressedAt;

    let path: string;
    try {
      path = await turn.started.stop();
    } catch (error) {
      this.#log(`Push-to-talk recording failed: ${message(error)}`);
      this.#endTurn(turn);
      overlay.hide();
      return;
    }

    let text: string;
    try {
      if (heldMs < minRecordingMs) {
        this.#endTurn(turn);
        overlay.hide();
        return;
      }
      overlay.setState({ kind: "transcribing" });
      text = (await transcriber.transcribe(path)).text.trim();
    } catch (error) {
      this.#endTurn(turn);
      this.#showError(
        error instanceof PushToTalkTranscriptionError
          ? error.code
          : "transcription_failed"
      );
      return;
    } finally {
      await this.#remove(path);
    }
    if (!text) {
      this.#endTurn(turn);
      this.#showError("nothing_heard");
      return;
    }
    await this.#send(turn, text);
  }

  async #send(turn: Turn, transcript: string) {
    turn.phase = "sending";
    const { delivery, overlay, replies, speaker } = this.#deps;
    let context: PushToTalkScreenContext | undefined;
    if (turn.screen?.status === "captured") {
      try {
        context = turn.screen.finalize(turn.region && rectStroke(turn.region));
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
    let target: ChatTarget;
    try {
      target = await delivery.send({ text, attachments: context?.images ?? [] });
    } catch (error) {
      this.#log(`Push-to-talk send failed: ${message(error)}`);
      this.#endTurn(turn);
      this.#showError("send_failed", transcript);
      return;
    }
    this.#endTurn(turn);
    if (screenMissing) this.#showError("screen_denied");
    else overlay.hide();
    if (this.#settings.speakReplies) {
      const codeBlock = this.#deps.codeBlockLabel?.() ?? "code snippet";
      replies.arm(target, (reply) =>
        speaker.speak(speakableText(reply, { codeBlock }))
      );
    }
  }

  /** The release can no longer be trusted: drop the recording. */
  #cancelRecording() {
    const turn = this.#turn;
    if (!turn || (turn.phase !== "starting" && turn.phase !== "recording")) return;
    turn.cancelled = true;
    this.#endTurn(turn);
    this.#deps.overlay.hide();
    turn.recording
      ?.then((recording) => recording.stop())
      .then((path) => this.#remove(path))
      .catch((error: unknown) =>
        this.#log(`Push-to-talk cancelled recording: ${message(error)}`)
      );
  }

  #endTurn(turn: Turn) {
    turn.stopMaxTimer();
    turn.stopRegion?.();
    turn.stopBusyTimer?.();
    if (this.#turn === turn) this.#turn = undefined;
  }

  #showBusy(turn: Turn) {
    const { clock, overlay } = this.#deps;
    overlay.setState({ kind: "busy" });
    turn.stopBusyTimer?.();
    turn.stopBusyTimer = clock.setTimeout(() => {
      if (this.#turn === turn) overlay.setState({ kind: "transcribing" });
    }, busyPillMs);
  }

  #showError(code: PushToTalkErrorCode, transcript?: string) {
    this.#deps.overlay.setState(errorState(code, transcript));
    this.#scheduleHide();
  }

  #scheduleHide() {
    this.#clearPill();
    this.#stopPillTimer = this.#deps.clock.setTimeout(() => {
      this.#stopPillTimer = undefined;
      if (!this.#turn) this.#deps.overlay.hide();
    }, errorPillMs);
  }

  #clearPill() {
    this.#stopPillTimer?.();
    this.#stopPillTimer = undefined;
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
}

function errorState(
  code: PushToTalkErrorCode,
  transcript?: string
): PushToTalkPillState {
  return { kind: "error", code, ...(transcript ? { transcript } : {}) };
}

/** The marked rectangle as the closed stroke the capture takes. */
function rectStroke(rect: PushToTalkRect): PushToTalkStroke {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x, y: bottom },
    { x: rect.x, y: rect.y },
  ];
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
