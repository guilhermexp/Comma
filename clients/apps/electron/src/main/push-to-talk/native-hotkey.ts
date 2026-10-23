import type { NativeSideChatService } from "../native-side-chat";
import type { PushToTalkHotkey } from "./types";

type PushToTalkHelper = Pick<
  NativeSideChatService,
  | "onPushToTalkHelperRestarted"
  | "onPushToTalkPressed"
  | "onPushToTalkReleased"
  | "updatePushToTalkShortcut"
>;

/**
 * Hold-to-talk chord registered in the Side Chat helper (Carbon hotkey).
 * `log` hears each confirmed registration, press and release.
 */
export function createNativePushToTalkHotkey(
  sideChat: PushToTalkHelper,
  options: { log?: (message: string) => void } = {}
): PushToTalkHotkey {
  const log = options.log ?? (() => undefined);
  return {
    register: async (shortcut) => {
      await sideChat.updatePushToTalkShortcut(shortcut);
      log(
        shortcut
          ? `push-to-talk shortcut registered: ${JSON.stringify(shortcut)}`
          : "push-to-talk shortcut cleared"
      );
    },
    onPressed: (listener) =>
      sideChat.onPushToTalkPressed(({ frontmostApp }) => {
        log("push-to-talk pressed");
        listener({
          frontmostApp: frontmostApp
            ? { bundleId: frontmostApp.bundleId ?? null, name: frontmostApp.name }
            : null,
        });
      }),
    onReleased: (listener) =>
      sideChat.onPushToTalkReleased(() => {
        log("push-to-talk released");
        listener();
      }),
    onHelperRestarted: (listener) => sideChat.onPushToTalkHelperRestarted(listener),
  };
}
