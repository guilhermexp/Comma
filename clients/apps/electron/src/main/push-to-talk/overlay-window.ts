import { BrowserWindow } from "electron";
import {
  pushToTalkCaptionMaxLength,
  type PushToTalkCompanionState,
  type PushToTalkOverlayAction,
  type PushToTalkOverlayPoint,
  type PushToTalkOverlayState,
} from "@comma/native-bridge";
import { configureManagedWindow } from "../managed-window";
import type { WebContentsRegistry } from "../modules/ipc";
import type { NativeSurfaceService } from "../modules/surfaces";
import { createPushToTalkOverlayWindowOptions } from "../window-options";
import type {
  PushToTalkCompanion,
  PushToTalkErrorAction,
  PushToTalkPoint,
  PushToTalkStroke,
  PushToTalkTurnState,
} from "./types";

type Bounds = { height: number; width: number; x: number; y: number };
type Display = { bounds: Bounds; id: number };

/** The renderer-facing half: generated capabilities call these. */
export interface PushToTalkOverlayProvider {
  overlayState(_input?: void): PushToTalkOverlayState;
  overlayAction(input: { action: PushToTalkOverlayAction }): Promise<void>;
  setInteractive(input: { interactive: boolean }): void;
  setStroke(input: {
    points: ReadonlyArray<PushToTalkOverlayPoint> | null;
    surface: number;
  }): void;
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
  /** The pointer in global screen DIP coordinates. */
  cursorPoint(): PushToTalkPoint;
  displayNearestPoint(point: PushToTalkPoint): Display;
  displays(): ReadonlyArray<Display>;
  logger: { error(message: string): void; warn(message: string): void };
  openExternal(url: string): Promise<void> | void;
  /** Comma Settings → Meeting, where transcription is chosen. */
  openMeetingSettings(): Promise<void> | void;
  publish(state: PushToTalkOverlayState): void;
  /** Asks macOS for Screen Recording on Comma's behalf, so the pane lists Comma. */
  requestScreenRecording(): Promise<void>;
  writeClipboard(text: string): void;
}

const systemSettingsPane = {
  "open-input-monitoring-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  "open-microphone-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "open-screen-recording-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

/** About 60 Hz: the companion keeps up with the pointer. */
export const PUSH_TO_TALK_FOLLOW_INTERVAL_MS = 16;
/** Matches the renderer's fade-out of the companion and the stroke. */
export const PUSH_TO_TALK_HIDE_FADE_MS = 320;

/**
 * One reused, display-sized overlay that draws the cursor companion of the
 * Talk to agent turn. While shown it follows the pointer, moving to the
 * pointer's display. It takes mouse drags only while listening; otherwise it
 * is click-through except where the renderer reports the pointer over the
 * caption balloon or an error action.
 */
export class PushToTalkOverlayWindow
  implements PushToTalkCompanion, PushToTalkOverlayProvider
{
  readonly #options: PushToTalkOverlayOptions;
  readonly #captionListeners = new Set<() => void>();
  readonly #strokeListeners = new Set<(stroke: PushToTalkStroke | null) => void>();
  #display: Display | undefined;
  #follow: ReturnType<typeof setInterval> | undefined;
  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #interactive = false;
  #stroke: PushToTalkStroke | null = null;
  #state: PushToTalkOverlayState = {
    caption: null,
    companion: null,
    cursor: { x: 0, y: 0 },
    hiding: false,
    level: 0,
    revision: 0,
    surface: 0,
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
    state: PushToTalkTurnState;
  }) {
    const displays = this.#options.displays();
    const display = displays.find(({ id }) => id === input.displayId) ?? displays[0];
    if (!display) {
      this.#options.logger.warn("push-to-talk overlay has no display to show on");
      return;
    }
    clearTimeout(this.#hideTimer);
    this.#hideTimer = undefined;
    this.#display = display;
    this.#interactive = false;
    this.#setStroke(null);
    this.#publish({
      caption: null,
      companion: this.#companion(input.state),
      cursor: relative(input.cursor, display.bounds),
      hiding: false,
      level: 0,
      surface: this.#state.surface + 1,
    });
    this.#startFollowing();
    void this.#ensureWindow()
      .then(() => this.#present())
      .catch((error: unknown) =>
        this.#options.logger.error(`push-to-talk overlay failed: ${String(error)}`)
      );
  }

  setState(state: PushToTalkTurnState) {
    // A late state of a finished turn never brings the overlay back.
    if (!this.#shown()) return;
    this.#publish({
      companion: this.#companion(state),
      ...(state.kind === "listening" ? {} : { level: 0 }),
    });
    this.#applyMouse();
  }

  setLevel(level: number) {
    if (!this.#shown() || this.#state.companion?.kind !== "listening") return;
    const next = Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
    if (next !== this.#state.level) this.#publish({ level: next });
  }

  setCaption(text: string | null) {
    if (!this.#shown()) return;
    const caption =
      text !== null && text.length > pushToTalkCaptionMaxLength
        ? `${text.slice(0, pushToTalkCaptionMaxLength - 1)}…`
        : text;
    if (caption !== this.#state.caption) this.#publish({ caption });
  }

  hide(options: { immediate?: boolean } = {}) {
    this.#transcript = undefined;
    if (options.immediate) {
      clearTimeout(this.#hideTimer);
      this.#hideTimer = undefined;
      if (this.#state.companion === null) return;
      this.#interactive = false;
      this.#removeWindow();
      return;
    }
    if (!this.#shown()) return;
    this.#interactive = false;
    this.#publish({ hiding: true });
    this.#applyMouse();
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = undefined;
      this.#removeWindow();
    }, PUSH_TO_TALK_HIDE_FADE_MS);
  }

  /**
   * Runs an error's action, wherever the error was shown (companion or
   * notch). `copy-transcript` copies `transcript`, the failed turn's words.
   */
  async runAction(action: PushToTalkErrorAction, transcript: string | undefined) {
    if (action === "copy-transcript") {
      if (transcript) this.#options.writeClipboard(transcript);
      return;
    }
    if (action === "open-meeting-settings") {
      await this.#options.openMeetingSettings();
      return;
    }
    if (action === "open-screen-recording-settings") {
      await this.#options.requestScreenRecording().catch((error: unknown) => {
        this.#options.logger.warn(
          `Screen Recording request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    await this.#options.openExternal(systemSettingsPane[action]);
  }

  onStroke(listener: (stroke: PushToTalkStroke | null) => void) {
    this.#strokeListeners.add(listener);
    return () => void this.#strokeListeners.delete(listener);
  }

  onCaptionClick(listener: () => void) {
    this.#captionListeners.add(listener);
    return () => void this.#captionListeners.delete(listener);
  }

  overlayState(_input?: void) {
    return structuredClone(this.#state);
  }

  setStroke({
    points,
    surface,
  }: {
    points: ReadonlyArray<PushToTalkOverlayPoint> | null;
    surface: number;
  }) {
    // Drawing happens only while the shortcut is held, on the current surface.
    if (
      surface !== this.#state.surface ||
      !this.#shown() ||
      this.#state.companion?.kind !== "listening"
    )
      return;
    this.#setStroke(
      points && points.length >= 2 ? points.map(({ x, y }) => ({ x, y })) : null
    );
  }

  setInteractive({ interactive }: { interactive: boolean }) {
    if (!this.#shown() || this.#state.companion?.kind === "listening") return;
    this.#interactive = interactive;
    this.#applyMouse();
  }

  async overlayAction({ action }: { action: PushToTalkOverlayAction }) {
    if (action === "caption-click") {
      if (!this.#shown() || this.#state.caption === null) return;
      for (const listener of this.#captionListeners) listener();
      return;
    }
    await this.runAction(action, this.#transcript);
  }

  #shown() {
    return this.#state.companion !== null && !this.#state.hiding;
  }

  #companion(state: PushToTalkTurnState): PushToTalkCompanionState {
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

  #removeWindow() {
    this.#stopFollowing();
    this.#publish({ caption: null, companion: null, hiding: false, level: 0 });
    const window = this.#liveWindow();
    if (!window) return;
    window.setIgnoreMouseEvents(true, { forward: true });
    window.hide();
  }

  #setStroke(stroke: PushToTalkStroke | null) {
    if (stroke === null && this.#stroke === null) return;
    this.#stroke = stroke;
    for (const listener of this.#strokeListeners) listener(stroke);
  }

  #startFollowing() {
    this.#follow ??= setInterval(
      () => this.#followCursor(),
      PUSH_TO_TALK_FOLLOW_INTERVAL_MS
    );
  }

  #stopFollowing() {
    clearInterval(this.#follow);
    this.#follow = undefined;
  }

  #followCursor() {
    const current = this.#display;
    if (!current) return;
    const point = this.#options.cursorPoint();
    const display = this.#options.displayNearestPoint(point);
    if (display.id !== current.id) {
      // A stroke drawn on another display would not match the screenshot.
      this.#display = display;
      this.#interactive = false;
      this.#setStroke(null);
      this.#liveWindow()?.setBounds(display.bounds);
      this.#applyMouse();
      this.#publish({
        cursor: relative(point, display.bounds),
        surface: this.#state.surface + 1,
      });
      return;
    }
    const cursor = relative(point, display.bounds);
    if (cursor.x !== this.#state.cursor.x || cursor.y !== this.#state.cursor.y)
      this.#publish({ cursor });
  }

  #ensureWindow() {
    const window = this.#liveWindow();
    if (window) return Promise.resolve(window);
    this.#windowPromise ??= this.#options
      .createWindow(this.#display!.bounds)
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
    if (!window || !this.#shown() || !this.#display) return;
    window.setBounds(this.#display.bounds);
    this.#applyMouse();
    window.showInactive();
  }

  #applyMouse() {
    const takesMouse =
      this.#shown() &&
      (this.#state.companion?.kind === "listening" || this.#interactive);
    this.#liveWindow()?.setIgnoreMouseEvents(!takesMouse, { forward: true });
  }

  #liveWindow() {
    const window = this.#window;
    return window && !window.isDestroyed() ? window : undefined;
  }
}

function relative(point: PushToTalkPoint, bounds: Bounds): PushToTalkOverlayPoint {
  return { x: point.x - bounds.x, y: point.y - bounds.y };
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
