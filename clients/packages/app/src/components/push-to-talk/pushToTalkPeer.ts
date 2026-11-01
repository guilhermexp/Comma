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
  admitted?: boolean;
  contextId?: number | null;
  qualified: boolean;
};

export type PushToTalkPeer = {
  close: () => void;
  update: (input: {
    listening?: boolean;
    admitted?: boolean;
    contextId?: number | null;
    qualified?: boolean;
  }) => void;
};

/** RMS of the received audio above which the voice counts as audible. */
const audibleLevel = 0.01;
/** Below the level this long, the voice counts as quiet. */
const quietAfterMs = 300;
const levelIntervalMs = 50;
const iceGatherMs = 5_000;
const maxBufferSeconds = 120;

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
 * The media half of Talk to agent (D12-D16 of add-push-to-talk-agent).
 * Captures locally during the gesture and sends after connection/admission.
 * Reports microphone levels at 20 Hz, connection, and incoming speech state.
 */
export function openPushToTalkPeer({
  deps = browserPushToTalkPeerDeps,
  offer,
  report,
  listening: initialListening = false,
  admitted: initialAdmitted = false,
  contextId: initialContextId = null,
  qualified: initialQualified,
}: OpenPushToTalkPeerOptions): PushToTalkPeer {
  const abort = new AbortController();
  const pc = deps.createPeer();
  const context = deps.createAudioContext();
  const audio = deps.createAudio();

  let listening = initialListening;
  let admitted = initialAdmitted;
  let currentContextId: number | null = initialContextId;

  let connected = false;
  let failed = false;
  let micStream: MediaStream | undefined;
  let processor: ScriptProcessorNode | undefined;
  let inputLevelTimer: ReturnType<typeof setInterval> | undefined;
  let remoteLevelTimer: ReturnType<typeof setInterval> | undefined;

  let isGestureQualified = initialQualified;
  let isGestureDisqualified = false;
  let drainInputOnRelease = false;

  // Single chronological send queue
  const pendingChunks: Float32Array<ArrayBuffer>[] = [];
  const activeSources = new Set<AudioBufferSourceNode>();
  let playbackTime = 0;
  let totalCapturedSamplesInGesture = 0;

  const sampleRate = context.sampleRate || 48000;
  const maxSamples = sampleRate * maxBufferSeconds;

  const channel = pc.createDataChannel("oai-events");

  const destination = context.createMediaStreamDestination();
  const [destinationTrack] = destination.stream.getAudioTracks();
  if (destinationTrack) {
    destinationTrack.enabled = false;
    pc.addTrack(destinationTrack, destination.stream);
  }

  // Audio output element immediately mutes on listening press, restores on release
  audio.muted = listening;
  void context.resume().catch(() => undefined);

  const applyPhysicalMicEnabled = () => {
    const shouldEnable =
      listening && currentContextId !== null && !abort.signal.aborted;
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.enabled = shouldEnable;
      }
    }
  };

  const discardBuffer = () => {
    drainInputOnRelease = false;
    for (const source of activeSources) {
      try {
        source.stop();
      } catch {}
      try {
        source.disconnect();
      } catch {}
    }
    activeSources.clear();
    pendingChunks.length = 0;
    playbackTime = 0;
    if (destinationTrack) destinationTrack.enabled = false;
  };

  const schedulePendingAudio = () => {
    if (abort.signal.aborted || currentContextId === null) return;
    if (isGestureDisqualified) return;

    if (!isGestureQualified) return;
    if (!connected || !admitted) return;

    if (pendingChunks.length === 0) return;

    if (destinationTrack) destinationTrack.enabled = true;

    const currentTime = context.currentTime;
    if (playbackTime < currentTime) {
      playbackTime = currentTime;
    }

    while (pendingChunks.length > 0) {
      const chunk = pendingChunks.shift()!;
      const audioBuffer = context.createBuffer(1, chunk.length, sampleRate);
      audioBuffer.copyToChannel(chunk, 0);

      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destination);
      activeSources.add(source);

      const chunkDuration = chunk.length / sampleRate;
      const startTime = playbackTime;
      playbackTime += chunkDuration;

      source.addEventListener(
        "ended",
        () => {
          activeSources.delete(source);
          if (activeSources.size === 0 && pendingChunks.length === 0 && !listening) {
            if (destinationTrack) destinationTrack.enabled = false;
          }
        },
        { once: true }
      );

      source.start(startTime);
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
    discardBuffer();
    if (processor) {
      try {
        processor.disconnect();
      } catch {}
      processor.onaudioprocess = null;
    }
    if (micStream) {
      for (const track of micStream.getAudioTracks()) {
        track.removeEventListener("ended", onTrackEnded);
        track.enabled = false;
        track.stop();
      }
    }
    if (destinationTrack) {
      destinationTrack.stop();
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
    audio.muted = listening;
    audio.play().catch(fail);
    void context.resume().catch(() => undefined);
    watchRemoteLevel(stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      if (!connected) {
        connected = true;
        report("connected");
        schedulePendingAudio();
      }
    } else if (pc.connectionState === "failed") {
      fail();
    }
  };

  let micInitiated = false;
  let micReadyPromise: Promise<boolean> | undefined;

  const ensureMicrophone = () => {
    if (micInitiated || abort.signal.aborted) return micReadyPromise;
    micInitiated = true;
    micReadyPromise = (async () => {
      try {
        void context.resume().catch(() => undefined);
        const stream = await deps.getUserMedia({ audio: true });
        if (abort.signal.aborted) {
          for (const track of stream.getAudioTracks()) track.stop();
          return false;
        }
        if (!listening) {
          for (const track of stream.getAudioTracks()) track.stop();
          discardBuffer();
          micInitiated = false;
          micReadyPromise = undefined;
          signalingStarted = false;
          if (currentContextId !== null) {
            report({ kind: "media_delayed", contextId: currentContextId });
          }
          return false;
        }
        micStream = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", onTrackEnded);
        }
        applyPhysicalMicEnabled();

        const micSource = context.createMediaStreamSource(stream);

        // Create processor to buffer and stream PCM audio chronologically
        processor = context.createScriptProcessor(4096, 1, 1);
        micSource.connect(processor);
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        try {
          silentGain.connect(context.destination);
        } catch {}
        processor.onaudioprocess = (e) => {
          if (abort.signal.aborted) return;
          if (
            (!listening && !drainInputOnRelease) ||
            currentContextId === null ||
            isGestureDisqualified
          )
            return;
          // The track is already muted on release. Drain only its in-flight block,
          // which WebAudio delivers after the gesture's final captured samples.
          drainInputOnRelease = false;
          const channelData = e.inputBuffer.getChannelData(0);
          if (totalCapturedSamplesInGesture + channelData.length <= maxSamples) {
            totalCapturedSamplesInGesture += channelData.length;
            const copy = new Float32Array(channelData);
            pendingChunks.push(copy);
            schedulePendingAudio();
          }
        };

        watchInputLevel(stream);
        return true;
      } catch (error) {
        if (abort.signal.aborted) return false;
        const isPermissionDenied =
          (error instanceof Error &&
            (error.name === "NotAllowedError" ||
              error.name === "PermissionDeniedError")) ||
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            (error.name === "NotAllowedError" ||
              error.name === "PermissionDeniedError"));
        if (isPermissionDenied) {
          report("microphone_denied");
        } else {
          fail();
        }
        return false;
      }
    })();
    return micReadyPromise;
  };

  let signalingStarted = false;
  const startSignaling = async () => {
    if (signalingStarted || abort.signal.aborted) return;
    signalingStarted = true;
    try {
      const micReady = await ensureMicrophone();
      if (!micReady || abort.signal.aborted) return;
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
  };

  if (initialListening) {
    void startSignaling();
  }

  const update = (input: {
    listening?: boolean;
    admitted?: boolean;
    contextId?: number | null;
    qualified?: boolean;
  }) => {
    if (abort.signal.aborted) return;

    let contextChanged = false;
    if (input.contextId !== undefined && input.contextId !== currentContextId) {
      discardBuffer();
      currentContextId = input.contextId;
      isGestureQualified = false;
      isGestureDisqualified = false;
      totalCapturedSamplesInGesture = 0;
      contextChanged = true;
    }

    if (input.qualified !== undefined) isGestureQualified = input.qualified;

    let listeningChanged = false;
    if (input.listening !== undefined && input.listening !== listening) {
      listening = input.listening;
      audio.muted = listening;
      listeningChanged = true;
    }

    if (input.admitted !== undefined && input.admitted !== admitted) {
      admitted = input.admitted;
      if (!admitted) {
        discardBuffer();
      }
    }

    // Reconcile gesture state after atomic updates
    if (contextChanged || listeningChanged) {
      if (currentContextId !== null && listening) {
        void startSignaling();
        void context.resume().catch(() => undefined);
        drainInputOnRelease = false;
        isGestureDisqualified = false;
      } else if (!listening) {
        if (!isGestureQualified) {
          isGestureDisqualified = true;
          discardBuffer();
        } else {
          drainInputOnRelease = true;
          if (activeSources.size === 0 && pendingChunks.length === 0) {
            if (destinationTrack) destinationTrack.enabled = false;
          }
        }
      }
    }

    applyPhysicalMicEnabled();
    schedulePendingAudio();
  };

  return { close, update };
}
