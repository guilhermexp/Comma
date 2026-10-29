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
    return { close: () => undefined };
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

function fakeDeps() {
  const peers: FakePeer[] = [];
  const level = { value: 0 };
  const micTracks: FakeMediaStreamTrack[] = [];
  const micStreams: FakeMediaStream[] = [];
  const contexts: { closed: boolean }[] = [];
  const audio = {
    autoplay: false,
    muted: false,
    srcObject: null as unknown,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  };

  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    const track = new FakeMediaStreamTrack();
    micTracks.push(track);
    const stream = new FakeMediaStream([track]);
    micStreams.push(stream);
    return stream as unknown as MediaStream;
  });

  const deps: PushToTalkPeerDeps = {
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createAudioContext: () => {
      const record = { closed: false };
      contexts.push(record);
      const node = { connect: (next: unknown) => next };
      return {
        createAnalyser: () => ({
          fftSize: 512,
          getFloatTimeDomainData: (data: Float32Array) => data.fill(level.value),
        }),
        createMediaStreamSource: () => node,
        resume: async () => undefined,
        close: async () => {
          record.closed = true;
        },
      } as unknown as AudioContext;
    },
    createAudio: () => audio as unknown as HTMLAudioElement,
    getUserMedia: (c) => getUserMedia(c),
  };

  return { audio, contexts, deps, getUserMedia, level, micStreams, micTracks, peers };
}

function installVoiceBridge() {
  let listener: ((session: PushToTalkVoiceSession) => void) | undefined;
  const idle: PushToTalkVoiceSession = {
    active: false,
    generation: 0,
    revision: 0,
    listening: false,
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
    publish: async (session: PushToTalkVoiceSession) => {
      act(() => listener?.(session));
      await act(flush);
    },
    pushToTalkVoice,
  };
}

afterEach(() => vi.useRealTimers());

describe("PushToTalkVoiceApp", () => {
  it("captures microphone muted by default before adding track, offers SDP, and reports level at 20Hz", async () => {
    vi.useFakeTimers();
    const { deps, peers, micTracks, level } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    expect(peers).toHaveLength(0);

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
    });

    expect(peers).toHaveLength(1);
    const [peer] = peers;
    expect(peer?.tracks).toEqual(micTracks);
    expect(peer?.trackStateAtAdd[0]).toBe(false);
    expect(micTracks[0]?.enabled).toBe(false);
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledWith({
      generation: 1,
      sdp: "offer-sdp",
    });

    level.value = 0.5;
    await act(async () => vi.advanceTimersByTime(50));
    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 1,
      event: { kind: "level", level: expect.any(Number) },
    });
  });

  it("waits for a microphone track before offering during first-use permission consent", async () => {
    const { deps, getUserMedia, peers } = fakeDeps();
    const media = Promise.withResolvers<MediaStream>();
    getUserMedia.mockReturnValueOnce(media.promise);
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
    });
    expect(bridge.pushToTalkVoice.offer).not.toHaveBeenCalled();
    const track = new FakeMediaStreamTrack();
    media.resolve(new FakeMediaStream([track]) as unknown as MediaStream);
    await act(flush);
    expect(peers[0]?.tracks).toEqual([track]);
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledOnce();
    expect(track.enabled).toBe(false);
    act(() => peers[0]?.setConnectionState("connected"));
    expect(track.enabled).toBe(true);
  });

  it("early release before RTC connects prevents delayed connection from unmuting track", async () => {
    const { deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
    });

    const [peer] = peers;
    expect(peer?.connectionState).toBe("new");
    expect(micTracks[0]?.enabled).toBe(false);

    // User releases hotkey before RTC connects
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
    });
    expect(micTracks[0]?.enabled).toBe(false);

    // RTC finally connects
    act(() => peer?.setConnectionState("connected"));
    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 1,
      event: "connected",
    });
    // Track must remain muted!
    expect(micTracks[0]?.enabled).toBe(false);
  });

  it("enables microphone track only when connected AND listening is true", async () => {
    const { deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
    });

    const [peer] = peers;
    expect(micTracks[0]?.enabled).toBe(false);

    // RTC connects -> unmutes
    act(() => peer?.setConnectionState("connected"));
    expect(micTracks[0]?.enabled).toBe(true);

    // Mutes on listening false
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
    });
    expect(micTracks[0]?.enabled).toBe(false);

    // Unmutes on listening true
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: true,
    });
    expect(micTracks[0]?.enabled).toBe(true);
  });

  it("same generation snapshot updates listening without recreating peer", async () => {
    const { deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
    });

    expect(peers).toHaveLength(1);
    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
    });

    expect(peers).toHaveLength(1);
    expect(peer?.closed).toBe(false);
    expect(micTracks[0]?.enabled).toBe(true);
  });

  it("ignores stale revision and older generation replay", async () => {
    const { deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 5,
      listening: true,
    });

    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));
    expect(micTracks[0]?.enabled).toBe(true);

    // Stale revision of same generation
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 4,
      listening: false,
    });
    expect(micTracks[0]?.enabled).toBe(true);

    // Older generation replay
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 10,
      listening: false,
    });
    expect(micTracks[0]?.enabled).toBe(true);
  });

  it("keeps real audio element unmuted when incoming media arrives while mic is held and before captions, and across listening toggles", async () => {
    vi.useFakeTimers();
    const { audio, deps, level, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    // Hotkey held (listening true) before any caption arrives
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
    });

    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));
    expect(micTracks[0]?.enabled).toBe(true);

    // Incoming remote media arrives while mic is held and before captions
    const stream = {} as MediaStream;
    act(() => peer?.ontrack?.({ track: {} as MediaStreamTrack, streams: [stream] }));
    expect(audio.srcObject).toBe(stream);
    expect(audio.play).toHaveBeenCalled();
    expect(audio.muted).toBe(false);

    // Releasing hotkey mutes mic track but does not drop or mute audio output
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
    });
    expect(micTracks[0]?.enabled).toBe(false);
    expect(audio.muted).toBe(false);
    expect(audio.srcObject).toBe(stream);

    // Re-pressing hotkey unmutes mic, audio output remains unmuted
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: true,
    });
    expect(micTracks[0]?.enabled).toBe(true);
    expect(audio.muted).toBe(false);

    // Incoming audio level triggers audible and silent reports
    level.value = 0.2;
    await act(async () => vi.advanceTimersByTime(100));
    level.value = 0;
    await act(async () => vi.advanceTimersByTime(1_000));

    expect(
      bridge.pushToTalkVoice.report.mock.calls.map(([input]) => input)
    ).toContainEqual({
      generation: 1,
      event: "audible",
    });
    expect(
      bridge.pushToTalkVoice.report.mock.calls.map(([input]) => input)
    ).toContainEqual({
      generation: 1,
      event: "silent",
    });
  });

  it("stops acquired microphone tracks and releases resources on session close or unmount", async () => {
    const { audio, contexts, deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    const { unmount } = render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
    });

    const [peer] = peers;
    expect(micTracks[0]?.stopped).toBe(false);

    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
    });

    expect(peer?.closed).toBe(true);
    expect(micTracks[0]?.stopped).toBe(true);
    expect(contexts[0]?.closed).toBe(true);
    expect(audio.pause).toHaveBeenCalled();

    unmount();
  });

  it("aborts slow getUserMedia acquisition and immediately stops tracks if session closes while pending", async () => {
    const { deps, peers } = fakeDeps();
    const { promise, resolve: resolveGetUserMedia } =
      Promise.withResolvers<MediaStream>();
    deps.getUserMedia = () => promise;

    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
    });

    // Session closes before getUserMedia resolves
    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
    });

    const lateTrack = new FakeMediaStreamTrack();
    const lateStream = new FakeMediaStream([lateTrack]);
    await act(async () => {
      resolveGetUserMedia(lateStream as unknown as MediaStream);
      await flush();
    });

    expect(lateTrack.stopped).toBe(true);
    expect(peers[0]?.tracks).not.toContain(lateTrack);
  });

  it("distinguishes microphone permission denied from generic peer failure", async () => {
    const { deps } = fakeDeps();
    const permissionError = new Error("Permission denied");
    permissionError.name = "NotAllowedError";
    deps.getUserMedia = vi.fn().mockRejectedValue(permissionError);

    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
    });

    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 1,
      event: "microphone_denied",
    });
  });

  it("drops the peer without an answer when Main returns null for offer", async () => {
    const { deps, peers } = fakeDeps();
    const bridge = installVoiceBridge();
    bridge.pushToTalkVoice.offer.mockResolvedValueOnce(null as never);

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 1,
      listening: false,
    });

    expect(peers[0]?.remote).toBeUndefined();
    expect(peers[0]?.closed).toBe(true);
  });

  it("reports failure when microphone track ends while connected, without false failure on ordinary close", async () => {
    const { deps, peers, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);

    // 1. Ordinary session start and clean close must not report failure
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
    });
    act(() => peers[0]?.setConnectionState("connected"));
    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
    });
    expect(bridge.pushToTalkVoice.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "failed" })
    );

    // 2. Active session where microphone track ends unexpectedly reports failure
    await bridge.publish({
      active: true,
      generation: 3,
      revision: 1,
      listening: true,
    });
    act(() => peers[1]?.setConnectionState("connected"));
    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 3,
      event: "connected",
    });

    act(() => {
      micTracks[1]?.dispatchEvent(new Event("ended"));
    });

    expect(bridge.pushToTalkVoice.report).toHaveBeenCalledWith({
      generation: 3,
      event: "failed",
    });
  });
});
