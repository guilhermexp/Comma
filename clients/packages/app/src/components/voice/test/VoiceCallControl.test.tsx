import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@comma/test-utils/render";
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
  const view = render(
    <CommaI18nProvider locale="en">
      <VoiceCallControl api={api as unknown as CommaApiClient} workspaceId="wsp_test" />
    </CommaI18nProvider>
  );
  return { api, ...view };
}

it("captures audio, relays SDP, shows captions, mutes and retains the transcript after hang up", async () => {
  const { api } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Call" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("On call"));
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(api.startVoiceCall).toHaveBeenCalledWith("wsp_test", "offer");
  expect(remote).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
  expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0);
  expect(screen.queryByText("Hello")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(track.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
  expect(track.enabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Call ended")
  );
  expect(api.endVoiceCall).toHaveBeenCalledTimes(1);
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(closePeer).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Call transcript")).toBeVisible();
  expect(screen.getByText("Hello there")).toBeVisible();
});

it("shows microphone denial without starting a paid call", async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  const { api } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Call" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Microphone access is required"
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
  fireEvent.click(screen.getByRole("button", { name: "Call" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Call" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Call" }));
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
  expect(screen.getByRole("status")).toHaveTextContent("Connecting");
  await act(async () => {
    Object.assign(peer, { connectionState: "connected" });
    peer.dispatchEvent(new Event("connectionstatechange"));
  });
  expect(screen.getByRole("status")).toHaveTextContent("On call");
});

it("ends a peer that never connects even when sideband started", async () => {
  connected = false;
  vi.useFakeTimers();
  try {
    const { api } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.voiceCallEvents).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting");
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
