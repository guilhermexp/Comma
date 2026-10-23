// Shared contract of the push-to-talk turn (openspec change
// add-push-to-talk-agent). The controller in this folder drives these
// interfaces; the native hotkey adapter and the overlay window implement them.
import type { SideChatShortcutBinding } from "@comma/native-bridge";

/** App that was frontmost when the shortcut went down. */
export type PushToTalkFrontmostApp = { name: string; bundleId: string | null };

/** Rectangle in DIP points, relative to the captured display's bounds origin. */
export type PushToTalkRect = { x: number; y: number; width: number; height: number };

/** Point in global screen DIP coordinates (Electron `screen` space). */
export type PushToTalkPoint = { x: number; y: number };

export type PushToTalkErrorCode =
  | "microphone_denied"
  | "screen_denied" // the question was sent without the screenshot
  | "transcription_unavailable"
  | "transcription_busy"
  | "transcription_failed"
  | "nothing_heard"
  | "send_failed";

export type PushToTalkPillState =
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "busy" } // a press was ignored because a turn is still running
  | { kind: "error"; code: PushToTalkErrorCode; transcript?: string };

/**
 * The transparent per-display window that hosts the state pill and the
 * drag-to-mark region. `show` is only called after the screenshot was taken.
 * While the pill is `listening` the window accepts mouse drags; in any other
 * state it is click-through except for the pill's own action buttons. Pill
 * actions (open System Settings, open the Meeting settings section, copy the
 * transcript) are handled by the overlay module itself.
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

/** Hold-to-talk shortcut registered in the native side chat helper. */
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
