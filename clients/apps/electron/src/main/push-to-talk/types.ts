// Shared contract of the push-to-talk turn (openspec change
// add-push-to-talk-agent, UX revision: ⌃⌥ chord, notch states, cursor
// companion, freehand stroke). The controller in this folder drives these
// interfaces; the native hotkey adapter, the overlay window and the notch
// status implement them.
import type { SideChatShortcut, SideChatShortcutBinding } from "@comma/native-bridge";

/** App that was frontmost when the shortcut went down. */
export type PushToTalkFrontmostApp = { name: string; bundleId: string | null };

/** Rectangle in DIP points, relative to the captured display's bounds origin. */
export type PushToTalkRect = { x: number; y: number; width: number; height: number };

/** Point in global screen DIP coordinates (Electron `screen` space). */
export type PushToTalkPoint = { x: number; y: number };

/**
 * Freehand stroke drawn while the shortcut is held, in DIP points relative to
 * the captured display's bounds origin, in drawing order.
 */
export type PushToTalkStroke = ReadonlyArray<PushToTalkPoint>;

/**
 * Hold-to-talk chord. `key: null` is a modifier-only chord (at least two
 * modifiers, e.g. ⌃⌥); otherwise a regular key with at least one modifier.
 */
export type PushToTalkShortcut = {
  key: SideChatShortcut["key"] | null;
  modifiers: SideChatShortcut["modifiers"];
};
export type PushToTalkShortcutBinding = PushToTalkShortcut | null;

export type PushToTalkErrorCode =
  | "microphone_denied"
  | "screen_denied" // the question was sent without the screenshot
  | "transcription_unavailable"
  | "transcription_busy"
  | "transcription_failed"
  | "nothing_heard"
  | "send_failed";

/** State of the turn, shown by the notch and by the cursor companion. */
export type PushToTalkTurnState =
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "thinking" } // sent; waiting for the agent's reply
  | { kind: "speaking" } // the reply is on the caption (and read aloud when enabled)
  | { kind: "busy" } // a press was ignored because a turn is still running
  | { kind: "error"; code: PushToTalkErrorCode; transcript?: string };

/** Actions offered next to an error, wherever it is shown. */
export type PushToTalkErrorAction =
  | "open-microphone-settings"
  | "open-screen-recording-settings"
  | "open-input-monitoring-settings"
  | "open-meeting-settings"
  | "copy-transcript";

/** Pill states of the current overlay (replaced by the companion in wave 2). */
export type PushToTalkPillState =
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "busy" }
  | { kind: "error"; code: PushToTalkErrorCode; transcript?: string };

/**
 * Current overlay window: state pill + drag-to-mark rectangle. Wave 2 of the
 * UX revision replaces it with the cursor companion (see design D4): show /
 * setState(PushToTalkTurnState) / setLevel / setCaption / hide / onStroke /
 * onCaptionClick.
 */
export interface PushToTalkOverlay {
  show(input: {
    displayId: number;
    cursor: PushToTalkPoint;
    state: PushToTalkPillState;
  }): void;
  setState(state: PushToTalkPillState): void;
  hide(): void;
  /** Latest marked region of the shown display; `null` clears it. */
  onRegion(listener: (rect: PushToTalkRect | null) => void): () => void;
}

/**
 * The transparent window of the cursor's display that hosts the cursor
 * companion, its caption balloon and the freehand stroke. `show` is only
 * called after the screenshot was taken. The window follows the cursor by
 * itself (and moves to the cursor's display) while shown. While `listening`
 * it accepts mouse drags to draw the stroke; in any other state it is
 * click-through except over the caption balloon and error actions.
 * Errors are shown here only when the notch is off (the controller decides).
 */
export interface PushToTalkCompanion {
  show(input: {
    displayId: number;
    cursor: PushToTalkPoint;
    state: PushToTalkTurnState;
  }): void;
  setState(state: PushToTalkTurnState): void;
  /** Microphone level 0..1 while listening (~20 Hz). */
  setLevel(level: number): void;
  /** Text of the caption balloon; `null` removes the balloon. */
  setCaption(text: string | null): void;
  /** Fades the companion and the stroke out, then hides the window. */
  hide(): void;
  /** Latest stroke of the shown display; `null` clears it. A new drag replaces it. */
  onStroke(listener: (stroke: PushToTalkStroke | null) => void): () => void;
  /** The user clicked the caption balloon. */
  onCaptionClick(listener: () => void): () => void;
}

/**
 * The notch scene of the turn. Error actions are routed to the `onAction`
 * callback given to the notch status when it is created.
 */
export interface PushToTalkStatus {
  /** False when the Comma notch is turned off; errors then go to the companion. */
  visible(): boolean;
  /** `null` gives the notch back to what it showed before the turn. */
  set(state: PushToTalkTurnState | null): void;
  /** Microphone level 0..1 while listening (~20 Hz). */
  setLevel(level: number): void;
}

export type PushToTalkInputMonitoring = "granted" | "denied" | "not-needed";

/**
 * Hold-to-talk shortcut registered in the native side chat helper. Wave 1 of
 * the UX revision (tasks 7.1–7.3) changes it to the modifier-only contract:
 * register(PushToTalkShortcutBinding) resolving the Input Monitoring state,
 * requestInputMonitoring, onReleased({ cancelled }), onInputMonitoring.
 */
export interface PushToTalkHotkey {
  /** `null` unregisters. Resolves after the helper confirmed the registration. */
  register(shortcut: SideChatShortcutBinding): Promise<void>;
  onPressed(
    listener: (event: { frontmostApp: PushToTalkFrontmostApp | null }) => void
  ): () => void;
  onReleased(listener: () => void): () => void;
  /** The helper process restarted; a held shortcut can no longer be released. */
  onHelperRestarted(listener: () => void): () => void;
}

/** Desktop client settings of the feature (fields of commaClientSettings). */
export type PushToTalkSettings = {
  enabled: boolean;
  shortcut: SideChatShortcutBinding;
  speakReplies: boolean;
  sendScreen: boolean;
};
