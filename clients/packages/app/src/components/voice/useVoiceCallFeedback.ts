import { useEffect, useRef, useState } from "react";

export type CallPhase = "idle" | "connecting" | "live" | "ending" | "ended" | "failed";
export const callClock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/** Presentation only: two audio taps, thirteen samples, one clock per active call. */
export function useVoiceCallFeedback(
  phase: CallPhase,
  muted: boolean,
  getStreams: () => { mic?: MediaStream | undefined; agent?: MediaStream | undefined }
) {
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(13).fill(0));
  const previous = useRef<CallPhase>("idle");

  useEffect(() => {
    if (phase === "connecting") {
      setSeconds(0);
      setLevels(Array(13).fill(0));
    }
    if (phase !== "live") return;
    const start = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      1000
    );
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "live" || typeof AudioContext === "undefined") return;
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    const taps = new Map<
      "mic" | "agent",
      {
        stream: MediaStream;
        source: MediaStreamAudioSourceNode;
        analyser: AnalyserNode;
      }
    >();
    const buffer = new Uint8Array(512);
    function loudness(
      who: "mic" | "agent",
      stream: MediaStream | undefined,
      gain: number
    ) {
      if (!stream) return 0;
      let tap = taps.get(who);
      if (!tap || tap.stream !== stream) {
        tap?.source.disconnect();
        tap?.analyser.disconnect();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = buffer.length;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        tap = { stream, source, analyser };
        taps.set(who, tap);
      }
      tap.analyser.getByteTimeDomainData(buffer);
      const sum = buffer.reduce(
        (value, sample) => value + ((sample - 128) / 128) ** 2,
        0
      );
      return Math.min(1, Math.sqrt(sum / buffer.length) * gain);
    }
    const timer = setInterval(() => {
      const { mic, agent } = getStreams();
      const level = Math.max(
        loudness("agent", agent, 7),
        muted ? 0 : loudness("mic", mic, 3.5)
      );
      setLevels((values) => [...values.slice(1), level]);
    }, 90);
    return () => {
      clearInterval(timer);
      taps.forEach(({ source, analyser }) => {
        source.disconnect();
        analyser.disconnect();
      });
      void ctx.close().catch(() => {});
    };
  }, [getStreams, muted, phase]);

  useEffect(() => {
    const ended =
      ["ended", "failed"].includes(phase) &&
      ["connecting", "live", "ending"].includes(previous.current);
    previous.current = phase;
    if ((phase !== "connecting" && !ended) || typeof AudioContext === "undefined")
      return;
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    const out = ctx.createGain();
    out.gain.value = phase === "connecting" ? 0.05 : 0.08;
    out.connect(ctx.destination);
    function tone(frequency: number, at: number, duration: number) {
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(1, at + 0.02);
      envelope.gain.setValueAtTime(1, at + duration - 0.08);
      envelope.gain.linearRampToValueAtTime(0, at + duration);
      envelope.connect(out);
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(envelope);
      oscillator.start(at);
      oscillator.stop(at + duration);
    }
    const ring = () =>
      [440, 480].forEach((frequency) => tone(frequency, ctx.currentTime + 0.02, 0.88));
    let timer: ReturnType<typeof setInterval> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    if (phase === "connecting") {
      ring();
      timer = setInterval(ring, 1700);
    } else {
      tone(620, ctx.currentTime + 0.02, 0.16);
      tone(460, ctx.currentTime + 0.19, 0.16);
      closeTimer = setTimeout(() => void ctx.close().catch(() => {}), 600);
    }
    return () => {
      clearInterval(timer);
      clearTimeout(closeTimer);
      if (ctx.state !== "closed") void ctx.close().catch(() => {});
    };
  }, [phase]);

  return { seconds, levels };
}
