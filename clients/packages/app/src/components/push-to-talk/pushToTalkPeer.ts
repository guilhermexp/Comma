import type { PushToTalkVoiceReport } from "@comma/native-bridge";

/** Browser media the peer uses; tests pass fakes. */
export type PushToTalkPeerDeps = {
  createPeer: () => RTCPeerConnection;
  createAudioContext: () => AudioContext;
  createAudio: () => HTMLAudioElement;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

export const browserPushToTalkPeerDeps: PushToTalkPeerDeps = {
  createPeer: () => new RTCPeerConnection(),
  createAudioContext: () => new AudioContext(),
  createAudio: () => new Audio(),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
};

export type PushToTalkVoiceReportEvent = PushToTalkVoiceReport;

export type OpenPushToTalkPeerOptions = {
  deps?: PushToTalkPeerDeps;
  /** Resolves with Main's answer, or `null` when Main no longer wants this peer. */
  offer: (sdp: string) => Promise<{ sdp: string } | null>;
  report: (event: PushToTalkVoiceReport) => void;
  listening?: boolean;
};

export type PushToTalkPeer = {
  close: () => void;
  update: (input: { listening?: boolean }) => void;
};

/** RMS of the received audio above which the voice counts as audible. */
const audibleLevel = 0.01;
/** Below the level this long, the voice counts as quiet. */
const quietAfterMs = 300;
const levelIntervalMs = 50;
const iceGatherMs = 5_000;

// This signaling transport has no trickle endpoint. Use the gathered local SDP.
function gatherIce(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === "complete" || signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(timer);
    pc.removeEventListener("icegatheringstatechange", changed);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const changed = () => {
    if (pc.iceGatheringState === "complete") done();
  };
  const timer = setTimeout(done, iceGatherMs);
  pc.addEventListener("icegatheringstatechange", changed);
  signal.addEventListener("abort", done, { once: true });
  changed();
  return promise;
}

/**
 * The media half of a Talk to agent call (D12-D14 of add-push-to-talk-agent).
 * Captures microphone audio muted by default until connected AND listening.
 * Reports microphone levels at 20 Hz, connection, and incoming speech state.
 */
export function openPushToTalkPeer({
  deps = browserPushToTalkPeerDeps,
  offer,
  report,
  listening: initialListening = false,
}: OpenPushToTalkPeerOptions): PushToTalkPeer {
  const abort = new AbortController();
  const pc = deps.createPeer();
  const context = deps.createAudioContext();
  const audio = deps.createAudio();

  let listening = initialListening;

  let connected = false;
  let failed = false;
  let micStream: MediaStream | undefined;
  let inputLevelTimer: ReturnType<typeof setInterval> | undefined;
  let remoteLevelTimer: ReturnType<typeof setInterval> | undefined;

  const channel = pc.createDataChannel("oai-events");

  const applyTrackEnabled = () => {
    const shouldEnable = connected && listening;
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.enabled = shouldEnable;
      }
    }
  };

  const onTrackEnded = () => {
    if (abort.signal.aborted) return;
    fail();
  };

  const close = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearInterval(inputLevelTimer);
    clearInterval(remoteLevelTimer);
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.removeEventListener("ended", onTrackEnded);
        track.stop();
      }
    }
    try {
      channel.close();
    } catch {}
    try {
      pc.close();
    } catch {}
    audio.pause();
    audio.srcObject = null;
    void context.close().catch(() => undefined);
  };

  const fail = () => {
    if (abort.signal.aborted || failed) return;
    failed = true;
    report("failed");
  };

  const watchInputLevel = (stream: MediaStream) => {
    if (abort.signal.aborted) return;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    try {
      context.createMediaStreamSource(stream).connect(analyser);
    } catch {
      return;
    }
    const samples = new Float32Array(analyser.fftSize);
    clearInterval(inputLevelTimer);
    inputLevelTimer = setInterval(() => {
      if (abort.signal.aborted) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.min(1, Math.max(0, rms));
      report({ kind: "level", level });
    }, 50); // 20 Hz
  };

  const watchRemoteLevel = (stream: MediaStream) => {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    try {
      context.createMediaStreamSource(stream).connect(analyser);
    } catch {
      return;
    }
    const samples = new Float32Array(analyser.fftSize);
    let audible = false;
    let quietSince: number | undefined;
    clearInterval(remoteLevelTimer);
    remoteLevelTimer = setInterval(() => {
      if (abort.signal.aborted) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const loud = Math.sqrt(sum / samples.length) > audibleLevel;
      const now = Date.now();
      if (loud) {
        quietSince = undefined;
        if (!audible) {
          audible = true;
          report("audible");
        }
      } else if (audible) {
        quietSince ??= now;
        if (now - quietSince >= quietAfterMs) {
          audible = false;
          quietSince = undefined;
          report("silent");
        }
      }
    }, levelIntervalMs);
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    audio.srcObject = stream;
    audio.play().catch(fail);
    void context.resume().catch(() => undefined);
    watchRemoteLevel(stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      if (!connected) {
        connected = true;
        report("connected");
        applyTrackEnabled();
      }
    } else if (pc.connectionState === "failed") {
      fail();
    }
  };

  // The initial SDP must include the muted microphone track.
  const microphoneReady = (async () => {
    try {
      const stream = await deps.getUserMedia({ audio: true });
      if (abort.signal.aborted) {
        for (const track of stream.getAudioTracks()) track.stop();
        return;
      }
      micStream = stream;
      // Must be muted before addTrack!
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
        pc.addTrack(track, stream);
        track.addEventListener("ended", onTrackEnded);
      }
      applyTrackEnabled();
      watchInputLevel(stream);
      return true;
    } catch (error) {
      if (abort.signal.aborted) return;
      const isPermissionDenied =
        (error instanceof Error &&
          (error.name === "NotAllowedError" ||
            error.name === "PermissionDeniedError")) ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error.name === "NotAllowedError" || error.name === "PermissionDeniedError"));
      if (isPermissionDenied) {
        report("microphone_denied");
      } else {
        fail();
      }
    }
  })();

  // Signaling
  void (async () => {
    try {
      if (!(await microphoneReady) || abort.signal.aborted) return;
      await pc.setLocalDescription(await pc.createOffer());
      await gatherIce(pc, abort.signal);
      const sdp = pc.localDescription?.sdp;
      if (abort.signal.aborted) return;
      if (!sdp) throw new Error("No local SDP.");
      const answer = await offer(sdp);
      if (abort.signal.aborted) return;
      if (!answer) {
        close();
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch {
      fail();
    }
  })();

  const update = (input: { listening?: boolean }) => {
    if (abort.signal.aborted) return;
    if (input.listening !== undefined) {
      listening = input.listening;
      applyTrackEnabled();
    }
  };

  return { close, update };
}
