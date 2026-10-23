import { describe, expect, it, vi } from "vitest";
import type { PushToTalkOverlayState } from "@comma/native-bridge";
import {
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
  const openExternal = vi.fn();
  const openMeetingSettings = vi.fn();
  const writeClipboard = vi.fn();
  const overlay = new PushToTalkOverlayWindow({
    createWindow: async (bounds) => {
      const window = new FakeWindow(bounds);
      windows.push(window);
      return window;
    },
    displays: () => [primary, secondary],
    logger: { error: vi.fn(), warn: vi.fn() },
    openExternal,
    openMeetingSettings,
    publish: (state) => published.push(state),
    writeClipboard,
  });
  const latest = () => published.at(-1)!;
  return {
    latest,
    openExternal,
    openMeetingSettings,
    overlay,
    published,
    window: () => windows[0]!,
    windows,
    writeClipboard,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PushToTalkOverlayWindow", () => {
  it("covers the cursor's display without focus, above full-screen apps, and takes drags only while listening", async () => {
    const { latest, overlay, window, windows } = createOverlay();
    overlay.show({
      cursor: { x: 2_000, y: 100 },
      displayId: 2,
      state: { kind: "listening" },
    });
    await settle();

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
    // The pill is anchored at the pointer, in the overlay's own coordinates.
    expect(latest()).toMatchObject({
      anchor: { x: 272, y: 300 },
      pill: { kind: "listening" },
    });

    overlay.setState({ kind: "transcribing" });
    expect(window().ignoringMouse).toBe(true);
    expect(latest().pill).toEqual({ kind: "transcribing" });

    // The next turn on the primary display reuses the same window.
    overlay.show({
      cursor: { x: 10, y: 10 },
      displayId: 1,
      state: { kind: "listening" },
    });
    await settle();
    expect(windows).toHaveLength(1);
    expect(window().bounds).toEqual(primary.bounds);
  });

  it("reports the latest marked area of the current turn, clamped to the display", async () => {
    const { latest, overlay } = createOverlay();
    const regions: unknown[] = [];
    overlay.onRegion((rect) => regions.push(rect));
    overlay.show({
      cursor: { x: 2_000, y: 0 },
      displayId: 2,
      state: { kind: "listening" },
    });
    await settle();
    const { turn } = latest();

    overlay.setRegion({ rect: { height: 50, width: 80, x: 10, y: 20 }, turn });
    // A new drag replaces the previous area; one past the edge stops at it.
    overlay.setRegion({ rect: { height: 400, width: 300, x: 1_800, y: -30 }, turn });
    // From an older turn: ignored.
    overlay.setRegion({ rect: { height: 5, width: 5, x: 0, y: 0 }, turn: turn - 1 });
    expect(regions).toEqual([
      { height: 50, width: 80, x: 10, y: 20 },
      { height: 370, width: 120, x: 1_800, y: 0 },
    ]);

    // A click without a drag clears the area.
    overlay.setRegion({ rect: { height: 1, width: 2, x: 400, y: 400 }, turn });
    expect(regions.at(-1)).toBeNull();

    overlay.setRegion({ rect: { height: 50, width: 80, x: 10, y: 20 }, turn });
    // Once the shortcut is released the area is final.
    overlay.setState({ kind: "transcribing" });
    overlay.setRegion({ rect: { height: 90, width: 90, x: 0, y: 0 }, turn });
    expect(regions.at(-1)).toEqual({ height: 50, width: 80, x: 10, y: 20 });

    // The next turn starts without an area.
    overlay.show({
      cursor: { x: 1, y: 1 },
      displayId: 1,
      state: { kind: "listening" },
    });
    expect(regions.at(-1)).toBeNull();
  });

  it("hides click-through and leaves nothing on screen between turns", async () => {
    const { latest, overlay, window } = createOverlay();
    overlay.show({
      cursor: { x: 5, y: 5 },
      displayId: 1,
      state: { kind: "listening" },
    });
    await settle();
    overlay.hide();

    expect(window().visible).toBe(false);
    expect(window().ignoringMouse).toBe(true);
    expect(latest().pill).toBeNull();
    // A late state from a finished turn does not bring the overlay back.
    overlay.setState({ kind: "busy" });
    expect(latest().pill).toBeNull();
    expect(window().visible).toBe(false);
  });

  it("lets the pill's own buttons take clicks while the rest stays click-through", async () => {
    const { overlay, window } = createOverlay();
    overlay.show({
      cursor: { x: 5, y: 5 },
      displayId: 1,
      state: { code: "send_failed", kind: "error", transcript: "what is this?" },
    });
    await settle();
    expect(window().ignoringMouse).toBe(true);
    overlay.setInteractive({ interactive: true });
    expect(window().ignoringMouse).toBe(false);
    overlay.setInteractive({ interactive: false });
    expect(window().ignoringMouse).toBe(true);
  });

  it("runs the pill actions and copies only the failed turn's transcript", async () => {
    const { latest, openExternal, openMeetingSettings, overlay, writeClipboard } =
      createOverlay();
    overlay.show({
      cursor: { x: 5, y: 5 },
      displayId: 1,
      state: { code: "send_failed", kind: "error", transcript: "what is this?" },
    });
    await settle();
    expect(latest().pill).toEqual({
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
