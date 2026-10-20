import { getNativeBridge } from "@comma/native-bridge";
import { useEffect } from "react";
import { useRecordingFileActions } from "./useRecordingFileActions";

/**
 * Shows "Install local transcription" when Main saved a recording that the
 * missing local model cannot transcribe. Renders nothing itself.
 */
export function LocalTranscriptionNoticeHost() {
  const bridge = getNativeBridge();
  const { showLocalTranscriptionNotice } = useRecordingFileActions();
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.localTranscription.onNotice((notice) =>
      showLocalTranscriptionNotice(notice.recording)
    );
  }, [bridge, showLocalTranscriptionNotice]);
  return null;
}
