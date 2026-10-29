import type { CommaConversation } from "@comma/app/api";
import type { ChatMessage, ChatTarget } from "@comma/chat-contract";
import { isRouterMessage } from "../modules/message-notifications";
import type { PushToTalkClock } from "./clock";
import { composePushToTalkContext, splitSentences } from "./message";
import {
  voiceFailureCode,
  type PushToTalkCallEvent,
  type PushToTalkLiveCall,
} from "./live-voice";
import type {
  PushToTalkCursorLocation,
  PushToTalkScreenCaptureResult,
} from "./screen-capture";
import type {
  PushToTalkCompanion,
  PushToTalkErrorCode,
  PushToTalkFrontmostApp,
  PushToTalkHotkey,
  PushToTalkScreenRecording,
  PushToTalkSettings,
  PushToTalkStatus,
  PushToTalkStroke,
  PushToTalkTurnState,
} from "./types";

export const minGestureMs = 300;
export const maxGestureMs = 120_000;
export const warmSessionMs = 90_000;
export const maxSessionMs = 600_000;
export const errorVisibleMs = 4_000;
export const captionLingerMs = 1_500;
const maxContextJobs = 2;
export interface PushToTalkScreenSource {
  locate(): PushToTalkCursorLocation;
  capture(location: PushToTalkCursorLocation): Promise<PushToTalkScreenCaptureResult>;
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
  voice: PushToTalkLiveCall;
  screen: PushToTalkScreenSource;
  screenRecording: PushToTalkScreenRecording;
  clock: PushToTalkClock;
  powerMonitor: PushToTalkPowerMonitor;
  openSideChat: () => void;
  isCurrentCaller: (userId: string) => boolean;
  settings: PushToTalkSettings;
  sessionGeneration?: number;
  log?: (message: string) => void;
  trace?: (message: string) => void;
};
type Turn = {
  contextId: number;
  contextAdmitted: boolean;
  pressedAt: number;
  releasedAt?: number;
  cancelled: boolean;
  frontmostApp: PushToTalkFrontmostApp | null;
  location: PushToTalkCursorLocation;
  captureReady: boolean;
  hasContextSlot: boolean;
  requestedScreen: boolean;
  sending: boolean;
  capture: Promise<PushToTalkScreenCaptureResult | undefined>;
  stroke: PushToTalkStroke | null;
  stopMax: () => void;
  openedSession: boolean;
};
type Session = {
  opening: Promise<ChatTarget>;
  connected: boolean;
  hadTurn: boolean;
  pending: Set<string>;
  audible: boolean;
  final: boolean;
  stopMax: () => void;
  stopIdle?: () => void;
  stopQuiet?: () => void;
};

/** Owns gesture capture and the live session lifetime. */
export class PushToTalkController {
  readonly #deps: PushToTalkControllerDeps;
  #settings: PushToTalkSettings;
  #generation: number;
  #lastContextId = 0;
  #currentContextId: number | undefined;
  #turn: Turn | undefined;
  readonly #contexts = new Set<Turn>();
  #session: Session | undefined;
  #state: PushToTalkTurnState | null = null;
  #shown = false;
  #disposed = false;
  #ready: { text: string } | undefined;
  #stopError: (() => void) | undefined;
  #deferredError: PushToTalkErrorCode | undefined;
  #screenRequested = false;
  #caption: string | null = null;
  #unsubscribe: (() => void)[] = [];
  constructor(deps: PushToTalkControllerDeps) {
    this.#deps = deps;
    this.#settings = deps.settings;
    this.#generation = deps.sessionGeneration ?? 0;
  }

  start() {
    const { hotkey, companion, voice, powerMonitor } = this.#deps;
    this.#unsubscribe = [
      hotkey.onPressed(({ frontmostApp }) => this.#press(frontmostApp)),
      hotkey.onReleased(({ cancelled }) => this.#release(cancelled)),
      hotkey.onHelperRestarted(() => this.#endSession("clear")),
      companion.onStroke((stroke) => {
        if (this.#turn && this.#turn.releasedAt === undefined)
          this.#turn.stroke = stroke;
      }),
      // PTT and Side Chat share Main's native-default Workspace Chat,
      // independently of the conversation shown in the main app.
      companion.onCaptionClick(() => {
        this.#deps.openSideChat();
        if (this.#state?.kind === "ready") this.#hide();
      }),
      voice.onEvent((event) => this.#event(event)),
    ];
    for (const event of ["lock-screen", "suspend"] as const) {
      const stop = () => this.#endSession("clear");
      powerMonitor.on(event, stop);
      this.#unsubscribe.push(() => {
        powerMonitor.removeListener(event, stop);
      });
    }
    this.#register();
  }

  update(settings: PushToTalkSettings, generation = this.#generation) {
    const previous = this.#settings;
    this.#settings = settings;
    if (generation !== this.#generation) {
      this.#generation = generation;
      this.#ready = undefined;
      this.#endSession("clear");
    } else if (!settings.enabled) this.#endSession();
    if (settings.enabled && settings.sendScreen && !previous.sendScreen) {
      this.#screenRequested = false;
      this.#requestScreen();
    }
    if (
      previous.enabled !== settings.enabled ||
      JSON.stringify(previous.shortcut) !== JSON.stringify(settings.shortcut)
    )
      this.#register();
  }

  dispose() {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#ready = undefined;
    this.#endSession("clear");
    void this.#deps.hotkey
      .register(null)
      .catch(() => this.#deps.log?.("Push-to-talk shortcut could not unregister."));
  }

  /** Uses only public Router messages with backend-authored late-call lineage. */
  handleAppended(input: {
    conversation: CommaConversation;
    messages: readonly ChatMessage[];
    target: ChatTarget;
  }) {
    if (this.#disposed) return;
    const raw = new Map(
      input.conversation.messages?.map((message) => [
        message.message_id,
        message.metadata,
      ])
    );
    for (const message of input.messages) {
      if (!isRouterMessage(message, input.conversation)) continue;
      const metadata = raw.get(message.messageId);
      if (
        !metadata ||
        metadata.event_type !== "voice.reply" ||
        metadata.voice_mode !== "push_to_talk" ||
        typeof metadata.voice_call_id !== "string" ||
        !metadata.voice_call_id ||
        typeof metadata.voice_delegation_id !== "string" ||
        !metadata.voice_delegation_id ||
        typeof metadata.voice_caller_user_id !== "string" ||
        !this.#deps.isCurrentCaller(metadata.voice_caller_user_id)
      )
        continue;
      this.#ready = { text: message.text };
      // Do not put a late balloon into a screenshot or interrupt a newer call.
      if (!this.#turn && !this.#session) this.#showReady();
    }
  }

  #press(frontmostApp: PushToTalkFrontmostApp | null) {
    if (this.#disposed || !this.#settings.enabled || this.#turn) return;
    this.#stopError?.();
    this.#stopError = undefined;
    this.#deferredError = undefined;
    if (this.#currentContextId !== undefined)
      this.#terminateContext(this.#currentContextId);
    this.#deps.status.set(null);
    this.#deps.companion.hide({ immediate: true });
    this.#deps.companion.setDrawing(true);
    this.#deps.companion.setCaption(null);
    this.#caption = null;
    this.#shown = false;
    const location = this.#deps.screen.locate();
    const openedSession = !this.#session;
    const hasContextSlot = this.#contexts.size < maxContextJobs;
    const contextId = ++this.#lastContextId;
    this.#currentContextId = contextId;
    const requestedScreen = this.#settings.sendScreen && hasContextSlot;
    const turn: Turn = {
      contextId,
      contextAdmitted: false,
      pressedAt: this.#deps.clock.now(),
      cancelled: false,
      frontmostApp,
      location,
      captureReady: !requestedScreen,
      hasContextSlot,
      requestedScreen,
      sending: false,
      capture: Promise.resolve(undefined),
      stroke: null,
      stopMax: () => undefined,
      openedSession,
    };
    this.#turn = turn;
    if (hasContextSlot) this.#contexts.add(turn);
    if (requestedScreen) {
      this.#requestScreen();
      turn.capture = this.#deps.screen
        .capture(location)
        .catch(() => ({ status: "unavailable" as const }));
      void turn.capture.then((result) => {
        if (turn.cancelled) return;
        turn.captureReady = true;
        if (!this.#capturing()) {
          if (this.#deferredError) {
            const code = this.#deferredError;
            this.#deferredError = undefined;
            this.#showError(code, false);
          } else if (this.#state) this.#present(this.#state);
        }
        if (result?.status !== "captured")
          this.#failContext(
            turn.contextId,
            result?.status === "denied" ? "screen_denied" : "context_failed"
          );
      });
    }
    let session = this.#session;
    if (!session) {
      const opening = this.#deps.voice.open();
      session = {
        opening,
        connected: false,
        hadTurn: false,
        pending: new Set(),
        audible: false,
        final: false,
        stopMax: () => undefined,
      };
      this.#session = session;
      const owned = session;
      session.stopMax = this.#deps.clock.setTimeout(() => {
        if (this.#session === owned) this.#endSession();
      }, maxSessionMs);
      void opening
        .then(() => {
          if (this.#session !== owned) return;
          const current = this.#turn;
          const held =
            current !== undefined &&
            current.releasedAt === undefined &&
            !current.cancelled;
          this.#deps.voice.setListening(held);
        })
        .catch((error: unknown) => {
          if (this.#session === owned)
            this.#showError(errorCode(voiceFailureCode(error)));
        });
    } else {
      session.stopIdle?.();
      delete session.stopIdle;
      session.stopQuiet?.();
      delete session.stopQuiet;
      session.hadTurn = false;
      session.final = false;
    }
    const activeSession = session;
    void this.#deps.voice
      .beginContext(turn.contextId)
      .then(() => {
        if (
          this.#session !== activeSession ||
          this.#currentContextId !== turn.contextId ||
          turn.cancelled
        )
          return;
        turn.contextAdmitted = true;
        if (this.#turn === turn)
          this.#present({
            kind: activeSession.connected ? "listening" : "connecting",
          });
      })
      .catch(() => {
        if (this.#session === activeSession)
          this.#failContext(turn.contextId, "context_failed");
      });
    this.#deps.voice.setListening(true);
    this.#present({ kind: "connecting" });
    turn.stopMax = this.#deps.clock.setTimeout(() => {
      if (this.#turn === turn) this.#release(false);
    }, maxGestureMs);
    this.#deps.trace?.("push-to-talk pressed; call setup and screen capture started");
  }

  #release(cancelled: boolean) {
    const turn = this.#turn;
    if (!turn || turn.releasedAt !== undefined) return;
    // This operation is synchronous and precedes all screen/context awaits.
    this.#deps.voice.setListening(false);
    this.#deps.companion.setDrawing(false);
    turn.releasedAt = this.#deps.clock.now();
    const session = this.#session;
    if (!session) {
      this.#terminateContext(turn.contextId);
      this.#deps.voice.cancelContext(turn.contextId);
      return;
    }
    if (
      cancelled ||
      turn.cancelled ||
      turn.releasedAt - turn.pressedAt < minGestureMs
    ) {
      this.#terminateContext(turn.contextId);
      this.#deps.voice.cancelContext(turn.contextId);
      if (turn.openedSession && !session.hadTurn) this.#endSession();
      else {
        this.#hide();
        this.#armIdle(session);
      }
      return;
    }
    if (!turn.hasContextSlot) {
      this.#terminateContext(turn.contextId);
      this.#deps.voice.cancelContext(turn.contextId);
      this.#showError("context_failed", false);
      return;
    }
    turn.stopMax();
    this.#turn = undefined;
    turn.sending = true;
    if (!this.#quiet(session)) {
      this.#present({ kind: "thinking" });
      if (!session.hadTurn) {
        this.#armIdle(session);
      }
    }
    void this.#appendContext(turn, session);
  }

  async #appendContext(turn: Turn, session: Session) {
    try {
      const captured = await turn.capture;
      await session.opening;
      if (turn.cancelled || this.#session !== session) return;

      if (turn.requestedScreen && captured?.status !== "captured") {
        this.#failContext(
          turn.contextId,
          captured?.status === "denied" ? "screen_denied" : "context_failed"
        );
        return;
      }

      const context =
        captured?.status === "captured" ? captured.finalize(turn.stroke) : undefined;
      const { cursor, bounds } = turn.location;
      const images = context?.images ?? [];
      const text = composePushToTalkContext({
        frontmostApp: turn.frontmostApp,
        screen: context
          ? {
              kind: "screenshot",
              width: context.width,
              height: context.height,
              cursor: context.cursor,
              ...(context.strokeBounds ? { strokeBounds: context.strokeBounds } : {}),
            }
          : {
              kind: "pointer",
              cursor: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
              display: { width: bounds.width, height: bounds.height },
            },
        fileNames: images.map((image) => image.name),
      });
      await this.#deps.voice.appendContext({
        contextId: turn.contextId,
        text,
        attachments: images,
      });
    } catch {
      if (!turn.cancelled && this.#session === session)
        this.#failContext(turn.contextId, "context_failed");
    } finally {
      this.#contexts.delete(turn);
    }
  }

  #failContext(contextId: number, code: PushToTalkErrorCode) {
    if (!this.#terminateContext(contextId)) return;
    this.#deps.voice.setListening(false);
    this.#deps.companion.setDrawing(false);
    void this.#deps.voice.failContext(contextId).catch(() => undefined);
    this.#showError(code, false);
  }

  #terminateContext(contextId: number) {
    if (this.#currentContextId !== contextId) return false;
    // Revoke callback eligibility before transport abort rejects admission.
    this.#currentContextId = undefined;
    if (this.#turn?.contextId === contextId) {
      this.#turn.cancelled = true;
      this.#turn.stopMax();
      this.#turn = undefined;
    }
    for (const turn of this.#contexts) {
      if (turn.contextId !== contextId) continue;
      turn.cancelled = true;
      if (!turn.sending) {
        void turn.capture.then(() => {
          this.#contexts.delete(turn);
        });
      }
    }
    return true;
  }

  #capturing() {
    for (const turn of this.#contexts) {
      if (!turn.cancelled && !turn.captureReady) return true;
    }
    return false;
  }

  #event(event: PushToTalkCallEvent) {
    const session = this.#session;
    if (!session) return;
    if (event.kind === "connected") {
      session.connected = true;
      const held = this.#turn?.releasedAt === undefined && this.#turn !== undefined;
      this.#deps.voice.setListening(held);
      this.#present({
        kind: held
          ? this.#turn?.contextAdmitted
            ? "listening"
            : "connecting"
          : "thinking",
      });
    } else if (event.kind === "level") {
      if (this.#turn && this.#turn.releasedAt === undefined) {
        this.#deps.status.setLevel(event.level);
        this.#deps.companion.setLevel(event.level);
      }
    } else if (event.kind === "caller_turn") {
      session.hadTurn = true;
      session.stopIdle?.();
      delete session.stopIdle;
    } else if (event.kind === "context_failed") {
      if (this.#currentContextId === event.contextId) {
        const code =
          this.#state?.kind === "error"
            ? this.#state.code
            : (this.#deferredError ?? "context_failed");
        this.#failContext(event.contextId, code);
      }
    } else if (event.kind === "delegation") {
      session.hadTurn = true;
      if (event.status === "pending") {
        session.pending.add(event.id);
        session.stopIdle?.();
        session.stopQuiet?.();
        this.#present({ kind: "thinking" });
      } else {
        session.pending.delete(event.id);
        if (!this.#quiet(session)) this.#armIdle(session);
      }
    } else if (event.kind === "caption") {
      session.hadTurn = true;
      session.final = event.final;
      session.stopIdle?.();
      delete session.stopIdle;
      const text = splitSentences(event.text).at(-1) ?? null;
      this.#caption = text;
      this.#present({ kind: "speaking" });
      if (!this.#capturing()) this.#deps.companion.setCaption(text);
      this.#quiet(session);
    } else if (event.kind === "audible") {
      session.audible = true;
      session.stopIdle?.();
      delete session.stopIdle;
      session.stopQuiet?.();
      this.#present({ kind: "speaking" });
    } else if (event.kind === "silent") {
      session.audible = false;
      if (session.pending.size) this.#present({ kind: "thinking" });
      if (!this.#quiet(session)) this.#armIdle(session);
    } else if (event.kind === "closed") this.#endSession();
    else if (event.kind === "error") this.#showError(errorCode(event.code));
  }

  #quiet(session: Session) {
    session.stopQuiet?.();
    delete session.stopQuiet;
    if (session.audible || !session.final || session.pending.size || this.#turn)
      return false;
    session.stopQuiet = this.#deps.clock.setTimeout(() => {
      if (
        this.#session !== session ||
        (this.#turn && this.#turn.releasedAt === undefined)
      )
        return;
      this.#hide();
      this.#armIdle(session);
    }, captionLingerMs);
    return true;
  }

  #canIdle(session: Session) {
    return (
      this.#session === session &&
      !session.audible &&
      !session.pending.size &&
      !(this.#turn && this.#turn.releasedAt === undefined)
    );
  }

  #armIdle(session: Session) {
    session.stopIdle?.();
    if (!this.#canIdle(session)) {
      if (session.pending.size) this.#present({ kind: "thinking" });
      return;
    }
    session.stopIdle = this.#deps.clock.setTimeout(() => {
      if (this.#canIdle(session)) this.#endSession();
    }, warmSessionMs);
  }

  #endSession(presentation: "ready" | "clear" | "defer-ready" = "ready") {
    const clearPresentation = presentation === "clear";
    this.#deps.companion.setDrawing(false);
    if (clearPresentation) this.#ready = undefined;
    if (this.#currentContextId !== undefined)
      this.#terminateContext(this.#currentContextId);
    this.#deferredError = undefined;
    this.#session?.stopMax();
    this.#session?.stopIdle?.();
    this.#session?.stopQuiet?.();
    this.#session = undefined;
    this.#deps.voice.close();
    this.#stopError?.();
    this.#stopError = undefined;
    this.#hide(clearPresentation);
    if (presentation === "ready" && this.#ready && !this.#disposed) this.#showReady();
  }

  #present(state: PushToTalkTurnState) {
    this.#state = state;
    if (this.#capturing()) return;
    this.#deps.status.set(state);
    if (state.kind === "error" && this.#deps.status.visible()) {
      if (this.#shown) {
        this.#deps.companion.hide();
        this.#shown = false;
      }
      return;
    }
    if (!this.#shown) {
      const location = this.#turn?.location ?? this.#deps.screen.locate();
      this.#deps.companion.show({
        displayId: location.displayId,
        cursor: location.cursor,
        state,
      });
      this.#shown = true;
      if (this.#caption !== null) this.#deps.companion.setCaption(this.#caption);
    } else this.#deps.companion.setState(state);
  }

  #showError(code: PushToTalkErrorCode, end = true) {
    if (end) this.#endSession("defer-ready");
    else if (this.#session) this.#armIdle(this.#session);
    this.#caption = null;
    this.#stopError?.();
    this.#stopError = undefined;
    if (this.#capturing()) {
      this.#deferredError = code;
      return;
    }
    this.#deferredError = undefined;
    this.#state = { kind: "error", code };
    this.#present(this.#state);
    this.#stopError = this.#deps.clock.setTimeout(() => {
      this.#stopError = undefined;
      const session = this.#session;
      if (session) {
        if (this.#turn)
          this.#present({
            kind:
              session.connected && this.#turn.contextAdmitted
                ? "listening"
                : "connecting",
          });
        else if (!this.#quiet(session))
          this.#present({ kind: session.audible ? "speaking" : "thinking" });
      } else if (this.#ready && !this.#disposed) {
        this.#showReady();
      } else this.#hide();
    }, errorVisibleMs);
  }

  #showReady() {
    if (!this.#ready) return;
    this.#stopError?.();
    this.#stopError = undefined;
    this.#deferredError = undefined;
    this.#caption = this.#ready.text;
    this.#present({ kind: "ready" });
    this.#deps.companion.setCaption(this.#ready.text);
    this.#ready = undefined;
  }

  #hide(immediate = false) {
    this.#state = null;
    this.#caption = null;
    this.#deps.status.set(null);
    if (immediate) {
      this.#deps.companion.setCaption(null);
      this.#deps.companion.hide({ immediate: true });
    } else this.#deps.companion.hide();
    this.#shown = false;
  }

  #register() {
    void this.#deps.hotkey
      .register(this.#settings.enabled ? this.#settings.shortcut : null)
      .catch(() => this.#deps.log?.("Push-to-talk shortcut could not register."));
  }

  #requestScreen() {
    if (this.#screenRequested || this.#deps.screenRecording.status() === "granted")
      return;
    this.#screenRequested = true;
    void this.#deps.screenRecording
      .request()
      .catch(() => this.#deps.log?.("Push-to-talk Screen Recording request failed."));
  }
}

function errorCode(code: string): PushToTalkErrorCode {
  return code === "microphone_denied" || code === "busy" || code === "plan_limit"
    ? code
    : "call_failed";
}
