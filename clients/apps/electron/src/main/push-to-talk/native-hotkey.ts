import type { NativeSideChatService } from "../native-side-chat";
import type { PushToTalkHotkey } from "./types";

type PushToTalkHelper = Pick<
  NativeSideChatService,
  | "onPushToTalkHelperRestarted"
  | "onPushToTalkPressed"
  | "onPushToTalkReleased"
  | "updatePushToTalkShortcut"
>;

/** Hold-to-talk chord registered in the Side Chat helper (Carbon hotkey). */
export function createNativePushToTalkHotkey(
  sideChat: PushToTalkHelper
): PushToTalkHotkey {
  return {
    register: (shortcut) => sideChat.updatePushToTalkShortcut(shortcut),
    onPressed: (listener) =>
      sideChat.onPushToTalkPressed(({ frontmostApp }) =>
        listener({
          frontmostApp: frontmostApp
            ? { bundleId: frontmostApp.bundleId ?? null, name: frontmostApp.name }
            : null,
        })
      ),
    onReleased: (listener) => sideChat.onPushToTalkReleased(listener),
    onHelperRestarted: (listener) => sideChat.onPushToTalkHelperRestarted(listener),
  };
}
