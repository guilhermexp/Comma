import userEvent from "@testing-library/user-event";
import { initializeCommaI18n } from "@comma/i18n";
import type { PushToTalkOverlayState } from "@comma/native-bridge";
import { act, fireEvent, render, screen } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushToTalkOverlayApp } from "../PushToTalkOverlayApp";

const listening: PushToTalkOverlayState = {
  anchor: { x: 200, y: 150 },
  pill: { kind: "listening" },
  revision: 1,
  turn: 7,
};

function installOverlayBridge(initial: PushToTalkOverlayState) {
  let listener: ((state: PushToTalkOverlayState) => void) | undefined;
  const get = vi.fn(async () => initial);
  const pushToTalk = {
    overlayAction: vi.fn(async () => undefined),
    overlayState: Object.assign(get, {
      get,
      subscribe: vi.fn((next: (state: PushToTalkOverlayState) => void) => {
        listener = next;
        next(initial);
        return () => undefined;
      }),
    }),
    setInteractive: vi.fn(async () => undefined),
    setRegion: vi.fn(async () => undefined),
  };
  installNativeBridgeMock({ os: "macos", platform: "electron", pushToTalk });
  return {
    publish: (state: PushToTalkOverlayState) => act(() => listener?.(state)),
    pushToTalk,
  };
}

function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const surface = screen.getByTestId("push-to-talk-overlay");
  fireEvent.pointerDown(surface, {
    button: 0,
    clientX: from.x,
    clientY: from.y,
    pointerId: 1,
  });
  fireEvent.pointerMove(surface, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

describe("PushToTalkOverlayApp", () => {
  beforeEach(() => initializeCommaI18n(["en"]));
  afterEach(() => vi.unstubAllGlobals());

  it("marks an area by dragging while listening, and a new drag replaces it", async () => {
    const { pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    expect(await screen.findByRole("status")).toHaveTextContent("Listening");

    drag({ x: 300, y: 260 }, { x: 100, y: 200 });
    expect(pushToTalk.setRegion).toHaveBeenLastCalledWith({
      rect: { height: 60, width: 200, x: 100, y: 200 },
      turn: 7,
    });
    expect(screen.getAllByLabelText("Marked area")).toHaveLength(1);

    drag({ x: 10, y: 20 }, { x: 50, y: 90 });
    expect(pushToTalk.setRegion).toHaveBeenLastCalledWith({
      rect: { height: 70, width: 40, x: 10, y: 20 },
      turn: 7,
    });
    expect(screen.getAllByLabelText("Marked area")).toHaveLength(1);
    expect(screen.getByLabelText("Marked area")).toHaveStyle({
      height: "70px",
      left: "10px",
      top: "20px",
      width: "40px",
    });

    // A click without a drag clears the area.
    drag({ x: 400, y: 400 }, { x: 401, y: 401 });
    expect(pushToTalk.setRegion).toHaveBeenLastCalledWith({ rect: null, turn: 7 });
    expect(screen.queryByLabelText("Marked area")).toBeNull();
  });

  it("shows the pill for each turn state and leaves nothing on screen when hidden", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");
    drag({ x: 10, y: 20 }, { x: 50, y: 90 });

    publish({ ...listening, pill: { kind: "transcribing" }, revision: 2 });
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
    // After release only the pill stays; the area is no longer drawn or editable.
    expect(screen.queryByLabelText("Marked area")).toBeNull();
    drag({ x: 0, y: 0 }, { x: 90, y: 90 });
    expect(pushToTalk.setRegion).toHaveBeenCalledOnce();

    publish({ ...listening, pill: { kind: "busy" }, revision: 3 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Wait for the current question"
    );

    // An older revision delivered late is ignored.
    publish({ ...listening, pill: { kind: "listening" }, revision: 2 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Wait for the current question"
    );

    publish({ ...listening, pill: null, revision: 4 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the action each error needs and starts a new turn without the old area", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");
    drag({ x: 10, y: 20 }, { x: 50, y: 90 });

    publish({
      ...listening,
      pill: { code: "microphone_denied", kind: "error", transcriptAvailable: false },
      revision: 2,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Comma needs Microphone access"
    );
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-microphone-settings",
    });

    publish({
      ...listening,
      pill: { code: "screen_denied", kind: "error", transcriptAvailable: false },
      revision: 3,
    });
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-screen-recording-settings",
    });

    publish({
      ...listening,
      pill: {
        code: "transcription_unavailable",
        kind: "error",
        transcriptAvailable: false,
      },
      revision: 4,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Meeting settings" })
    );
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-meeting-settings",
    });

    publish({
      ...listening,
      pill: { code: "send_failed", kind: "error", transcriptAvailable: true },
      revision: 5,
    });
    await userEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "copy-transcript",
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    publish({
      ...listening,
      pill: { code: "nothing_heard", kind: "error", transcriptAvailable: false },
      revision: 6,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Didn’t catch that");
    expect(screen.queryByRole("button")).toBeNull();

    publish({ ...listening, revision: 7, turn: 8 });
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    expect(screen.queryByLabelText("Marked area")).toBeNull();
  });
});
