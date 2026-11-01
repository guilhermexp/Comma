// Shared contract of the push-to-talk turn (openspec change
// add-push-to-talk-agent, UX revision: ⌃⌥ chord, notch states, cursor
// companion, freehand stroke). The controller in this folder drives these
// interfaces; the native hotkey adapter, the overlay window and the notch
// status implement them.
import type { SideChatShortcut } from "@comma/native-bridge";

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
  | "screen_denied"
  | "busy"
  | "plan_limit"
  | "context_failed"
  | "call_failed";

/** State of the turn, shown by the notch and by the cursor companion. */
export type PushToTalkTurnState =
  | { kind: "listening" }
  | { kind: "thinking" }
  | { kind: "speaking" }
  | { kind: "ready" }
  | { kind: "error"; code: PushToTalkErrorCode };

/** Actions offered next to an error, wherever it is shown. */
export type PushToTalkErrorAction =
  | "open-microphone-settings"
  | "open-screen-recording-settings"
  | "open-input-monitoring-settings"
  | "open-side-chat";

/**
 * The transparent window of the cursor's display that hosts the cursor
 * companion, its caption balloon and the freehand stroke. `show` is only
 * called after the screenshot was taken. The window follows the cursor by
 * itself (and moves to the cursor's display) while shown. While the gesture
 * is held it accepts drags on the captured display, independently of voice
 * playback state; otherwise only the balloon and error actions take clicks.
 * Errors are shown here only when the notch is off (the controller decides).
 */
export interface PushToTalkCompanion {
  show(input: {
    displayId: number;
    cursor: PushToTalkPoint;
    state: PushToTalkTurnState;
  }): void;
  setState(state: PushToTalkTurnState): void;
  /** Whether the shortcut is held; independent of VAD or spoken output. */
  setDrawing(active: boolean): void;
  /** Microphone level 0..1 while listening (~20 Hz). */
  setLevel(level: number): void;
  /** Text of the caption balloon; `null` removes the balloon. */
  setCaption(text: string | null): void;
  /**
   * Fades the companion and the stroke out, then hides the window.
   * `immediate` hides the window now, so a new press's screenshot never
   * shows the previous turn's companion.
   */
  hide(options?: { immediate?: boolean }): void;
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

/** Hold-to-talk shortcut registered in the native side chat helper. */
export interface PushToTalkHotkey {
  /**
   * `null` unregisters. Resolves after the helper confirmed the registration
   * with the Input Monitoring state the chord depends on (`not-needed` for a
   * chord with a regular key, or when cleared).
   */
  register(
    shortcut: PushToTalkShortcutBinding
  ): Promise<{ inputMonitoring: PushToTalkInputMonitoring }>;
  /** Asks macOS for Input Monitoring (shows the system prompt the first time). */
  requestInputMonitoring(): Promise<void>;
  onPressed(
    listener: (event: { frontmostApp: PushToTalkFrontmostApp | null }) => void
  ): () => void;
  /**
   * `cancelled`: another key (or an extra modifier) joined a modifier-only
   * chord, so it was a different shortcut; the turn is dropped silently.
   */
  onReleased(listener: (event: { cancelled: boolean }) => void): () => void;
  /** The Input Monitoring state changed (e.g. granted in System Settings). */
  onInputMonitoring(listener: (state: PushToTalkInputMonitoring) => void): () => void;
  /** The helper process restarted; a held shortcut can no longer be released. */
  onHelperRestarted(listener: () => void): () => void;
}

/**
 * Comma's Screen Recording permission (D11). On macOS 15+ `status` says
 * `denied` also before Comma ever asked, and the capture alone never prompts
 * then; only `request` puts Comma in the Screen Recording list.
 */
export interface PushToTalkScreenRecording {
  /** `systemPreferences.getMediaAccessStatus("screen")`. */
  status(): string;
  /** `CGRequestScreenCaptureAccess` in the side chat helper, on Comma's behalf. */
  request(): Promise<void>;
}

/** Desktop client settings of the feature (fields of commaClientSettings). */
export type PushToTalkSettings = {
  enabled: boolean;
  shortcut: PushToTalkShortcutBinding;
  sendScreen: boolean;
};
