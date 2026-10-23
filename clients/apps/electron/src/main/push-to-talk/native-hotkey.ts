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
 * `log` hears each confirmed registration, press and release.
 */
export function createNativePushToTalkHotkey(
  sideChat: PushToTalkHelper,
  options: { log?: (message: string) => void } = {}
): PushToTalkHotkey {
  const log = options.log ?? (() => undefined);
  return {
    register: async (shortcut) => {
      const result = await sideChat.updatePushToTalkShortcut(shortcut);
      log(
        shortcut
          ? `push-to-talk shortcut registered: ${JSON.stringify(shortcut)} (input monitoring ${result.inputMonitoring})`
          : "push-to-talk shortcut cleared"
      );
      return result;
    },
    requestInputMonitoring: () => sideChat.requestPushToTalkInputMonitoring(),
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
      sideChat.onPushToTalkReleased(({ cancelled }) => {
        log(cancelled ? "push-to-talk cancelled" : "push-to-talk released");
        listener({ cancelled });
      }),
    onInputMonitoring: (listener) =>
      sideChat.onPushToTalkInputMonitoring((state) => {
        log(`push-to-talk input monitoring ${state}`);
        listener(state);
      }),
    onHelperRestarted: (listener) => sideChat.onPushToTalkHelperRestarted(listener),
  };
}
