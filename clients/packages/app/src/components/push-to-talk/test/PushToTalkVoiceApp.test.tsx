import type {
  PushToTalkVoiceReport,
  PushToTalkVoiceSession,
} from "@comma/native-bridge";
import { act, render } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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
  const destinationTracks: FakeMediaStreamTrack[] = [];
  const playedSamples: number[][] = [];
  const audioProcessors: {
    connect: Mock;
    disconnect: Mock;
    onaudioprocess:
      | ((e: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void)
      | null;
  }[] = [];
  const bufferSources: (EventTarget & {
    buffer: { getChannelData?: () => Float32Array; length?: number } | null;
    started: boolean;
    stopped: boolean;
    connect: Mock;
    disconnect: Mock;
    start: Mock;
    stop: Mock;
  })[] = [];
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

  const pushMicAudio = (samples: Float32Array) => {
    for (const proc of audioProcessors) {
      proc.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => samples,
        },
      });
    }
  };

  const deps: PushToTalkPeerDeps = {
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createAudioContext: () => {
      const record = { closed: false };
      contexts.push(record);
      const node = { connect: vi.fn((next: unknown) => next), disconnect: vi.fn() };
      return {
        sampleRate: 48000,
        createAnalyser: () => ({
          fftSize: 512,
          getFloatTimeDomainData: (data: Float32Array) => data.fill(level.value),
        }),
        createMediaStreamSource: () => node,
        createMediaStreamDestination: () => {
          const track = new FakeMediaStreamTrack();
          track.enabled = false;
          destinationTracks.push(track);
          return {
            stream: new FakeMediaStream([track]),
          };
        },
        createGain: () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: { value: 1 },
        }),
        createScriptProcessor: vi.fn(() => {
          const proc = {
            connect: vi.fn(),
            disconnect: vi.fn(),
            onaudioprocess: null as
              | ((e: {
                  inputBuffer: { getChannelData: (c: number) => Float32Array };
                }) => void)
              | null,
          };
          audioProcessors.push(proc);
          return proc;
        }),
        createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
          const channelData = new Float32Array(length);
          return {
            channels,
            length,
            sampleRate,
            getChannelData: () => channelData,
            copyToChannel: vi.fn((source: Float32Array) => {
              channelData.set(source);
            }),
          };
        }),
        createBufferSource: () => {
          const src = Object.assign(new EventTarget(), {
            buffer: null as {
              getChannelData?: () => Float32Array;
              length?: number;
            } | null,
            started: false,
            stopped: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(() => {
              src.started = true;
              if (src.buffer?.getChannelData) {
                playedSamples.push(Array.from(src.buffer.getChannelData()));
              }
            }),
            stop: vi.fn(() => {
              src.stopped = true;
            }),
          });
          bufferSources.push(src);
          return src;
        },
        resume: async () => undefined,
        close: async () => {
          record.closed = true;
        },
      } as unknown as AudioContext;
    },
    createAudio: () => audio as unknown as HTMLAudioElement,
    getUserMedia: (c) => getUserMedia(c),
  };

  return {
    audio,
    audioProcessors,
    bufferSources,
    contexts,
    deps,
    destinationTracks,
    getUserMedia,
    level,
    micStreams,
    micTracks,
    peers,
    playedSamples,
    pushMicAudio,
  };
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

describe("PushToTalkVoiceApp", () => {
  it("captures microphone muted by default before adding track, offers SDP, and reports level at 20Hz", async () => {
    vi.useFakeTimers();
    const { deps, peers, destinationTracks, level } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    expect(peers).toHaveLength(0);

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    expect(peers).toHaveLength(1);
    const [peer] = peers;
    expect(peer?.tracks).toEqual(destinationTracks);
    expect(peer?.trackStateAtAdd[0]).toBe(false);
    expect(destinationTracks[0]?.enabled).toBe(false);

    // Real press: listening true with valid contextId initiates offer & level reports
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: false,
      contextId: 1,
    });

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
    const { deps, getUserMedia, peers, destinationTracks } = fakeDeps();
    const media = Promise.withResolvers<MediaStream>();
    getUserMedia.mockReturnValueOnce(media.promise);
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 1,
    });
    expect(bridge.pushToTalkVoice.offer).not.toHaveBeenCalled();
    const track = new FakeMediaStreamTrack();
    media.resolve(new FakeMediaStream([track]) as unknown as MediaStream);
    await act(flush);
    expect(peers[0]?.tracks).toEqual(destinationTracks);
    expect(bridge.pushToTalkVoice.offer).toHaveBeenCalledOnce();
    expect(destinationTracks[0]?.enabled).toBe(false);
  });

  it("cold buffering: captures into buffer and only enables transmission after connected, admitted, and >=300ms", async () => {
    vi.useFakeTimers();
    const {
      audio,
      deps,
      peers,
      destinationTracks,
      bufferSources,
      pushMicAudio,
      playedSamples,
    } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    // User presses hotkey on cold start
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 101,
    });

    const [peer] = peers;
    expect(peer?.connectionState).toBe("new");
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(audio.muted).toBe(true);

    // Push pre-connect audio samples into mic capture
    pushMicAudio(new Float32Array([1.0, 2.0, 3.0]));
    pushMicAudio(new Float32Array([4.0, 5.0, 6.0]));

    // Advance 350ms (>= 300ms gesture confirmed), but not yet connected or admitted
    await act(async () => vi.advanceTimersByTime(350));
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(bufferSources).toHaveLength(0);
    expect(playedSamples).toHaveLength(0);

    // Peer connects, but still admitted = false
    act(() => peer?.setConnectionState("connected"));
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(playedSamples).toHaveLength(0);

    // Main admits turn
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 101,
      qualified: true,
    });

    // Now connected + admitted + >=300ms: transmission enabled and pre-connect audio reaches destination
    expect(destinationTracks[0]?.enabled).toBe(true);
    expect(bufferSources.length).toBeGreaterThanOrEqual(1);
    expect(bufferSources[0]?.started).toBe(true);
    expect(playedSamples.flat()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("short tap gesture under 300ms is discarded and never transmits", async () => {
    vi.useFakeTimers();
    const {
      audio,
      deps,
      peers,
      destinationTracks,
      bufferSources,
      pushMicAudio,
      playedSamples,
    } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    // Press
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 102,
    });
    expect(audio.muted).toBe(true);

    // Push audio during short tap
    pushMicAudio(new Float32Array([7.0, 8.0]));

    // Release after 150ms (< 300ms)
    await act(async () => vi.advanceTimersByTime(150));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: false,
      contextId: 102,
    });
    expect(audio.muted).toBe(false);
    expect(destinationTracks[0]?.enabled).toBe(false);

    // Later connects and Main publishes admitted = true
    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: true,
      contextId: 102,
    });

    // Short tap must NEVER transmit!
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(bufferSources).toHaveLength(0);
    expect(playedSamples).toHaveLength(0);
  });

  it("release during connect with valid gesture >= 300ms retains buffer and replays once connected and admitted", async () => {
    vi.useFakeTimers();
    const {
      audio,
      deps,
      peers,
      destinationTracks,
      bufferSources,
      pushMicAudio,
      playedSamples,
    } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    // Press
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 103,
    });

    // Push pre-connect audio samples
    pushMicAudio(new Float32Array([1.0, 2.0, 3.0]));

    // Hold for 400ms (>= 300ms)
    await act(async () => vi.advanceTimersByTime(400));

    // Release before RTC connects
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: false,
      contextId: 103,
      qualified: true,
    });
    expect(audio.muted).toBe(false);
    expect(destinationTracks[0]?.enabled).toBe(false);

    // RTC connects
    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    // Main admits turn with same contextId
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: true,
      contextId: 103,
      qualified: true,
    });

    // Buffer replays to destination track
    expect(destinationTracks[0]?.enabled).toBe(true);
    expect(bufferSources.length).toBeGreaterThanOrEqual(1);
    expect(bufferSources[0]?.started).toBe(true);
    expect(playedSamples.flat()).toEqual([1, 2, 3]);

    // When drain finishes, track disables
    act(() => {
      bufferSources[0]?.dispatchEvent(new Event("ended"));
    });
    expect(destinationTracks[0]?.enabled).toBe(false);
  });

  it("press mid-response immediately mutes remote audio and release restores without waiting for caption", async () => {
    vi.useFakeTimers();
    const { audio, deps, peers, level } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    // Remote incoming media arrives while user is not pressing
    const stream = {} as MediaStream;
    act(() => peer?.ontrack?.({ track: {} as MediaStreamTrack, streams: [stream] }));
    expect(audio.srcObject).toBe(stream);
    expect(audio.play).toHaveBeenCalled();
    expect(audio.muted).toBe(false);

    // Agent is speaking mid-response, user presses hotkey
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: false,
      contextId: 104,
    });
    // Remote audio is muted immediately!
    expect(audio.muted).toBe(true);

    // User releases hotkey
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: false,
      contextId: 104,
    });
    // Remote audio is unmuted immediately without caption event!
    expect(audio.muted).toBe(false);

    // Incoming audio level reports audible and silent normally
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

  it("warm path buffers until 300ms gesture qualification then streams live", async () => {
    vi.useFakeTimers();
    const {
      audio,
      deps,
      peers,
      destinationTracks,
      bufferSources,
      pushMicAudio,
      playedSamples,
    } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    // User presses hotkey while already connected and admitted
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 105,
    });
    expect(audio.muted).toBe(true);

    pushMicAudio(new Float32Array([1.0, 2.0]));

    // T = 100ms (< 300ms): not yet qualified, still buffering
    await act(async () => vi.advanceTimersByTime(100));
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(playedSamples).toHaveLength(0);

    // T = 300ms: >= 300ms qualification reached
    await act(async () => vi.advanceTimersByTime(200));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: true,
      admitted: true,
      contextId: 105,
      qualified: true,
    });
    expect(destinationTracks[0]?.enabled).toBe(true);
    expect(bufferSources.length).toBeGreaterThanOrEqual(1);
    expect(playedSamples.flat()).toEqual([1, 2]);

    // Drain finishes while still listening -> stays enabled for live streaming
    act(() => {
      bufferSources[0]?.dispatchEvent(new Event("ended"));
    });
    expect(destinationTracks[0]?.enabled).toBe(true);

    // User releases hotkey at T = 800ms
    await act(async () => vi.advanceTimersByTime(500));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 4,
      listening: false,
      admitted: false,
      contextId: null,
    });
    expect(destinationTracks[0]?.enabled).toBe(false);
    expect(audio.muted).toBe(false);
  });

  it("new contextId or cancellation discards pending buffer without leaking to next gesture", async () => {
    vi.useFakeTimers();
    const { deps, peers, destinationTracks, pushMicAudio, playedSamples } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);

    // Gesture 1
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 106,
    });
    pushMicAudio(new Float32Array([9.0, 9.0]));
    await act(async () => vi.advanceTimersByTime(350));

    // Cancelled / reset
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: false,
      contextId: null,
    });
    expect(destinationTracks[0]?.enabled).toBe(false);

    // Gesture 2 with new contextId
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: true,
      admitted: false,
      contextId: 107,
    });
    pushMicAudio(new Float32Array([4.0, 5.0]));
    await act(async () => vi.advanceTimersByTime(350));
    act(() => peers[0]?.setConnectionState("connected"));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 4,
      listening: true,
      admitted: true,
      contextId: 107,
      qualified: true,
    });

    expect(destinationTracks[0]?.enabled).toBe(true);
    // Only gesture 2 was replayed, gesture 1 was not replayed
    expect(playedSamples.flat()).toEqual([4, 5]);
  });

  it("preserves the captured microphone block delivered just after release without reopening the mic", async () => {
    vi.useFakeTimers();
    const { deps, peers, pushMicAudio, playedSamples, micTracks, audio } = fakeDeps();
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: true,
      contextId: 202,
    });
    act(() => peers[0]?.setConnectionState("connected"));
    await act(async () => vi.advanceTimersByTime(350));
    pushMicAudio(new Float32Array([1, 2]));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: true,
      contextId: 202,
      qualified: true,
    });
    expect(micTracks[0]?.enabled).toBe(false);
    expect(audio.muted).toBe(false);
    // WebAudio delivers its already captured input block asynchronously.
    pushMicAudio(new Float32Array([3, 4]));
    pushMicAudio(new Float32Array([0, 0]));
    expect(playedSamples.flat()).toEqual([1, 2, 3, 4]);
    expect(micTracks[0]?.enabled).toBe(false);
  });

  it("uses Main's qualification when a cold renderer observes only the end of a valid gesture", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await vi.advanceTimersByTimeAsync(200);
    const { deps, peers, pushMicAudio, playedSamples } = fakeDeps();
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: true,
      contextId: 203,
      qualified: false,
    });
    act(() => peers[0]?.setConnectionState("connected"));
    pushMicAudio(new Float32Array([7, 8]));
    await act(async () => vi.advanceTimersByTime(110));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: true,
      contextId: 203,
      qualified: true,
    });
    expect(playedSamples.flat()).toEqual([7, 8]);
  });

  it("does not send a Main-rejected short tap when the renderer receives release after 300ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { deps, peers, pushMicAudio, playedSamples } = fakeDeps();
    const bridge = installVoiceBridge();
    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: true,
      contextId: 204,
      qualified: false,
    });
    act(() => peers[0]?.setConnectionState("connected"));
    pushMicAudio(new Float32Array([9, 10]));
    // Main released at 1290, but its snapshot arrives 20ms later.
    await act(async () => vi.advanceTimersByTime(310));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: false,
      admitted: true,
      contextId: 204,
      qualified: false,
    });
    expect(playedSamples.flat()).toEqual([]);
  });

  it("distinct PCM blocks captured before connect, during replay, and live reach destination in chronological order, each exactly once", async () => {
    vi.useFakeTimers();
    const { deps, peers, pushMicAudio, playedSamples } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    // Start gesture
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      admitted: false,
      contextId: 201,
    });

    // Block A: before connect
    pushMicAudio(new Float32Array([1.0, 2.0]));

    await act(async () => vi.advanceTimersByTime(350));
    act(() => peers[0]?.setConnectionState("connected"));
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 201,
      qualified: true,
    });

    // Block B: during replay
    pushMicAudio(new Float32Array([3.0, 4.0]));

    // Block C: live
    pushMicAudio(new Float32Array([5.0, 6.0]));

    // Release
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: false,
      contextId: null,
    });

    // All blocks must reach destination in exact chronological order without duplicates or drops
    expect(playedSamples.flat()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("physical microphone track enabled strictly follows listening capture state", async () => {
    const { deps, micTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    expect(micTracks).toHaveLength(0);

    // Press: listening true
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: false,
      contextId: 301,
    });
    expect(micTracks[0]?.enabled).toBe(true);

    // Release: listening false
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 3,
      listening: false,
      admitted: false,
      contextId: 301,
    });
    expect(micTracks[0]?.enabled).toBe(false);
  });

  it("same generation snapshot updates listening without recreating peer", async () => {
    const { deps, peers } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      admitted: false,
      contextId: null,
    });

    expect(peers).toHaveLength(1);
    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      admitted: true,
      contextId: 108,
    });

    expect(peers).toHaveLength(1);
    expect(peer?.closed).toBe(false);
  });

  it("ignores stale revision and older generation replay", async () => {
    const { deps, peers } = fakeDeps();
    const bridge = installVoiceBridge();

    render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 5,
      listening: true,
      admitted: false,
      contextId: 109,
    });

    const [peer] = peers;
    act(() => peer?.setConnectionState("connected"));

    // Stale revision of same generation
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 4,
      listening: false,
      admitted: false,
      contextId: 109,
    });

    // Older generation replay
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 10,
      listening: false,
      admitted: false,
      contextId: 109,
    });
    expect(peer?.closed).toBe(false);
  });

  it("stops acquired microphone tracks and releases resources on session close or unmount", async () => {
    const { audio, contexts, deps, peers, micTracks, destinationTracks } = fakeDeps();
    const bridge = installVoiceBridge();

    const { unmount } = render(<PushToTalkVoiceApp deps={deps} />);
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: false,
      contextId: null,
      admitted: false,
    });

    const [peer] = peers;
    expect(destinationTracks[0]?.stopped).toBe(false);

    // Press: acquire microphone track
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 2,
      listening: true,
      contextId: 1,
      admitted: false,
    });
    expect(micTracks[0]?.stopped).toBe(false);

    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
      contextId: null,
      admitted: false,
    });

    expect(peer?.closed).toBe(true);
    expect(micTracks[0]?.stopped).toBe(true);
    expect(destinationTracks[0]?.stopped).toBe(true);
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

    // Press initiates getUserMedia acquisition
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      contextId: 1,
      admitted: false,
    });

    // Session closes before getUserMedia resolves
    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
      contextId: null,
      admitted: false,
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

    // Press triggers getUserMedia which encounters permission denial
    await bridge.publish({
      active: true,
      generation: 1,
      revision: 1,
      listening: true,
      contextId: 1,
      admitted: false,
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
    // Press initiates signaling offer
    await bridge.publish({
      active: true,
      generation: 2,
      revision: 1,
      listening: true,
      contextId: 1,
      admitted: false,
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
      contextId: 1,
      admitted: true,
    });
    act(() => peers[0]?.setConnectionState("connected"));
    await bridge.publish({
      active: false,
      generation: 2,
      revision: 1,
      listening: false,
      contextId: null,
      admitted: false,
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
      contextId: 2,
      admitted: true,
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
