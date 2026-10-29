import {
  defaultCommaClientSettings,
  type CommaClientSettings,
} from "@comma/native-bridge";
import type { PushToTalkController } from "./controller";
import type {
  PushToTalkHotkey,
  PushToTalkInputMonitoring,
  PushToTalkSettings,
} from "./types";

/** What decides whether the hold-to-talk shortcut is registered. */
export type PushToTalkRuntimeInputs = {
  clientSettings: CommaClientSettings | undefined;
  sideChatEnabled: boolean;
  signedIn: boolean;
  sessionGeneration: number;
};

/** Talk to agent needs its own switch, Side Chat on and an open session. */
export function effectivePushToTalkSettings({
  clientSettings,
  sideChatEnabled,
  signedIn,
}: PushToTalkRuntimeInputs): PushToTalkSettings {
  const settings = clientSettings ?? defaultCommaClientSettings;
  return {
    enabled: settings.pushToTalkEnabled && sideChatEnabled && signedIn,
    shortcut: settings.pushToTalkShortcut,
    sendScreen: settings.pushToTalkSendScreen,
  };
}

/**
 * Owns the macOS push-to-talk controller in Main: creates it from the
 * current preferences and session, and applies every later change without a
 * restart (D8). Main calls `refresh` when preferences or the session change.
 */
export class PushToTalkRuntime {
  readonly #read: () => PushToTalkRuntimeInputs;
  readonly #createController: (
    settings: PushToTalkSettings,
    sessionGeneration: number
  ) => Pick<PushToTalkController, "dispose" | "start" | "update">;
  #controller: Pick<PushToTalkController, "dispose" | "start" | "update"> | undefined;
  #applied: string | undefined;

  constructor(options: {
    read: () => PushToTalkRuntimeInputs;
    createController: (
      settings: PushToTalkSettings,
      sessionGeneration: number
    ) => Pick<PushToTalkController, "dispose" | "start" | "update">;
  }) {
    this.#read = options.read;
    this.#createController = options.createController;
  }

  start() {
    if (this.#controller) return;
    const inputs = this.#read();
    const settings = effectivePushToTalkSettings(inputs);
    this.#applied = JSON.stringify([settings, inputs.sessionGeneration]);
    this.#controller = this.#createController(settings, inputs.sessionGeneration);
    this.#controller.start();
  }

  refresh() {
    if (!this.#controller) return;
    const inputs = this.#read();
    const settings = effectivePushToTalkSettings(inputs);
    const applied = JSON.stringify([settings, inputs.sessionGeneration]);
    if (applied === this.#applied) return;
    this.#applied = applied;
    this.#controller.update(settings, inputs.sessionGeneration);
  }

  dispose() {
    this.#controller?.dispose();
    this.#controller = undefined;
  }
}

/**
 * Passes every Input Monitoring state the hotkey learns, at registration and
 * on later helper reports, to `report` (Main publishes it to Settings).
 */
export function reportPushToTalkInputMonitoring(
  hotkey: PushToTalkHotkey,
  report: (state: PushToTalkInputMonitoring) => void
): PushToTalkHotkey {
  hotkey.onInputMonitoring(report);
  return {
    register: async (shortcut) => {
      const result = await hotkey.register(shortcut);
      report(result.inputMonitoring);
      return result;
    },
    requestInputMonitoring: () => hotkey.requestInputMonitoring(),
    onPressed: (listener) => hotkey.onPressed(listener),
    onReleased: (listener) => hotkey.onReleased(listener),
    onInputMonitoring: (listener) => hotkey.onInputMonitoring(listener),
    onHelperRestarted: (listener) => hotkey.onHelperRestarted(listener),
  };
}
