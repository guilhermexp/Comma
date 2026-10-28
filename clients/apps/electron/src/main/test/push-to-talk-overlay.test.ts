import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushToTalkOverlayState } from "@comma/native-bridge";
import {
  PUSH_TO_TALK_FOLLOW_INTERVAL_MS,
  PUSH_TO_TALK_HIDE_FADE_MS,
  PushToTalkOverlayWindow,
  type PushToTalkOverlayBrowserWindow,
} from "../push-to-talk/overlay-window";

vi.mock("electron", () => ({}));

const primary = { bounds: { height: 1117, width: 1728, x: 0, y: 0 }, id: 1 };
// A 2x display to the right of the primary one, slightly higher.
const secondary = { bounds: { height: 1080, width: 1920, x: 1728, y: -200 }, id: 2 };

function createOverlay() {
  const windows: FakeWindow[] = [];
  const published: PushToTalkOverlayState[] = [];
  const calls: string[] = [];
  const openExternal = vi.fn((url: string) => void calls.push(`open ${url}`));
  const requestScreenRecording = vi.fn(
    async () => void calls.push("request screen recording")
  );
  const openMeetingSettings = vi.fn();
  const writeClipboard = vi.fn();
  let cursor = { x: 0, y: 0 };
  const cursorPoint = vi.fn(() => cursor);
  const overlay = new PushToTalkOverlayWindow({
    createWindow: async (bounds) => {
      const window = new FakeWindow(bounds);
      windows.push(window);
      return window;
    },
    cursorPoint,
    displayNearestPoint: ({ x }) => (x >= secondary.bounds.x ? secondary : primary),
    displays: () => [primary, secondary],
    logger: { error: vi.fn(), warn: vi.fn() },
    openExternal,
    openMeetingSettings,
    publish: (state) => published.push(state),
    requestScreenRecording,
    writeClipboard,
  });
  return {
    calls,
    cursorPoint,
    latest: () => published.at(-1)!,
    moveCursor: (point: { x: number; y: number }) => {
      cursor = point;
      vi.advanceTimersByTime(PUSH_TO_TALK_FOLLOW_INTERVAL_MS);
    },
    openExternal,
    openMeetingSettings,
    overlay,
    published,
    requestScreenRecording,
    window: () => windows[0]!,
    windows,
    writeClipboard,
  };
}

/** Lets the window factory's promise resolve. */
const settle = () => vi.advanceTimersByTimeAsync(0);

async function showListening(
  setup: ReturnType<typeof createOverlay>,
  cursor = { x: 2_000, y: 100 }
) {
  setup.moveCursor(cursor);
  setup.overlay.show({
    cursor,
    displayId: cursor.x >= secondary.bounds.x ? 2 : 1,
    state: { kind: "listening" },
  });
  await settle();
}

describe("PushToTalkOverlayWindow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("covers the cursor's display without focus, above full-screen apps, and takes drags only while listening", async () => {
    const setup = createOverlay();
    const { latest, overlay, window, windows } = setup;
    await showListening(setup);

    expect(window().bounds).toEqual(secondary.bounds);
    expect(window().calls).toEqual(
      expect.arrayContaining([
        ["setAlwaysOnTop", true, "screen-saver"],
        [
          "setVisibleOnAllWorkspaces",
          true,
          { skipTransformProcessType: true, visibleOnFullScreen: true },
        ],
        ["showInactive"],
      ])
    );
    expect(window().calls).not.toContainEqual(["focus"]);
    expect(window().ignoringMouse).toBe(false);
    // The companion starts at the pointer, in the overlay's own coordinates.
    expect(latest()).toMatchObject({
      companion: { kind: "listening" },
      cursor: { x: 272, y: 300 },
      hiding: false,
    });

    overlay.setState({ kind: "thinking" });
    expect(window().ignoringMouse).toBe(true);
    expect(latest().companion).toEqual({ kind: "thinking" });

    // The next turn on the primary display reuses the same window.
    overlay.hide();
    vi.advanceTimersByTime(PUSH_TO_TALK_HIDE_FADE_MS);
    await showListening(setup, { x: 10, y: 10 });
    expect(windows).toHaveLength(1);
    expect(window().bounds).toEqual(primary.bounds);
  });

  it("follows the cursor only while shown and moves to the cursor's display", async () => {
    const setup = createOverlay();
    const { cursorPoint, latest, moveCursor, overlay, window } = setup;
    // Nothing polls the cursor between turns.
    vi.advanceTimersByTime(1_000);
    expect(cursorPoint).not.toHaveBeenCalled();

    await showListening(setup);
    const { surface } = latest();
    moveCursor({ x: 2_100, y: 150 });
    expect(latest().cursor).toEqual({ x: 372, y: 350 });
    // An unchanged pointer publishes nothing.
    const count = setup.published.length;
    moveCursor({ x: 2_100, y: 150 });
    expect(setup.published).toHaveLength(count);

    // Onto the primary display: the window follows and starts a new surface.
    moveCursor({ x: 300, y: 40 });
    expect(window().bounds).toEqual(primary.bounds);
    expect(latest()).toMatchObject({
      companion: { kind: "listening" },
      cursor: { x: 300, y: 40 },
      surface: surface + 1,
    });

    overlay.hide();
    vi.advanceTimersByTime(PUSH_TO_TALK_HIDE_FADE_MS);
    cursorPoint.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(cursorPoint).not.toHaveBeenCalled();
  });

  it("is click-through outside listening except while the pointer is over the balloon", async () => {
    const setup = createOverlay();
    const { overlay, window } = setup;
    await showListening(setup);
    // While listening the whole display takes the drag.
    overlay.setInteractive({ interactive: false });
    expect(window().ignoringMouse).toBe(false);

    overlay.setState({ kind: "speaking" });
    overlay.setCaption("The chart peaks in March.");
    expect(window().ignoringMouse).toBe(true);
    overlay.setInteractive({ interactive: true });
    expect(window().ignoringMouse).toBe(false);
    overlay.setInteractive({ interactive: false });
    expect(window().ignoringMouse).toBe(true);

    // Fading out: nothing takes clicks any more.
    overlay.setInteractive({ interactive: true });
    overlay.hide();
    expect(window().ignoringMouse).toBe(true);
    overlay.setInteractive({ interactive: true });
    expect(window().ignoringMouse).toBe(true);
  });

  it("reports the latest stroke of the current surface while listening", async () => {
    const setup = createOverlay();
    const { latest, moveCursor, overlay } = setup;
    const strokes: unknown[] = [];
    overlay.onStroke((stroke) => strokes.push(stroke));
    await showListening(setup);
    const { surface } = latest();

    const circle = [
      { x: 10, y: 20 },
      { x: 60, y: 25 },
      { x: 40, y: 70 },
    ];
    overlay.setStroke({ points: circle, surface });
    // A new drag replaces the previous stroke.
    overlay.setStroke({
      points: [
        { x: 5, y: 5 },
        { x: 90, y: 90 },
      ],
      surface,
    });
    // Drawn on an older surface: ignored.
    overlay.setStroke({ points: circle, surface: surface - 1 });
    expect(strokes).toEqual([
      circle,
      [
        { x: 5, y: 5 },
        { x: 90, y: 90 },
      ],
    ]);

    // A click without a drag clears it.
    overlay.setStroke({ points: [{ x: 1, y: 1 }], surface });
    expect(strokes.at(-1)).toBeNull();

    // Another display is another surface: strokes on display B must be rejected,
    // preserving the captured display A association. Moving back to A allows strokes again.
    overlay.setStroke({ points: circle, surface });
    moveCursor({ x: 300, y: 300 }); // moves to primary (display 1) while capture was on secondary (display 2)
    expect(strokes.at(-1)).toBeNull();
    // Attempting to draw on display B's new surface is rejected.
    overlay.setStroke({ points: circle, surface: latest().surface });
    expect(strokes.at(-1)).toBeNull();
    // Moving cursor back to display A (secondary) restores the ability to stroke on A.
    moveCursor({ x: 2_000, y: 100 });
    overlay.setStroke({ points: circle, surface: latest().surface });
    expect(strokes.at(-1)).toEqual(circle);

    // Once the shortcut is released the stroke is final.
    overlay.setState({ kind: "transcribing" });
    overlay.setStroke({
      points: [
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ],
      surface: latest().surface,
    });
    expect(strokes.at(-1)).toEqual(circle);
    // The next turn starts without a stroke.
    overlay.hide();
    await showListening(setup, { x: 1, y: 1 });
    expect(strokes.at(-1)).toBeNull();
  });

  it("rejects strokes on the fallback display when the captured monitor is no longer available", async () => {
    const { overlay, latest, window } = createOverlay();
    const strokes: unknown[] = [];
    overlay.onStroke((stroke) => strokes.push(stroke));
    overlay.show({
      displayId: 99,
      cursor: { x: 100, y: 100 },
      state: { kind: "listening" },
    });
    await settle();
    expect(window().bounds).toEqual(primary.bounds);
    overlay.setStroke({
      points: [
        { x: 10, y: 20 },
        { x: 50, y: 60 },
      ],
      surface: latest().surface,
    });
    expect(strokes).toEqual([]);
  });

  it("shows the level only while listening and the caption until it is removed", async () => {
    const setup = createOverlay();
    const { latest, overlay } = setup;
    await showListening(setup);

    overlay.setLevel(0.42);
    expect(latest().level).toBe(0.42);
    overlay.setLevel(3);
    expect(latest().level).toBe(1);

    overlay.setState({ kind: "thinking" });
    expect(latest().level).toBe(0);
    const count = setup.published.length;
    overlay.setLevel(0.5);
    expect(setup.published).toHaveLength(count);

    overlay.setState({ kind: "speaking" });
    overlay.setCaption("It peaks in March.");
    expect(latest().caption).toBe("It peaks in March.");
    overlay.setCaption("x".repeat(10_000));
    expect(latest().caption).toHaveLength(4_000);
    expect(latest().caption!.endsWith("…")).toBe(true);
    overlay.setCaption(null);
    expect(latest().caption).toBeNull();

    // A new turn starts without the previous caption.
    overlay.setCaption("Old answer.");
    overlay.hide();
    await showListening(setup);
    expect(latest()).toMatchObject({ caption: null, level: 0 });
  });

  it("tells the turn when the balloon is clicked, only while it is on screen", async () => {
    const setup = createOverlay();
    const { overlay } = setup;
    const clicked = vi.fn();
    const stop = overlay.onCaptionClick(clicked);
    await showListening(setup);
    overlay.setState({ kind: "speaking" });
    overlay.setCaption("It peaks in March.");

    await overlay.overlayAction({ action: "caption-click" });
    expect(clicked).toHaveBeenCalledOnce();

    overlay.hide();
    await overlay.overlayAction({ action: "caption-click" });
    expect(clicked).toHaveBeenCalledOnce();

    await showListening(setup);
    stop();
    await overlay.overlayAction({ action: "caption-click" });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("fades out before it hides and leaves nothing on screen between turns", async () => {
    const setup = createOverlay();
    const { latest, overlay, window } = setup;
    await showListening(setup);
    overlay.setState({ kind: "speaking" });
    overlay.setCaption("Done.");

    overlay.hide();
    // The companion, its balloon and the stroke fade where they are.
    expect(latest()).toMatchObject({
      caption: "Done.",
      companion: { kind: "speaking" },
      hiding: true,
    });
    expect(window().visible).toBe(true);
    expect(window().ignoringMouse).toBe(true);
    // A late state of the finished turn does not bring it back.
    overlay.setState({ kind: "busy" });
    expect(latest().companion).toEqual({ kind: "speaking" });

    vi.advanceTimersByTime(PUSH_TO_TALK_HIDE_FADE_MS);
    expect(window().visible).toBe(false);
    expect(latest()).toMatchObject({ caption: null, companion: null, hiding: false });
    overlay.setState({ kind: "busy" });
    expect(latest().companion).toBeNull();
    expect(window().visible).toBe(false);
  });

  it("a turn shown while the last one fades out stays on screen", async () => {
    const setup = createOverlay();
    const { latest, overlay, window } = setup;
    await showListening(setup);
    overlay.hide();
    await showListening(setup);
    vi.advanceTimersByTime(PUSH_TO_TALK_HIDE_FADE_MS * 2);
    expect(window().visible).toBe(true);
    expect(latest()).toMatchObject({ companion: { kind: "listening" }, hiding: false });
  });

  it("runs the error actions and copies only the failed turn's transcript", async () => {
    const setup = createOverlay();
    const { latest, openExternal, openMeetingSettings, overlay, writeClipboard } =
      setup;
    overlay.show({
      cursor: { x: 5, y: 5 },
      displayId: 1,
      state: { code: "send_failed", kind: "error", transcript: "what is this?" },
    });
    await settle();
    expect(latest().companion).toEqual({
      code: "send_failed",
      kind: "error",
      transcriptAvailable: true,
    });
    // The transcript itself never reaches the overlay renderer.
    expect(JSON.stringify(latest())).not.toContain("what is this?");

    await overlay.overlayAction({ action: "copy-transcript" });
    expect(writeClipboard).toHaveBeenCalledWith("what is this?");
    await overlay.overlayAction({ action: "open-microphone-settings" });
    await overlay.overlayAction({ action: "open-screen-recording-settings" });
    expect(openExternal.mock.calls).toEqual([
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"],
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
    ]);
    await overlay.overlayAction({ action: "open-meeting-settings" });
    expect(openMeetingSettings).toHaveBeenCalledOnce();

    overlay.setState({ code: "nothing_heard", kind: "error" });
    await overlay.overlayAction({ action: "copy-transcript" });
    expect(writeClipboard).toHaveBeenCalledOnce();
  });

  // Errors shown in the Notch reuse the same actions, Input Monitoring included.
  it("runs a Notch error's action with that error's transcript", async () => {
    const { openExternal, overlay, writeClipboard } = createOverlay();
    await overlay.runAction("open-input-monitoring-settings", undefined);
    expect(openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
    );
    await overlay.runAction("copy-transcript", "from the notch");
    expect(writeClipboard).toHaveBeenCalledWith("from the notch");
  });

  // Gravação de Tela: the request puts Comma in the list the pane shows.
  it("asks for Screen Recording before opening its pane, and opens it if the request fails", async () => {
    const { calls, overlay, requestScreenRecording } = createOverlay();
    await overlay.runAction("open-screen-recording-settings", undefined);
    expect(calls).toEqual([
      "request screen recording",
      "open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);

    requestScreenRecording.mockRejectedValueOnce(new Error("helper lost"));
    await overlay.runAction("open-screen-recording-settings", undefined);
    expect(calls.at(-1)).toBe(
      "open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
    await overlay.runAction("open-microphone-settings", undefined);
    expect(requestScreenRecording).toHaveBeenCalledTimes(2);
  });

  // Interromper a leitura: the next press's screenshot never shows this turn.
  it("hides at once, without the fade, for a new press", async () => {
    const setup = createOverlay();
    const { latest, overlay, window } = setup;
    await showListening(setup);
    overlay.setCaption("Reading this.");
    overlay.hide({ immediate: true });
    expect(window().visible).toBe(false);
    expect(window().ignoringMouse).toBe(true);
    expect(latest()).toMatchObject({ caption: null, companion: null, hiding: false });

    // Also in the middle of a fade.
    await showListening(setup);
    overlay.hide();
    overlay.hide({ immediate: true });
    expect(window().visible).toBe(false);
    await showListening(setup);
    vi.advanceTimersByTime(PUSH_TO_TALK_HIDE_FADE_MS * 2);
    expect(window().visible).toBe(true);
  });
});

class FakeWindow implements PushToTalkOverlayBrowserWindow {
  bounds: { height: number; width: number; x: number; y: number };
  calls: unknown[][] = [];
  destroyed = false;
  ignoringMouse = true;
  visible = false;

  constructor(bounds: FakeWindow["bounds"]) {
    this.bounds = bounds;
  }

  hide() {
    this.calls.push(["hide"]);
    this.visible = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  on() {}

  setAlwaysOnTop(flag: boolean, level: "screen-saver") {
    this.calls.push(["setAlwaysOnTop", flag, level]);
  }

  setBounds(bounds: FakeWindow["bounds"]) {
    this.bounds = bounds;
  }

  setIgnoreMouseEvents(ignore: boolean) {
    this.ignoringMouse = ignore;
  }

  setVisibleOnAllWorkspaces(
    flag: boolean,
    options: { skipTransformProcessType: boolean; visibleOnFullScreen: boolean }
  ) {
    this.calls.push(["setVisibleOnAllWorkspaces", flag, options]);
  }

  showInactive() {
    this.calls.push(["showInactive"]);
    this.visible = true;
  }
}
