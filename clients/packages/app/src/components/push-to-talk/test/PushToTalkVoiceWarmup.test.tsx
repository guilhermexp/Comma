import type {
  PushToTalkVoiceReport,
  PushToTalkVoiceSession,
} from "@comma/native-bridge";
import { act, render } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushToTalkVoiceApp } from "../PushToTalkVoiceApp";
import type { PushToTalkPeerDeps } from "../pushToTalkPeer";

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

class FakeMediaStreamTrack extends EventTarget {
  kind = "audio";
  enabled = true;
  stopped = false;
  stop = vi.fn(() => {
    this.stopped = true;
  });
}

class FakeMediaStream {
  tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[] = [new FakeMediaStreamTrack()]) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class FakePeer {
  tracks: FakeMediaStreamTrack[] = [];
  trackStateAtAdd: boolean[] = [];
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

  addTrack(track: FakeMediaStreamTrack) {
    this.tracks.push(track);
    this.trackStateAtAdd.push(track.enabled);
  }

  createDataChannel(label: string) {
    this.channels.push(label);
    return {
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "offer-sdp" };
  }

  async setLocalDescription(description: { sdp: string }) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote = description;
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

function fakeWarmupDeps(
  options: {
    getUserMediaImpl?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  } = {}
) {
  const peers: FakePeer[] = [];
  const micTracks: FakeMediaStreamTrack[] = [];
  const destinationTracks: FakeMediaStreamTrack[] = [];

  const defaultGetUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    const track = new FakeMediaStreamTrack();
    micTracks.push(track);
    return new FakeMediaStream([track]) as unknown as MediaStream;
  });

  const getUserMedia = options.getUserMediaImpl
    ? vi.fn(options.getUserMediaImpl)
    : defaultGetUserMedia;

  const deps: PushToTalkPeerDeps = {
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createAudioContext: () => {
      const node = { connect: vi.fn((next: unknown) => next), disconnect: vi.fn() };
      return {
        sampleRate: 48000,
        createAnalyser: () => ({
          fftSize: 512,
          getFloatTimeDomainData: (data: Float32Array) => data.fill(0),
        }),
        createMediaStreamSource: () => node,
        createMediaStreamDestination: () => {
          const track = new FakeMediaStreamTrack();
          track.enabled = false;
          destinationTracks.push(track);
          return { stream: new FakeMediaStream([track]) };
        },
        createGain: () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: { value: 1 },
        }),
        createScriptProcessor: vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
          onaudioprocess: null,
        })),
        resume: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as AudioContext;
    },
    createAudio: () =>
      ({
        autoplay: false,
        muted: false,
        srcObject: null as unknown,
        play: vi.fn(async () => undefined),
        pause: vi.fn(),
      }) as unknown as HTMLAudioElement,
    getUserMedia,
  };

  return { deps, getUserMedia, peers, destinationTracks, micTracks };
}

function installVoiceBridge() {
  let listener: ((session: PushToTalkVoiceSession) => void) | undefined;
  const idle: PushToTalkVoiceSession = {
    active: false,
    generation: 0,
    revision: 0,
    listening: false,
    contextId: null,
    admitted: false,
    qualified: false,
  };
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
    report: vi.fn(
      async (_input: { generation: number; event: PushToTalkVoiceReport }) => undefined
    ),
  };
  installNativeBridgeMock({ os: "macos", platform: "electron", pushToTalkVoice });
  return {
    publish: async (
      session: Omit<PushToTalkVoiceSession, "qualified"> & {
        qualified?: boolean;
      }
    ) => {
      act(() =>
        listener?.({
          qualified: false,
          ...session,
        })
      );
      await act(flush);
    },
    pushToTalkVoice,
  };
}

afterEach(() => vi.useRealTimers());

describe("PushToTalkVoiceApp E1 warming and delayed getUserMedia regression", () => {
  it("warms hidden PTT voice window and peer on availability without calling getUserMedia or opening service offer", async () => {
    const { deps, getUserMedia, peers, destinationTracks } = fakeWarmupDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    expect(peers).toHaveLength(0);

    // Main publishes active warm session when PTT is available, but listening is false
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    // WebRTC peer is created and warm
    expect(peers).toHaveLength(1);
    expect(destinationTracks[0]?.enabled).toBe(false);

    // Warmup must NOT call getUserMedia before press (preserves D14)
    expect(getUserMedia).not.toHaveBeenCalled();

    // Warmup must NOT open a service call or send an SDP offer before press
    expect(bridge.pushToTalkVoice.offer).not.toHaveBeenCalled();
  });

  it("first press reuses warm peer, opens microphone, and initiates service offer signaling", async () => {
    const { deps, getUserMedia, peers } = fakeWarmupDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);

    // Warm peer on availability
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });
    expect(peers).toHaveLength(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(bridge.pushToTalkVoice.offer).not.toHaveBeenCalled();

    // First press occurs: listening becomes true
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: false,
      contextId: 1,
    });

    // Reuses the warm peer without closing or recreating
    expect(peers).toHaveLength(1);
    expect(peers[0]?.closed).toBe(false);

    // Microphone is opened now that press occurred
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });

    // Signaling begins on press
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledWith({
      generation: 1,
      sdp: "offer-sdp",
    });
  });

  it("delayed getUserMedia resolving after valid release sends no audio, stops microphone tracks, and reports media_delayed", async () => {
    const deferredMedia = Promise.withResolvers<MediaStream>();
    const micTrack = new FakeMediaStreamTrack();
    const stream = new FakeMediaStream([micTrack]) as unknown as MediaStream;

    const { deps, getUserMedia, peers, destinationTracks } = fakeWarmupDeps({
      getUserMediaImpl: async () => deferredMedia.promise,
    });
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);

    // 1. Warm hidden window and peer
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });
    expect(peers).toHaveLength(1);

    // 2. User presses shortcut (listening: true)
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 1,
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // 3. User releases shortcut before getUserMedia resolves (valid release: listening: false)
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: true,
      contextId: 1,
    });

    // 4. getUserMedia completes late after release
    await act(async () => {
      deferredMedia.resolve(stream);
      await flush();
    });

    // Delayed media after valid release must stop microphone track so physical mic is not left active
    expect(micTrack.stop).toHaveBeenCalled();

    // Destination track must not be enabled to transmit audio
    expect(destinationTracks[0]?.enabled).toBe(false);

    // Reports media_delayed with contextId to Main so presentation is cleared and no context is sent
    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 1,
      event: { kind: "media_delayed", contextId: 1 },
    });
  });

  it("recovers for a later gesture when media arrives after two releases", async () => {
    const pending = Promise.withResolvers<MediaStream>();
    const firstTrack = new FakeMediaStreamTrack();
    let requests = 0;
    const { deps, getUserMedia } = fakeWarmupDeps({
      getUserMediaImpl: () =>
        ++requests === 1
          ? pending.promise
          : Promise.resolve(new FakeMediaStream() as unknown as MediaStream),
    });
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    const session = {
      active: true,
      generation: 1,
      admitted: false,
      qualified: true,
    } as const;
    await bridge.publish({ ...session, revision: 1, listening: true, contextId: 1 });
    await bridge.publish({ ...session, revision: 2, listening: false, contextId: 1 });
    await bridge.publish({ ...session, revision: 3, listening: true, contextId: 2 });
    await bridge.publish({ ...session, revision: 4, listening: false, contextId: 2 });
    await act(async () => {
      pending.resolve(new FakeMediaStream([firstTrack]) as unknown as MediaStream);
      await flush();
    });
    expect(firstTrack.stopped).toBe(true);
    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 1,
      event: { kind: "media_delayed", contextId: 2 },
    });

    await bridge.publish({ ...session, revision: 5, listening: true, contextId: 3 });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledWith({
      generation: 1,
      sdp: "offer-sdp",
    });
  });

  it("preserves post-release buffered signaling when mic was ready during valid gesture", async () => {
    const { deps, peers, getUserMedia } = fakeWarmupDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);

    // 1. Warm hidden window and peer
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    // 2. Press shortcut: mic becomes ready during gesture
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 1,
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // 3. User releases after valid hold: listening becomes false
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: true,
      contextId: 1,
    });

    // Signaling completes and sends offer even post-release to deliver buffered audio
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledWith({
      generation: 1,
      sdp: "offer-sdp",
    });
    expect(peers[0]?.closed).toBe(false);
  });
});
