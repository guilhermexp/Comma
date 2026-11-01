import type { NativeSideChatService } from "../native-side-chat";
import type { PushToTalkHotkey } from "./types";

type PushToTalkHelper = Pick<
  NativeSideChatService,
  | "onPushToTalkHelperRestarted"
  | "onPushToTalkInputMonitoring"
  | "onPushToTalkPressed"
  | "onPushToTalkReleased"
  | "requestPushToTalkInputMonitoring"
  | "updatePushToTalkShortcut"
>;

/**
 * Hold-to-talk chord registered in the Side Chat helper: a Carbon hotkey for
 * a chord with a regular key, a listen-only event tap for a modifier-only one.
 */
export function createNativePushToTalkHotkey(
  sideChat: PushToTalkHelper
): PushToTalkHotkey {
  return {
    register: (shortcut) => sideChat.updatePushToTalkShortcut(shortcut),
    requestInputMonitoring: () => sideChat.requestPushToTalkInputMonitoring(),
    onPressed: (listener) =>
      sideChat.onPushToTalkPressed(({ frontmostApp }) => {
        listener({
          frontmostApp: frontmostApp
            ? { bundleId: frontmostApp.bundleId ?? null, name: frontmostApp.name }
            : null,
        });
      }),
    onReleased: (listener) =>
      sideChat.onPushToTalkReleased(({ cancelled }) => {
        listener({ cancelled });
      }),
    onInputMonitoring: (listener) => sideChat.onPushToTalkInputMonitoring(listener),
    onHelperRestarted: (listener) => sideChat.onPushToTalkHelperRestarted(listener),
  };
}
