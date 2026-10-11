import {
  getNativeBridge,
  unavailableMeetingRecorderState,
  type MeetingRecorderState,
} from "@comma/native-bridge";
import { useCommaMessages } from "@comma/i18n/react";
import { useCallback, useEffect, useState } from "react";

/** Replay-last projection only. Main owns capture across both windows and remounts. */
export function useMeetingRecorder() {
  const bridge = getNativeBridge();
  const messages = useCommaMessages();
  const [state, setState] = useState<MeetingRecorderState>(
    unavailableMeetingRecorderState
  );
  const [error, setError] = useState<string>();
  const accept = useCallback((next: MeetingRecorderState) => {
    setState((current) => (current.revision > next.revision ? current : next));
  }, []);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.meetingRecorder.state.subscribe(accept);
  }, [accept, bridge]);
  const action = useCallback(
    (intent: "start" | "dismiss" | "pause" | "resume" | "stop" | "discard") => {
      if (!state.meeting) return;
      setError(undefined);
      void bridge.meetingRecorder
        .action({
          action: intent,
          meetingKey: state.meeting.key,
          generation: state.generation,
        })
        .then(accept)
        .catch(() => {
          setError(messages.meeting_recorder_action_failed());
        });
    },
    [accept, bridge, messages, state.meeting, state.generation]
  );
  return { state, action, error };
}
