import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@comma/test-utils/render";
import { VoiceCallTranscript } from "../VoiceCallTranscript";
import { useVoiceCallHistory } from "../useVoiceCallHistory";
import { CommaI18nProvider } from "@comma/i18n/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { CommaApiError } from "../../../api";
import { VoiceCallControl } from "../VoiceCallControl";

const track = { enabled: true, stop: vi.fn() };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const channel = { close: vi.fn(), addEventListener: vi.fn() };
const remote = vi.fn(async () => {});
const closePeer = vi.fn();
let peer: RTCPeerConnection;
let connected = true;
let gathered = true;
const getUserMedia = vi.fn(async () => stream);

beforeEach(() => {
  track.enabled = true;
  connected = true;
  gathered = true;
  vi.clearAllMocks();
  getUserMedia.mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      srcObject = null;
      pause() {}
    }
  );
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends EventTarget {
      connectionState = connected ? "connected" : "connecting";
      iceGatheringState = gathered ? "complete" : "gathering";
      constructor() {
        super();
        peer = this as unknown as RTCPeerConnection;
      }
      localDescription = { sdp: "offer" };
      createDataChannel() {
        return channel;
      }
      addTrack() {}
      async createOffer() {
        return { type: "offer", sdp: "offer" };
      }
      async setLocalDescription() {}
      setRemoteDescription = remote;
      close = closePeer;
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  api,
  compact = false,
  scope = "home",
}: {
  api: CommaApiClient;
  compact?: boolean;
  scope?: string;
}) {
  const history = useVoiceCallHistory(scope);
  return (
    <CommaI18nProvider locale="en">
      <VoiceCallControl
        api={api}
        workspaceId="wsp_test"
        surfaceActive={!compact}
        onTranscript={history.record}
      />
      <div aria-label="Messages">
        {history.records.map(({ transcript }) => (
          <VoiceCallTranscript key={transcript.callId} transcript={transcript} />
        ))}
      </div>
    </CommaI18nProvider>
  );
}

function setup(overrides = {}) {
  const api = {
    startVoiceCall: vi.fn(async () => ({ call_id: "vc_test", sdp: "answer" })),
    voiceCallEvents: vi.fn(async () => ({
      cursor: 3,
      truncated: false,
      events: [
        { kind: "started" },
        { kind: "caption", role: "agent", turn: 1, text: "Hello", final: false },
        { kind: "caption", role: "agent", turn: 1, text: "Hello there", final: true },
      ],
    })),
    endVoiceCall: vi.fn(async () => ({})),
    ...overrides,
  };
  const view = render(<Harness api={api as unknown as CommaApiClient} />);
  return { api, ...view };
}

it("captures audio, relays SDP, shows captions, mutes and retains the transcript after hang up", async () => {
  vi.useFakeTimers();
  try {
    const { api } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("00:00");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(api.startVoiceCall).toHaveBeenCalledWith("wsp_test", "offer");
    expect(remote).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
    expect(screen.queryByText("Hello there")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show captions" }));
    expect(screen.getByText("Hello there")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide captions" }));
    expect(screen.queryByText("Hello there")).not.toBeInTheDocument();
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(track.enabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(track.enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
    // Settle the close promise and the effect that publishes the transcript
    // before reading either result. Keep the dismissal clock under test control.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Call ended");
    expect(api.endVoiceCall).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(closePeer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("article", { name: "Call transcript" })).toBeVisible();
    expect(screen.queryByText("Hello there")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Call · 00:00" }));
    expect(screen.getByText("Hello there")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.queryByTestId("voice-call")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call Comma" })).toBeVisible();
    expect(screen.getByRole("article", { name: "Call transcript" })).toBeVisible();
    expect(screen.getByText("Hello there")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("shows microphone denial without starting a paid call", async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  const { api } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Microphone access is required"
  );
  expect(screen.getByTestId("voice-call").querySelector("output")).toHaveTextContent(
    "Call failed"
  );
  expect(api.startVoiceCall).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
  expect(closePeer).toHaveBeenCalledTimes(1);
});

it("shows plan limit and releases the microphone", async () => {
  setup({
    startVoiceCall: vi.fn(async () => {
      throw new CommaApiError(429, "limit", { error: "plan_limit" });
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "ChatGPT plan voice limit"
  );
  expect(track.stop).toHaveBeenCalledTimes(1);
});

it("closes a late signaling answer after the view has unmounted", async () => {
  let finish!: (answer: { call_id: string; sdp: string }) => void;
  const startVoiceCall = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { api, unmount } = setup({ startVoiceCall });
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  await waitFor(() => expect(startVoiceCall).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => finish({ call_id: "vc_late", sdp: "answer" }));
  expect(api.endVoiceCall).toHaveBeenCalledWith("wsp_test", "vc_late");
  expect(remote).not.toHaveBeenCalled();
});

it("waits for gathered SDP and both media and sideband readiness", async () => {
  gathered = false;
  connected = false;
  const { api } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(api.startVoiceCall).not.toHaveBeenCalled();
  await act(async () => {
    Object.assign(peer, {
      iceGatheringState: "complete",
      localDescription: { sdp: "gathered offer" },
    });
    peer.dispatchEvent(new Event("icegatheringstatechange"));
  });
  await waitFor(() => expect(api.voiceCallEvents).toHaveBeenCalled());
  expect(api.startVoiceCall).toHaveBeenCalledWith("wsp_test", "gathered offer");
  expect(screen.getByRole("status")).toHaveTextContent("Calling");
  await act(async () => {
    Object.assign(peer, { connectionState: "connected" });
    peer.dispatchEvent(new Event("connectionstatechange"));
  });
  expect(screen.getByRole("status")).toHaveTextContent("00:00");
});

it("ends a peer that never connects even when sideband started", async () => {
  connected = false;
  vi.useFakeTimers();
  try {
    const { api } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.voiceCallEvents).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Calling");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(api.endVoiceCall).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(closePeer).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the same call and bar when navigation makes it compact", async () => {
  const { api, rerender } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("00:00"));
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  const bar = screen.getByTestId("voice-call");
  rerender(<Harness api={api as unknown as CommaApiClient} compact />);
  expect(screen.getByTestId("voice-call")).toBe(bar);
  expect(bar).toHaveAttribute("data-compact", "true");
  expect(
    screen.queryByRole("button", { name: "Show captions" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(track.stop).not.toHaveBeenCalled();
  expect(api.endVoiceCall).not.toHaveBeenCalled();
  rerender(<Harness api={api as unknown as CommaApiClient} />);
  expect(screen.getByTestId("voice-call")).toBe(bar);
  expect(api.startVoiceCall).toHaveBeenCalledTimes(1);
});

it("tracks each pending delegation until it is answered and clears on call end", async () => {
  vi.useFakeTimers();
  try {
    const events = vi
      .fn()
      .mockResolvedValueOnce({
        cursor: 1,
        events: [
          { kind: "started" },
          { type: "delegation", id: "one", status: "pending" },
          { type: "delegation", id: "two", status: "pending" },
        ],
      })
      .mockResolvedValueOnce({
        cursor: 2,
        events: [{ type: "delegation", id: "one", status: "answered" }],
      })
      .mockResolvedValueOnce({
        cursor: 3,
        events: [{ type: "delegation", id: "two", status: "answered" }],
      })
      .mockResolvedValueOnce({
        cursor: 4,
        events: [
          { type: "delegation", id: "three", status: "pending" },
          { kind: "closed", reason: "completed" },
        ],
      });
    setup({ voiceCallEvents: events });
    fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("On it…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("On it…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("00:01");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Call ended");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.queryByTestId("voice-call")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Call Comma" })).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps one transcript per call and isolates conversation history", async () => {
  vi.useFakeTimers();
  try {
    let count = 0;
    const { api, rerender } = setup({
      startVoiceCall: vi.fn(async () => ({
        call_id: `call-${++count}`,
        sdp: "answer",
      })),
      voiceCallEvents: vi.fn(async () => ({
        cursor: 1,
        events: [
          { kind: "started" },
          {
            kind: "caption",
            role: "agent",
            turn: 1,
            text: `Answer ${count}`,
            final: true,
          },
        ],
      })),
    });
    for (let call = 0; call < 2; call++) {
      fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
    }
    expect(screen.getAllByRole("article", { name: "Call transcript" })).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: "Call · 00:00" }))
      fireEvent.click(button);
    expect(screen.getByText("Answer 1")).toBeVisible();
    expect(screen.getByText("Answer 2")).toBeVisible();
    rerender(
      <Harness api={api as unknown as CommaApiClient} scope="another-workspace" />
    );
    expect(
      screen.queryByRole("article", { name: "Call transcript" })
    ).not.toBeInTheDocument();
    rerender(<Harness api={api as unknown as CommaApiClient} />);
    expect(screen.getAllByRole("article", { name: "Call transcript" })).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it("shows ending until hang up settles", async () => {
  let finish!: () => void;
  setup({
    endVoiceCall: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    ),
  });
  fireEvent.click(screen.getByRole("button", { name: "Call Comma" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("00:00"));
  fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
  expect(screen.getByRole("status")).toHaveTextContent("Hanging up…");
  expect(screen.getByRole("button", { name: "Hang up" })).toBeDisabled();
  await act(async () => finish());
  expect(screen.getByRole("status")).toHaveTextContent("Call ended");
});
