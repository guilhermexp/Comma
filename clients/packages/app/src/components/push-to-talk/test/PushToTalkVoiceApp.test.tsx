import type { PushToTalkVoiceSession } from "@comma/native-bridge";
import { act, render } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushToTalkVoiceApp } from "../PushToTalkVoiceApp";
import type { ReadAloudPeerDeps } from "../readAloudPeer";

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

class FakePeer {
  tracks: MediaStreamTrack[] = [];
  channels: string[] = [];
  remote: RTCSessionDescriptionInit | undefined;
  closed = false;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  ontrack:
    | ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void)
    | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  createDataChannel(label: string) {
    this.channels.push(label);
    return { close: () => undefined };
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription(description: { sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote = description;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

function fakeDeps() {
  const peers: FakePeer[] = [];
  const level = { value: 0 };
  const silentTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  const contexts: { closed: boolean; gain: number }[] = [];
  const audio = {
    autoplay: false,
    srcObject: null as unknown,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  };
  const deps: ReadAloudPeerDeps = {
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createAudioContext: () => {
      const record = { closed: false, gain: 1 };
      contexts.push(record);
      const node = { connect: (next: unknown) => next };
      return {
        createOscillator: () => ({ ...node, start: vi.fn(), stop: vi.fn() }),
        createGain: () => ({
          ...node,
          gain: {
            set value(value: number) {
              record.gain = value;
            },
          },
        }),
        createMediaStreamDestination: () => ({
          stream: { getAudioTracks: () => [silentTrack] },
        }),
        createMediaStreamSource: () => node,
        createAnalyser: () => ({
          fftSize: 0,
          getFloatTimeDomainData: (data: Float32Array) => data.fill(level.value),
        }),
        resume: async () => undefined,
        close: async () => {
          record.closed = true;
        },
      } as unknown as AudioContext;
    },
    createAudio: () => audio as unknown as HTMLAudioElement,
  };
  return { audio, contexts, deps, level, peers, silentTrack };
}

function installVoiceBridge() {
  let listener: ((session: PushToTalkVoiceSession) => void) | undefined;
  const idle = { active: false, generation: 0 };
  const get = vi.fn(async () => idle);
  const pushToTalkVoice = {
    session: Object.assign(get, {
      get,
      subscribe: vi.fn((next: (session: PushToTalkVoiceSession) => void) => {
        listener = next;
        next(idle);
        return () => undefined;
      }),
    }),
    offer: vi.fn(async (_input: { generation: number; sdp: string }) => ({
      sdp: "answer-sdp",
    })),
    report: vi.fn(async (_input: { generation: number; event: string }) => undefined),
  };
  installNativeBridgeMock({ os: "macos", platform: "electron", pushToTalkVoice });
  return {
    publish: async (session: PushToTalkVoiceSession) => {
      act(() => listener?.(session));
      await act(flush);
    },
    pushToTalkVoice,
  };
}

afterEach(() => vi.useRealTimers());

describe("PushToTalkVoiceApp", () => {
  it("connects a peer with a silent track and no microphone, and relays Main's answer", async () => {
    const { deps, peers, contexts, silentTrack } = fakeDeps();
    const bridge = installVoiceBridge();
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    render(<PushToTalkVoiceApp deps={deps} />);
    expect(peers).toHaveLength(0);

    await bridge.publish({ active: true, generation: 3 });
    const [peer] = peers;
    expect(peer?.tracks).toEqual([silentTrack]);
    expect(contexts[0]?.gain).toBe(0);
    expect(peer?.channels).toEqual(["oai-events"]);
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledWith({
      generation: 3,
      sdp: "offer-sdp",
    });
    expect(peer?.remote).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(getUserMedia).not.toHaveBeenCalled();

    await bridge.publish({ active: false, generation: 4 });
    expect(peer?.closed).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
  });

  it("reports when the received voice becomes audible and when it goes quiet", async () => {
    vi.useFakeTimers();
    const { audio, deps, level, peers } = fakeDeps();
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({ active: true, generation: 1 });
    const stream = {} as MediaStream;
    act(() =>
      peers[0]?.ontrack?.({ track: {} as MediaStreamTrack, streams: [stream] })
    );
    expect(audio.srcObject).toBe(stream);
    expect(audio.play).toHaveBeenCalled();

    level.value = 0.2;
    await act(async () => vi.advanceTimersByTime(100));
    level.value = 0;
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(bridge.pushToTalkVoice.report.mock.calls.map(([input]) => input)).toEqual([
      { generation: 1, event: "audible" },
      { generation: 1, event: "silent" },
    ]);
  });

  it("drops the peer without an answer when Main no longer wants it", async () => {
    const { deps, peers } = fakeDeps();
    const bridge = installVoiceBridge();
    bridge.pushToTalkVoice.offer.mockResolvedValueOnce(null as never);
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({ active: true, generation: 2 });
    expect(peers[0]?.remote).toBeUndefined();
    expect(peers[0]?.closed).toBe(true);
  });
});
