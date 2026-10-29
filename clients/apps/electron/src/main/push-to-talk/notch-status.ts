import { defaultLocale, messages } from "@comma/i18n";
import type { NotchHostEvent, NotchVoiceTurn } from "@comma/native-bridge";
import log from "electron-log/main";
import { readMainLocale, type MainLocaleSource } from "../main-locale";
import { systemClock, type PushToTalkClock } from "./clock";
import type {
  PushToTalkErrorAction,
  PushToTalkErrorCode,
  PushToTalkStatus,
  PushToTalkTurnState,
} from "./types";

/** ~20 Hz: the bars ease between readings, so more writes add nothing. */
export const notchLevelIntervalMs = 50;

/** The part of NotchService the turn's scene uses. */
export interface PushToTalkNotch {
  visible(): boolean;
  setVoice(turn: NotchVoiceTurn | null): Promise<unknown>;
  onEvent(listener: (event: NotchHostEvent) => void): () => void;
}

const errorActions = {
  microphone_denied: "open-microphone-settings",
  screen_denied: "open-screen-recording-settings",
} as const satisfies Partial<Record<PushToTalkErrorCode, PushToTalkErrorAction>>;

const knownActions = new Set<string>([
  ...Object.values(errorActions),
  "open-side-chat",
]);

/**
 * The push-to-talk turn in the Comma Notch: the state's text and the
 * microphone level, colored by NotchHost. An error's action comes back
 * through the Notch's `voice:action` event.
 */
export class NotchPushToTalkStatus implements PushToTalkStatus {
  readonly #notch: PushToTalkNotch;
  readonly #clock: PushToTalkClock;
  readonly #locale: MainLocaleSource;
  readonly #onAction: (action: PushToTalkErrorAction) => void;
  readonly #unsubscribe: () => void;
  #turn: NotchVoiceTurn | null = null;
  #level = 0;
  #levelSentAt = Number.NEGATIVE_INFINITY;
  #cancelLevel: (() => void) | undefined;

  constructor(options: {
    notch: PushToTalkNotch;
    onAction: (action: PushToTalkErrorAction) => void;
    clock?: PushToTalkClock | undefined;
    locale?: MainLocaleSource | undefined;
  }) {
    this.#notch = options.notch;
    this.#onAction = options.onAction;
    this.#clock = options.clock ?? systemClock;
    this.#locale = options.locale ?? defaultLocale;
    this.#unsubscribe = options.notch.onEvent((event) => {
      if (event.type !== "action" || event.payload?.action !== "voice:action") return;
      const action = event.payload.value;
      // Only the action the shown error offers; a late click answers nothing.
      if (!action || !knownActions.has(action) || this.#turn?.action?.id !== action) {
        return;
      }
      this.#onAction(action as PushToTalkErrorAction);
    });
  }

  visible() {
    return this.#notch.visible();
  }

  set(state: PushToTalkTurnState | null) {
    this.#cancelPendingLevel();
    this.#level = 0;
    this.#turn = state ? this.#project(state) : null;
    this.#write(this.#turn);
  }

  setLevel(level: number) {
    if (this.#turn?.state !== "listening") return;
    const next = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100;
    if (Number.isNaN(next)) return;
    this.#level = next;
    if (this.#cancelLevel) return;

    const wait = this.#levelSentAt + notchLevelIntervalMs - this.#clock.now();
    if (wait <= 0) {
      this.#sendLevel();
      return;
    }
    this.#cancelLevel = this.#clock.setTimeout(() => {
      this.#cancelLevel = undefined;
      this.#sendLevel();
    }, wait);
  }

  dispose() {
    this.#cancelPendingLevel();
    this.#unsubscribe();
  }

  #sendLevel() {
    const turn = this.#turn;
    if (turn?.state !== "listening" || turn.level === this.#level) return;
    this.#levelSentAt = this.#clock.now();
    this.#turn = { ...turn, level: this.#level };
    this.#write(this.#turn);
  }

  #cancelPendingLevel() {
    this.#cancelLevel?.();
    this.#cancelLevel = undefined;
  }

  #write(turn: NotchVoiceTurn | null) {
    this.#notch.setVoice(turn).catch((error: unknown) => {
      log.warn(
        `Push-to-talk Notch update failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  #project(state: PushToTalkTurnState): NotchVoiceTurn {
    const locale = { locale: readMainLocale(this.#locale) };
    switch (state.kind) {
      case "listening":
        return {
          level: 0,
          message: messages.push_to_talk_listening({}, locale),
          state: "listening",
        };
      case "thinking":
        return {
          message: messages.push_to_talk_thinking({}, locale),
          state: "thinking",
        };
      case "speaking":
        return {
          message: messages.push_to_talk_speaking({}, locale),
          state: "speaking",
        };
      case "ready":
        // Ready projects to the existing "busy" wire state with open-side-chat action.
        return {
          action: {
            id: "open-side-chat",
            label: messages.push_to_talk_open_side_chat({}, locale),
          },
          message: messages.push_to_talk_ready({}, locale),
          state: "busy",
        };
      case "error": {
        const message = {
          busy: messages.push_to_talk_call_busy,
          call_failed: messages.push_to_talk_call_failed,
          context_failed: messages.push_to_talk_context_failed,
          microphone_denied: messages.push_to_talk_microphone_denied,
          plan_limit: messages.push_to_talk_plan_limit,
          screen_denied: messages.push_to_talk_screen_denied,
        }[state.code]({}, locale);
        const action = errorActions[state.code as keyof typeof errorActions];
        if (!action) return { message, state: "error" };
        const label = messages.push_to_talk_open_system_settings({}, locale);
        return { action: { id: action, label }, message, state: "error" };
      }
    }
  }
}
