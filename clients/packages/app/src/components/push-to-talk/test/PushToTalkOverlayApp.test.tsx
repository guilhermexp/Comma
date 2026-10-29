import userEvent from "@testing-library/user-event";
import { initializeCommaI18n } from "@comma/i18n";
import type { PushToTalkOverlayState } from "@comma/native-bridge";
import { act, fireEvent, render, screen } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushToTalkOverlayApp } from "../PushToTalkOverlayApp";

const listening: PushToTalkOverlayState = {
  caption: null,
  companion: { kind: "listening" },
  cursor: { x: 200, y: 150 },
  drawingEnabled: true,
  hiding: false,
  level: 0,
  revision: 1,
  surface: 7,
};

function installOverlayBridge(initial: PushToTalkOverlayState) {
  let listener: ((state: PushToTalkOverlayState) => void) | undefined;
  let revision = initial.revision;
  let current = initial;
  const get = vi.fn(async () => current);
  const pushToTalk = {
    overlayAction: vi.fn(async () => undefined),
    overlayState: Object.assign(get, {
      get,
      subscribe: vi.fn((next: (state: PushToTalkOverlayState) => void) => {
        listener = next;
        next(current);
        return () => undefined;
      }),
    }),
    setInteractive: vi.fn(async () => undefined),
    setStroke: vi.fn(async () => undefined),
  };
  installNativeBridgeMock({ os: "macos", platform: "electron", pushToTalk });
  return {
    /** Publishes the next revision with the given changes. */
    publish: (patch: Partial<PushToTalkOverlayState>) => {
      revision += 1;
      current = { ...current, ...patch, revision };
      act(() => listener?.(current));
    },
    publishRaw: (state: PushToTalkOverlayState) => act(() => listener?.(state)),
    pushToTalk,
  };
}

function drag(points: Array<{ x: number; y: number }>) {
  const surface = screen.getByTestId("push-to-talk-overlay");
  const [first, ...rest] = points;
  fireEvent.pointerDown(surface, {
    button: 0,
    clientX: first!.x,
    clientY: first!.y,
    pointerId: 1,
  });
  for (const point of rest)
    fireEvent.pointerMove(surface, {
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
    });
  const last = points.at(-1)!;
  fireEvent.pointerUp(surface, { clientX: last.x, clientY: last.y, pointerId: 1 });
}

/** Heights of the level bars, 0..1. */
const bars = () =>
  [...screen.getByTestId("push-to-talk-level").children].map((bar) =>
    Number((bar as HTMLElement).style.getPropertyValue("--bar-level"))
  );

const loop = [
  { x: 100, y: 100 },
  { x: 180, y: 90 },
  { x: 220, y: 160 },
  { x: 140, y: 210 },
];

describe("PushToTalkOverlayApp", () => {
  beforeEach(() => initializeCommaI18n(["en"]));
  afterEach(() => vi.restoreAllMocks());

  it("draws a freehand stroke while listening, and a new drag replaces it", async () => {
    const { pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    expect(await screen.findByRole("status")).toHaveTextContent("Listening");

    drag(loop);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: loop, surface: 7 });
    expect(screen.getAllByRole("img", { name: "Your drawing" })).toHaveLength(1);

    const swoosh = [
      { x: 400, y: 300 },
      { x: 480, y: 340 },
    ];
    drag(swoosh);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({
      points: swoosh,
      surface: 7,
    });
    expect(screen.getAllByRole("img", { name: "Your drawing" })).toHaveLength(1);

    // A click without a drag clears it.
    drag([{ x: 600, y: 600 }]);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: null, surface: 7 });
    expect(screen.queryByRole("img", { name: "Your drawing" })).toBeNull();
  });

  it("keeps the released stroke visible without accepting new drags", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");
    drag(loop);

    publish({ companion: { kind: "thinking" }, drawingEnabled: false });
    expect(screen.getByRole("img", { name: "Your drawing" })).toBeVisible();
    const reports = pushToTalk.setStroke.mock.calls.length;
    drag([
      { x: 0, y: 0 },
      { x: 90, y: 90 },
    ]);
    expect(pushToTalk.setStroke).toHaveBeenCalledTimes(reports);

    // Another surface (display or turn) starts without the stroke.
    publish({ companion: { kind: "listening" }, drawingEnabled: true, surface: 8 });
    expect(screen.queryByRole("img", { name: "Your drawing" })).toBeNull();
  });

  it("follows the cursor with level bars while listening", async () => {
    const { publish } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    const companion = await screen.findByTestId("push-to-talk-companion");
    expect(companion).toHaveStyle({ left: "200px", top: "150px" });

    publish({ level: 0.05 });
    const quiet = bars();
    publish({ cursor: { x: 640, y: 480 }, level: 0.8 });
    const loud = bars();
    expect(loud).toHaveLength(quiet.length);
    expect(loud.every((height, index) => height > quiet[index]!)).toBe(true);
    expect(companion).toHaveStyle({ left: "640px", top: "480px" });
  });

  it("waits with a spinner, then speaks the sentence in a balloon that opens the chat", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");

    publish({ companion: { kind: "connecting" }, drawingEnabled: false });
    expect(screen.getByRole("status")).toHaveTextContent("Connecting");
    expect(screen.getByTestId("push-to-talk-waiting")).toBeInTheDocument();
    expect(screen.queryByTestId("push-to-talk-level")).toBeNull();

    publish({ companion: { kind: "thinking" } });
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByTestId("push-to-talk-waiting")).toBeInTheDocument();

    publish({
      caption: "Revenue peaks in March, then falls by a third.",
      companion: { kind: "speaking" },
    });
    expect(screen.queryByTestId("push-to-talk-waiting")).toBeNull();
    const balloon = screen.getByRole("button", {
      name: "Revenue peaks in March, then falls by a third.",
    });
    expect(balloon).toHaveAccessibleDescription("Open in chat");
    await userEvent.click(balloon);
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "caption-click",
    });

    // Over the balloon the window takes the click; elsewhere clicks go through.
    fireEvent.mouseMove(balloon);
    expect(pushToTalk.setInteractive).toHaveBeenLastCalledWith({ interactive: true });
    fireEvent.mouseMove(screen.getByTestId("push-to-talk-overlay"));
    expect(pushToTalk.setInteractive).toHaveBeenLastCalledWith({ interactive: false });

    publish({ caption: null, companion: { kind: "speaking" } });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("holds the balloon still while the pointer heads into it", async () => {
    const { publish } = installOverlayBridge(listening);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        // The balloon sits below and to the right of the companion's tip.
        if (this.dataset.pushToTalkBalloon === undefined) return new DOMRect();
        const left = Number.parseFloat(
          this.closest<HTMLElement>("[data-testid='push-to-talk-companion']")!.style
            .left
        );
        const top = Number.parseFloat(
          this.closest<HTMLElement>("[data-testid='push-to-talk-companion']")!.style.top
        );
        return new DOMRect(left + 24, top + 36, 320, 40);
      }
    );
    render(<PushToTalkOverlayApp />);
    const companion = await screen.findByTestId("push-to-talk-companion");
    publish({ caption: "It peaks in March.", companion: { kind: "speaking" } });

    // On the way from the tip into the balloon: it waits for the pointer.
    publish({
      caption: "It peaks in March.",
      companion: { kind: "speaking" },
      cursor: { x: 260, y: 200 },
    });
    expect(companion).toHaveStyle({ left: "200px", top: "150px" });

    // Away from it: the companion follows again.
    publish({
      caption: "It peaks in March.",
      companion: { kind: "speaking" },
      cursor: { x: 90, y: 60 },
    });
    expect(companion).toHaveStyle({ left: "90px", top: "60px" });
  });

  it("shows an error with the action it needs, and nothing once hidden", async () => {
    const { publish, publishRaw, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");

    publish({
      drawingEnabled: false,
      companion: {
        code: "microphone_denied",
        kind: "error",
      },
    });
    expect(screen.getByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-microphone-settings",
    });

    publish({
      drawingEnabled: false,
      companion: {
        code: "screen_denied",
        kind: "error",
      },
    });
    expect(screen.getByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-screen-recording-settings",
    });

    publish({
      companion: { code: "busy", kind: "error" },
    });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();

    publish({ companion: { kind: "ready" } });
    expect(screen.getByRole("status")).toHaveTextContent("Reply ready");

    // An older revision delivered late is ignored.
    publishRaw({ ...listening, revision: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("Reply ready");

    publish({ hiding: true, companion: { kind: "ready" } });

    publish({ companion: null });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("push-to-talk-companion")).toBeNull();
  });

  it("shows a late reply as ready and opens chat only when its balloon is clicked", async () => {
    const { pushToTalk } = installOverlayBridge({
      ...listening,
      companion: { kind: "ready" },
      caption: "The Router finished the requested task.",
      drawingEnabled: false,
    });
    render(<PushToTalkOverlayApp />);
    await screen.findByRole("status");
    expect(pushToTalk.overlayAction).not.toHaveBeenCalled();
    const balloon = screen.getByRole("button", {
      name: /The Router finished the requested task\./,
    });
    expect(balloon).toHaveTextContent("The Router finished the requested task.");
    await userEvent.click(balloon);
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "caption-click",
    });
  });

  it("disables drawing and paints no stroke when drawing is not available", async () => {
    const { pushToTalk } = installOverlayBridge({
      ...listening,
      drawingEnabled: false,
    });
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");

    drag(loop);
    expect(pushToTalk.setStroke).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "Your drawing" })).toBeNull();
  });

  it("keeps drawing available while the service speaks during a held gesture", async () => {
    const { pushToTalk } = installOverlayBridge({
      ...listening,
      companion: { kind: "speaking" },
    });
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Speaking");
    drag(loop);
    expect(screen.getByRole("img", { name: "Your drawing" })).toBeVisible();
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: loop, surface: 7 });
  });

  it("clears in-progress stroke and paints no accepted stroke when drawing is revoked mid-turn", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");

    drag(loop);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: loop, surface: 7 });
    expect(screen.getAllByRole("img", { name: "Your drawing" })).toHaveLength(1);

    // Move to off-capture display: drawing availability is disabled and new surface starts
    publish({ drawingEnabled: false, surface: 8 });
    expect(screen.queryByRole("img", { name: "Your drawing" })).toBeNull();

    // Off-capture dragging is ignored and paints no accepted-looking stroke
    drag(loop);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: loop, surface: 7 });
    expect(screen.queryByRole("img", { name: "Your drawing" })).toBeNull();

    // Returning to captured display re-enables drawing
    publish({ drawingEnabled: true, surface: 9 });
    drag(loop);
    expect(pushToTalk.setStroke).toHaveBeenLastCalledWith({ points: loop, surface: 9 });
    expect(screen.getAllByRole("img", { name: "Your drawing" })).toHaveLength(1);
  });
});
