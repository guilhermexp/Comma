import type { PushToTalkVoiceReport } from "@comma/native-bridge";

/** Browser media the peer uses; tests pass fakes. */
export type ReadAloudPeerDeps = {
  createPeer: () => RTCPeerConnection;
  createAudioContext: () => AudioContext;
  createAudio: () => HTMLAudioElement;
};

export const browserReadAloudPeerDeps: ReadAloudPeerDeps = {
  createPeer: () => new RTCPeerConnection(),
  createAudioContext: () => new AudioContext(),
  createAudio: () => new Audio(),
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
  return new Promise((resolve) => {
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
  });
}

/**
 * The media half of a read-aloud call (D12 of add-push-to-talk-agent). The
 * input is a silent synthetic track, so no microphone or permission is used,
 * while GPT Live still receives the continuous input audio it expects. The
 * offer goes to Main, which signals the call with its Session; this plays
 * the received voice and reports when it becomes audible and quiet.
 */
export function openReadAloudPeer({
  deps = browserReadAloudPeerDeps,
  offer,
  report,
}: {
  deps?: ReadAloudPeerDeps;
  /** Resolves with Main's answer, or `null` when Main no longer wants this peer. */
  offer: (sdp: string) => Promise<{ sdp: string } | null>;
  report: (event: PushToTalkVoiceReport) => void;
}) {
  const abort = new AbortController();
  const pc = deps.createPeer();
  const context = deps.createAudioContext();
  const audio = deps.createAudio();
  audio.autoplay = true;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let failed = false;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0;
  const silence = context.createMediaStreamDestination();
  oscillator.connect(gain).connect(silence);
  oscillator.start();
  for (const track of silence.stream.getAudioTracks())
    pc.addTrack(track, silence.stream);
  const channel = pc.createDataChannel("oai-events");

  const close = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearInterval(levelTimer);
    oscillator.stop();
    for (const track of silence.stream.getAudioTracks()) track.stop();
    channel.close();
    pc.close();
    audio.pause();
    audio.srcObject = null;
    void context.close().catch(() => undefined);
  };
  const fail = () => {
    if (abort.signal.aborted || failed) return;
    failed = true;
    report("failed");
  };

  const watchLevel = (stream: MediaStream) => {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let audible = false;
    let quietSince: number | undefined;
    clearInterval(levelTimer);
    levelTimer = setInterval(() => {
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
    watchLevel(stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") fail();
  };

  void (async () => {
    try {
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

  return { close };
}
