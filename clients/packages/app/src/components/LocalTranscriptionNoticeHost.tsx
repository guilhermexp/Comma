import { getNativeBridge, type MeetingTranscriptionState } from "@comma/native-bridge";
import { useEffect, useRef } from "react";
import {
  dismissLocalTranscriptionInstallNotices,
  dismissTranscriptionConfigureNotices,
  useRecordingFileActions,
} from "./useRecordingFileActions";

/**
 * Shows what a saved recording needs (openspec add-cloud-meeting-asr, D8):
 * "Install local transcription" only with the Local provider, "Set up
 * transcription" for a cloud provider that is not ready, and a note when a
 * cloud failure fell back to this Mac. Stale notices close once the model or
 * provider is ready. Renders nothing itself.
 */
export function LocalTranscriptionNoticeHost() {
  const bridge = getNativeBridge();
  const {
    showConfigureTranscriptionNotice,
    showFallbackNotice,
    showLocalTranscriptionNotice,
  } = useRecordingFileActions();
  const meeting = useRef<MeetingTranscriptionState>(undefined);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.meetingTranscription.onNotice((notice) => {
      if (notice.kind === "install_local")
        showLocalTranscriptionNotice(notice.recording);
      else if (notice.kind === "configure")
        showConfigureTranscriptionNotice(notice.recording);
      else showFallbackNotice(notice.recording, notice.reason, meeting.current);
    });
  }, [
    bridge,
    showConfigureTranscriptionNotice,
    showFallbackNotice,
    showLocalTranscriptionNotice,
  ]);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.localTranscription.state.subscribe((state) => {
      if (state.phase === "ready") dismissLocalTranscriptionInstallNotices();
    });
  }, [bridge]);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.meetingTranscription.state.subscribe((state) => {
      meeting.current = state;
      if (state.provider !== "local") dismissLocalTranscriptionInstallNotices();
      if (state.ready) dismissTranscriptionConfigureNotices();
    });
  }, [bridge]);
  return null;
}
