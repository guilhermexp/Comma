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
  hiding: false,
  level: 0,
  revision: 1,
  surface: 7,
};

function installOverlayBridge(initial: PushToTalkOverlayState) {
  let listener: ((state: PushToTalkOverlayState) => void) | undefined;
  let revision = initial.revision;
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
    setStroke: vi.fn(async () => undefined),
  };
  installNativeBridgeMock({ os: "macos", platform: "electron", pushToTalk });
  return {
    /** Publishes the next revision with the given changes. */
    publish: (patch: Partial<PushToTalkOverlayState>) => {
      revision += 1;
      act(() => listener?.({ ...initial, ...patch, revision }));
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
    expect(
      screen.getByRole("img", { name: "Your drawing" }).querySelector("path")
    ).toHaveAttribute("d", "M100 100Q180 90 200 125Q220 160 180 185L140 210");

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

  it("keeps the stroke on screen after release, fading, without taking new drags", async () => {
    const { publish, pushToTalk } = installOverlayBridge(listening);
    render(<PushToTalkOverlayApp />);
    await screen.findByText("Listening");
    drag(loop);

    publish({ companion: { kind: "transcribing" } });
    expect(screen.getByRole("img", { name: "Your drawing" })).toHaveAttribute(
      "data-fading"
    );
    const reports = pushToTalk.setStroke.mock.calls.length;
    drag([
      { x: 0, y: 0 },
      { x: 90, y: 90 },
    ]);
    expect(pushToTalk.setStroke).toHaveBeenCalledTimes(reports);

    // Another surface (display or turn) starts without the stroke.
    publish({ companion: { kind: "listening" }, surface: 8 });
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

    publish({ companion: { kind: "transcribing" } });
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing");
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
      companion: {
        code: "microphone_denied",
        kind: "error",
        transcriptAvailable: false,
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Comma needs Microphone access"
    );
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-microphone-settings",
    });

    publish({
      companion: {
        code: "transcription_unavailable",
        kind: "error",
        transcriptAvailable: false,
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Meeting settings" })
    );
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "open-meeting-settings",
    });

    publish({
      companion: { code: "send_failed", kind: "error", transcriptAvailable: true },
    });
    await userEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    expect(pushToTalk.overlayAction).toHaveBeenLastCalledWith({
      action: "copy-transcript",
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    publish({
      companion: { code: "nothing_heard", kind: "error", transcriptAvailable: false },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Didn’t catch that");
    expect(screen.queryByRole("button")).toBeNull();

    publish({ companion: { kind: "busy" } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Wait for the current question"
    );

    // An older revision delivered late is ignored.
    publishRaw({ ...listening, revision: 1 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Wait for the current question"
    );

    publish({ hiding: true, companion: { kind: "busy" } });
    expect(screen.getByTestId("push-to-talk-overlay")).toHaveAttribute("data-hiding");

    publish({ companion: null });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("push-to-talk-companion")).toBeNull();
  });
});
