import { BrowserWindow } from "electron";
import type {
  PushToTalkOverlayAction,
  PushToTalkOverlayPill,
  PushToTalkOverlayRect,
  PushToTalkOverlayState,
} from "@comma/native-bridge";
import { configureManagedWindow } from "../managed-window";
import type { WebContentsRegistry } from "../modules/ipc";
import type { NativeSurfaceService } from "../modules/surfaces";
import { createPushToTalkOverlayWindowOptions } from "../window-options";
import type {
  PushToTalkOverlay,
  PushToTalkPillState,
  PushToTalkPoint,
  PushToTalkRect,
} from "./types";

type Bounds = { height: number; width: number; x: number; y: number };

/** The renderer-facing half: generated capabilities call these. */
export interface PushToTalkOverlayProvider {
  overlayState(_input?: void): PushToTalkOverlayState;
  overlayAction(input: { action: PushToTalkOverlayAction }): Promise<void>;
  setInteractive(input: { interactive: boolean }): void;
  setRegion(input: { rect: PushToTalkOverlayRect | null; turn: number }): void;
}

export interface PushToTalkOverlayBrowserWindow {
  hide(): void;
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): void;
  setAlwaysOnTop(flag: boolean, level: "screen-saver"): void;
  setBounds(bounds: Bounds): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  setVisibleOnAllWorkspaces(
    flag: boolean,
    options: { skipTransformProcessType: boolean; visibleOnFullScreen: boolean }
  ): void;
  showInactive(): void;
}

interface PushToTalkOverlayOptions {
  /** Creates the window on the given bounds and resolves once it is loaded. */
  createWindow(bounds: Bounds): Promise<PushToTalkOverlayBrowserWindow>;
  displays(): ReadonlyArray<{ bounds: Bounds; id: number }>;
  logger: { error(message: string): void; warn(message: string): void };
  openExternal(url: string): Promise<void> | void;
  /** Comma Settings → Meeting, where transcription is chosen. */
  openMeetingSettings(): Promise<void> | void;
  publish(state: PushToTalkOverlayState): void;
  writeClipboard(text: string): void;
}

const systemSettingsPane = {
  "open-microphone-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "open-screen-recording-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

/** Smaller than this, a press without a real drag: it clears the area. */
const MIN_REGION_SIZE = 4;

/**
 * One reused, display-sized overlay for the Talk to agent turn. It takes mouse
 * drags only while the pill is listening; otherwise it is click-through except
 * where the renderer reports the pointer over the pill's own buttons.
 */
export class PushToTalkOverlayWindow
  implements PushToTalkOverlay, PushToTalkOverlayProvider
{
  readonly #options: PushToTalkOverlayOptions;
  readonly #regionListeners = new Set<(rect: PushToTalkRect | null) => void>();
  #display: Bounds | undefined;
  #region: PushToTalkRect | null = null;
  #state: PushToTalkOverlayState = {
    anchor: { x: 0, y: 0 },
    pill: null,
    revision: 0,
    turn: 0,
  };
  #transcript: string | undefined;
  #window: PushToTalkOverlayBrowserWindow | undefined;
  #windowPromise: Promise<PushToTalkOverlayBrowserWindow> | undefined;

  constructor(options: PushToTalkOverlayOptions) {
    this.#options = options;
  }

  show(input: {
    displayId: number;
    cursor: PushToTalkPoint;
    state: PushToTalkPillState;
  }) {
    const displays = this.#options.displays();
    const display =
      displays.find(({ id }) => id === input.displayId)?.bounds ?? displays[0]?.bounds;
    if (!display) {
      this.#options.logger.warn("push-to-talk overlay has no display to show on");
      return;
    }
    this.#display = display;
    this.#setRegion(null);
    this.#publish({
      anchor: { x: input.cursor.x - display.x, y: input.cursor.y - display.y },
      pill: this.#pill(input.state),
      turn: this.#state.turn + 1,
    });
    void this.#ensureWindow()
      .then(() => this.#present())
      .catch((error: unknown) =>
        this.#options.logger.error(`push-to-talk overlay failed: ${String(error)}`)
      );
  }

  setState(state: PushToTalkPillState) {
    // A late state of a finished turn never brings the overlay back.
    if (!this.#state.pill) return;
    this.#publish({ pill: this.#pill(state) });
    this.#applyMouse();
  }

  hide() {
    this.#transcript = undefined;
    this.#publish({ pill: null });
    const window = this.#liveWindow();
    if (!window) return;
    window.setIgnoreMouseEvents(true, { forward: true });
    window.hide();
  }

  onRegion(listener: (rect: PushToTalkRect | null) => void) {
    this.#regionListeners.add(listener);
    return () => void this.#regionListeners.delete(listener);
  }

  overlayState(_input?: void) {
    return structuredClone(this.#state);
  }

  setRegion({ rect, turn }: { rect: PushToTalkOverlayRect | null; turn: number }) {
    // Marking happens only while the shortcut is held, in the current turn.
    if (turn !== this.#state.turn || this.#state.pill?.kind !== "listening") return;
    this.#setRegion(rect && this.#display ? clampRegion(rect, this.#display) : null);
  }

  setInteractive({ interactive }: { interactive: boolean }) {
    if (this.#state.pill?.kind === "listening" || !this.#state.pill) return;
    this.#liveWindow()?.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  async overlayAction({ action }: { action: PushToTalkOverlayAction }) {
    if (action === "copy-transcript") {
      if (this.#transcript) this.#options.writeClipboard(this.#transcript);
      return;
    }
    if (action === "open-meeting-settings") {
      await this.#options.openMeetingSettings();
      return;
    }
    await this.#options.openExternal(systemSettingsPane[action]);
  }

  #pill(state: PushToTalkPillState): PushToTalkOverlayPill {
    if (state.kind !== "error") {
      this.#transcript = undefined;
      return { kind: state.kind };
    }
    this.#transcript = state.transcript || undefined;
    return {
      code: state.code,
      kind: "error",
      transcriptAvailable: Boolean(this.#transcript),
    };
  }

  #publish(patch: Partial<Omit<PushToTalkOverlayState, "revision">>) {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 };
    this.#options.publish(this.overlayState());
  }

  #setRegion(rect: PushToTalkRect | null) {
    if (rect === null && this.#region === null) return;
    this.#region = rect;
    for (const listener of this.#regionListeners) listener(rect);
  }

  #ensureWindow() {
    const window = this.#liveWindow();
    if (window) return Promise.resolve(window);
    this.#windowPromise ??= this.#options
      .createWindow(this.#display!)
      .then((created) => {
        created.setAlwaysOnTop(true, "screen-saver");
        // Keep the app's Dock preference while the overlay joins every Space.
        created.setVisibleOnAllWorkspaces(true, {
          skipTransformProcessType: true,
          visibleOnFullScreen: true,
        });
        created.on("closed", () => {
          if (this.#window === created) this.#window = undefined;
        });
        this.#window = created;
        return created;
      })
      .finally(() => {
        this.#windowPromise = undefined;
      });
    return this.#windowPromise;
  }

  #present() {
    const window = this.#liveWindow();
    if (!window || !this.#state.pill || !this.#display) return;
    window.setBounds(this.#display);
    this.#applyMouse();
    window.showInactive();
  }

  #applyMouse() {
    this.#liveWindow()?.setIgnoreMouseEvents(this.#state.pill?.kind !== "listening", {
      forward: true,
    });
  }

  #liveWindow() {
    const window = this.#window;
    return window && !window.isDestroyed() ? window : undefined;
  }
}

function clampRegion(
  rect: PushToTalkOverlayRect,
  display: Bounds
): PushToTalkRect | null {
  const left = Math.max(0, Math.min(display.width, rect.x));
  const top = Math.max(0, Math.min(display.height, rect.y));
  const right = Math.max(0, Math.min(display.width, rect.x + rect.width));
  const bottom = Math.max(0, Math.min(display.height, rect.y + rect.height));
  const width = right - left;
  const height = bottom - top;
  if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) return null;
  return { height, width, x: left, y: top };
}

/** Production window: a managed, sandboxed renderer on the overlay route. */
export function createElectronPushToTalkOverlayWindowFactory(options: {
  logger: { error(message: string): void; warn(message: string): void };
  preloadPath: string;
  registry: WebContentsRegistry;
  secure(window: BrowserWindow): void;
  surfaces: NativeSurfaceService;
  url: string;
}) {
  return async (bounds: Bounds): Promise<PushToTalkOverlayBrowserWindow> => {
    const window = new BrowserWindow(
      createPushToTalkOverlayWindowOptions({ bounds, preloadPath: options.preloadPath })
    );
    window.setIgnoreMouseEvents(true, { forward: true });
    try {
      await configureManagedWindow({
        browserWindow: window,
        failureLabel: "push-to-talk overlay",
        id: "push-to-talk-overlay",
        installWindowSecurity: () => options.secure(window),
        loadUrl: options.url,
        logger: options.logger,
        role: "push-to-talk-overlay",
        route: "/push-to-talk-overlay",
        showOnReady: false,
        surfaces: options.surfaces,
        webContentsRegistry: options.registry,
      });
      if (window.webContents.isLoading()) {
        await new Promise<void>((resolve, reject) => {
          window.webContents.once("did-finish-load", () => resolve());
          window.webContents.once("did-fail-load", (_event, _code, description) =>
            reject(new Error(description))
          );
        });
      }
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    return window;
  };
}
