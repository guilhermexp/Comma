import { BrowserWindow } from "electron";
import { configureManagedWindow } from "../managed-window";
import type { WebContentsRegistry } from "../modules/ipc";
import type { NativeSurfaceService } from "../modules/surfaces";
import { createPushToTalkVoiceWindowOptions } from "../window-options";

type PushToTalkVoiceWindowOptions = {
  logger: { error(message: string): void; warn(message: string): void };
  preloadPath: string;
  registry: WebContentsRegistry;
  secure(window: BrowserWindow): void;
  surfaces: NativeSurfaceService;
  url: string;
};

/**
 * The hidden `push-to-talk-voice` renderer that holds the GPT Live voice's
 * WebRTC peer (D12). It is created on demand and kept so later turns skip
 * the load; it is never shown and takes no focus.
 */
export class PushToTalkVoiceWindow {
  readonly #options: PushToTalkVoiceWindowOptions;
  #window: BrowserWindow | undefined;
  #loading: Promise<void> | undefined;

  constructor(options: PushToTalkVoiceWindowOptions) {
    this.#options = options;
  }

  webContents(): BrowserWindow["webContents"] | undefined {
    if (!this.#window || this.#window.isDestroyed()) return undefined;
    return this.#window.webContents;
  }

  open(): Promise<void> {
    if (this.#window && !this.#window.isDestroyed())
      return this.#loading ?? Promise.resolve();
    const window = new BrowserWindow(
      createPushToTalkVoiceWindowOptions({ preloadPath: this.#options.preloadPath })
    );
    this.#window = window;
    window.on("closed", () => {
      if (this.#window !== window) return;
      this.#window = undefined;
      this.#loading = undefined;
    });
    const loading = configureManagedWindow({
      browserWindow: window,
      failureLabel: "push-to-talk voice",
      id: "push-to-talk-voice",
      installWindowSecurity: () => this.#options.secure(window),
      loadUrl: this.#options.url,
      logger: this.#options.logger,
      role: "push-to-talk-voice",
      route: "/push-to-talk-voice",
      showOnReady: false,
      surfaces: this.#options.surfaces,
      webContentsRegistry: this.#options.registry,
    }).catch((error: unknown) => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    });
    this.#loading = loading;
    return loading;
  }

  close() {
    const window = this.#window;
    this.#window = undefined;
    this.#loading = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
