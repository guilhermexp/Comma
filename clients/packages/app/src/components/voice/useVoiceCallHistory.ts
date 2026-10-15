import { useCallback, useMemo, useState } from "react";
import type { CallTranscript } from "./VoiceCallTranscript";

type LocalCallRecord = {
  scope: string;
  messageId: string | undefined;
  transcript: CallTranscript;
};

/** Session-only transcript projections, sharing the existing 200-caption retention budget. */
export function useVoiceCallHistory(scope: string, messageId?: string) {
  const [records, setRecords] = useState<LocalCallRecord[]>([]);
  const record = useCallback(
    (transcript: CallTranscript) => {
      setRecords((previous) => {
        const next = [
          ...previous.filter((item) => item.transcript.callId !== transcript.callId),
          { scope, messageId, transcript },
        ];
        let budget = 200;
        const retained: LocalCallRecord[] = [];
        for (let index = next.length - 1; index >= 0 && budget > 0; index--) {
          const item = next[index]!;
          const captions = item.transcript.captions.slice(-budget);
          budget -= captions.length;
          if (!captions.length) continue;
          retained.unshift({
            ...item,
            transcript: {
              ...item.transcript,
              captions,
              truncated:
                item.transcript.truncated ||
                captions.length < item.transcript.captions.length,
            },
          });
        }
        return retained;
      });
    },
    [messageId, scope]
  );
  const visibleRecords = useMemo(
    () => records.filter((item) => item.scope === scope),
    [records, scope]
  );
  return { records: visibleRecords, record };
}
