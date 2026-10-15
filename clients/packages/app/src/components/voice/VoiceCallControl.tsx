import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CallIcon } from "@comma/ui";
import { VoiceCallBar, VoiceCallButton } from "./VoiceCallBar";
import { useVoiceCallFeedback, type CallPhase } from "./useVoiceCallFeedback";
import type { CallTranscript } from "./VoiceCallTranscript";
import { useCommaMessages } from "@comma/i18n/react";
import { CommaApiError, type CommaApiClient } from "../../api";
import type { VoiceCallEvent } from "../../api/voiceCalls";

type Caption = Extract<VoiceCallEvent, { kind: "caption" }>;
type Attempt = {
  cancelled: boolean;
  callId?: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  stream?: MediaStream;
  audio: HTMLAudioElement;
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  closeRequested: boolean;
  sidebandReady: boolean;
  connectTimer?: ReturnType<typeof setTimeout>;
};

function release(mine: Attempt) {
  if (mine.cancelled) return;
  mine.cancelled = true;
  clearTimeout(mine.timer);
  clearTimeout(mine.connectTimer);
  mine.abort.abort();
  mine.stream?.getTracks().forEach((track) => track.stop());
  mine.channel.close();
  mine.pc.close();
  mine.audio.pause();
  mine.audio.srcObject = null;
}

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
    const timer = setTimeout(done, 5_000);
    pc.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", done, { once: true });
    changed();
  });
}

/** One workspace call. Media stays in this renderer; only SDP and captions use Salix. */
export function VoiceCallControl({
  api,
  workspaceId,
  surfaceActive = true,
  onOpen,
  onTranscript,
  onBarVisibilityChange,
}: {
  api: CommaApiClient;
  workspaceId: string;
  surfaceActive?: boolean;
  onOpen?: (() => void) | undefined;
  onTranscript?: ((transcript: CallTranscript) => void) | undefined;
  onBarVisibilityChange?: ((visible: boolean) => void) | undefined;
}) {
  const m = useCommaMessages();
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string>();
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [truncated, setTruncated] = useState(false);
  const attempt = useRef<Attempt | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [showCaptions, setShowCaptions] = useState(false);
  const [pendingDelegations, setPendingDelegations] = useState<Set<string>>(new Set());
  const recorded = useRef(false);
  const getStreams = useCallback(
    () => ({
      mic: attempt.current?.stream,
      agent: (attempt.current?.audio.srcObject as MediaStream | null) ?? undefined,
    }),
    []
  );
  const { seconds, levels } = useVoiceCallFeedback(phase, muted, getStreams);

  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element || !surfaceActive) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setPosition({ left: box.left + box.width / 2, top: box.top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [surfaceActive]);

  useEffect(() => {
    if (phase === "connecting") {
      recorded.current = false;
      setPendingDelegations(new Set());
    }
    if (phase !== "ended" && phase !== "failed") return;
    setPendingDelegations(new Set());
    if (!recorded.current && captions.length && attempt.current?.callId) {
      recorded.current = true;
      onTranscript?.({ callId: attempt.current.callId, seconds, captions, truncated });
    }
  }, [captions, onTranscript, phase, seconds, truncated]);

  useEffect(() => {
    if (phase !== "ended" && phase !== "failed") return;
    const timer = setTimeout(() => setPhase("idle"), phase === "failed" ? 6000 : 1600);
    return () => clearTimeout(timer);
  }, [phase]);

  const barVisible = phase !== "idle";
  useLayoutEffect(() => {
    onBarVisibilityChange?.(barVisible);
    return () => onBarVisibilityChange?.(false);
  }, [barVisible, onBarVisibilityChange]);

  const requestClose = useCallback(
    (mine: Attempt) => {
      if (!mine.callId || mine.closeRequested) return Promise.resolve();
      mine.closeRequested = true;
      return api.endVoiceCall(workspaceId, mine.callId).catch(() => {
        // The carrier also ends an abandoned peer after its bounded idle wait.
      });
    },
    [api, workspaceId]
  );

  useEffect(() => {
    setPhase("idle");
    setCaptions([]);
    setError(undefined);
    return () => {
      const mine = attempt.current;
      if (mine) {
        release(mine);
        void requestClose(mine);
        attempt.current = undefined;
      }
    };
  }, [requestClose]);

  function failure(code: string) {
    if (code === "plan_limit") return m.voice_call_plan_limit();
    if (code === "codex_account_required") return m.voice_call_account_required();
    if (code === "disabled") return m.voice_call_disabled();
    if (code === "busy") return m.voice_call_busy();
    if (code === "sign_in_required") return m.voice_call_sign_in();
    if (code === "microphone") return m.voice_call_microphone();
    if (code === "playback") return m.voice_call_playback();
    return m.voice_call_failed();
  }

  async function start() {
    if (attempt.current && !attempt.current.cancelled) return;
    setPhase("connecting");
    setMuted(false);
    setError(undefined);
    setCaptions([]);
    setTruncated(false);
    let mine: Attempt | undefined;
    try {
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      const channel = pc.createDataChannel("oai-events");
      mine = {
        pc,
        audio,
        channel,
        cancelled: false,
        abort: new AbortController(),
        closeRequested: false,
        sidebandReady: false,
      };
      const current = mine;
      attempt.current = mine;
      function fail(code: string) {
        if (current.cancelled) return;
        setError(failure(code));
        setPhase("failed");
        release(current);
        void requestClose(current);
      }
      pc.ontrack = (event) => {
        if (current.cancelled) return;
        audio.srcObject = new MediaStream([event.track]);
        void audio.play().catch(() => fail("playback"));
      };
      function ready() {
        if (
          !current.cancelled &&
          current.sidebandReady &&
          pc.connectionState === "connected"
        ) {
          clearTimeout(current.connectTimer);
          setPhase("live");
        }
      }
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") fail("connection");
        else ready();
      });
      channel.addEventListener("close", () => {
        if (!current.cancelled) {
          setPhase("ended");
          release(current);
          void requestClose(current);
        }
      });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (current.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      await pc.setLocalDescription(await pc.createOffer());
      await gatherIce(pc, current.abort.signal);
      if (current.cancelled) return;
      const answer = await api.startVoiceCall(workspaceId, pc.localDescription!.sdp);
      current.callId = answer.call_id;
      if (current.cancelled) {
        void requestClose(current);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      current.connectTimer = setTimeout(() => fail("connection"), 30_000);
      ready();
      let cursor = 0;
      const poll = async () => {
        if (current.cancelled) return;
        try {
          const result = await api.voiceCallEvents(
            workspaceId,
            answer.call_id,
            cursor,
            { signal: current.abort.signal }
          );
          if (current.cancelled) return;
          cursor = result.cursor;
          if (result.truncated) setTruncated(true);
          for (const event of result.events) {
            if ("type" in event) {
              setPendingDelegations((previous) => {
                const next = new Set(previous);
                if (event.status === "pending") next.add(event.id);
                else next.delete(event.id);
                return next;
              });
              continue;
            }
            if (event.kind === "started") {
              current.sidebandReady = true;
              ready();
            }
            if (event.kind === "caption")
              setCaptions((previous) => {
                const index = previous.findIndex(
                  (item) => item.role === event.role && item.turn === event.turn
                );
                const next = [...previous];
                if (index < 0) next.push(event);
                else next[index] = event;
                if (next.length > 200) setTruncated(true);
                return next.slice(-200);
              });
            if (event.kind === "error") fail(event.code);
            if (event.kind === "closed" && !current.cancelled) {
              setPhase("ended");
              release(current);
            }
          }
          if (!current.cancelled) current.timer = setTimeout(() => void poll(), 500);
        } catch {
          fail("connection");
        }
      };
      void poll();
    } catch (cause) {
      if (mine?.cancelled) return;
      const code =
        cause instanceof DOMException &&
        ["NotAllowedError", "NotFoundError", "NotReadableError"].includes(cause.name)
          ? "microphone"
          : cause instanceof CommaApiError
            ? String(cause.body?.error ?? "connection")
            : "connection";
      setError(failure(code));
      setPhase("failed");
      if (mine) {
        release(mine);
        void requestClose(mine);
      }
    }
  }

  function toggleMute() {
    const next = !muted;
    attempt.current?.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }

  function hangUp() {
    const mine = attempt.current;
    setPhase("ending");
    if (mine) {
      release(mine);
      void requestClose(mine).finally(() => {
        if (attempt.current === mine) setPhase("ended");
      });
    } else setPhase("ended");
  }

  return (
    <div ref={anchor} className="flex w-full items-center justify-end">
      {phase === "idle" && surfaceActive && (
        <VoiceCallButton
          label={m.voice_call_start({ agent: "Comma" })}
          icon={<CallIcon />}
          entry
          onPress={() => void start()}
        />
      )}
      {phase !== "idle" &&
        createPortal(
          <div
            className="fixed z-40 max-w-[calc(100vw-24px)]"
            style={
              surfaceActive
                ? { ...position, transform: "translateX(-50%)" }
                : { right: 24, bottom: 24 }
            }
          >
            <VoiceCallBar
              phase={phase}
              name="Comma"
              muted={muted}
              showCaptions={showCaptions}
              working={pendingDelegations.size > 0}
              compact={!surfaceActive}
              seconds={seconds}
              levels={levels}
              caption={captions.at(-1)}
              error={error}
              onMute={toggleMute}
              onCaptions={() => setShowCaptions(!showCaptions)}
              onHangUp={hangUp}
              onOpen={onOpen}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
