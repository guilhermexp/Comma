import {
  getNativeBridge,
  type LocalTranscriptionActionResult,
  type LocalTranscriptionState,
} from "@comma/native-bridge";
import { useCallback, useEffect, useState } from "react";

type Action = "install" | "cancel" | "remove";

/** Main's speech-model state (openspec add-local-meeting-asr) and its three actions. */
export function useLocalTranscription() {
  const bridge = getNativeBridge();
  const [state, setState] = useState<LocalTranscriptionState>();
  const [pending, setPending] = useState<Action>();
  const [refusal, setRefusal] = useState<LocalTranscriptionActionResult["reason"]>();

  useEffect(() => bridge.localTranscription.state.subscribe(setState), [bridge]);

  const run = useCallback(
    async (action: Action) => {
      setPending(action);
      setRefusal(undefined);
      try {
        const result = await bridge.localTranscription[action]();
        if (!result.accepted) setRefusal(result.reason);
      } finally {
        setPending(undefined);
      }
    },
    [bridge]
  );

  return {
    state,
    pending,
    /** Why the last action was refused, such as `busy` for Remove during a transcription. */
    refusal,
    install: () => run("install"),
    cancel: () => run("cancel"),
    remove: () => run("remove"),
  };
}
