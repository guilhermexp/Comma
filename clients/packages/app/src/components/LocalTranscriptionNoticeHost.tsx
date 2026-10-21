import { getNativeBridge, type MeetingTranscriptionState } from "@comma/native-bridge";
import { useContext, useEffect, useRef } from "react";
import { CommaAuthContext } from "./auth-context";
import {
  dismissLocalTranscriptionInstallNotices,
  dismissTranscriptionConfigureNotices,
  useRecordingFileActions,
  useRecordingTranscription,
} from "./useRecordingFileActions";

/**
 * Shows what a saved recording needs (openspec add-cloud-meeting-asr, D8):
 * "Install local transcription" only with the Local provider, "Set up
 * transcription" for a cloud provider that is not ready, a note when a cloud
 * failure fell back to this Mac, and the provider's failure with Try again
 * when no local model could take over. Stale notices close once the model or
 * provider is ready. Renders nothing itself.
 */
export function LocalTranscriptionNoticeHost() {
  const bridge = getNativeBridge();
  const {
    showCloudFailedNotice,
    showConfigureTranscriptionNotice,
    showFallbackNotice,
    showLocalTranscriptionNotice,
  } = useRecordingFileActions();
  const transcribe = useRecordingTranscription(
    useContext(CommaAuthContext)?.productLease
  );
  const meeting = useRef<MeetingTranscriptionState>(undefined);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.meetingTranscription.onNotice((notice) => {
      if (notice.kind === "install_local")
        showLocalTranscriptionNotice(notice.recording);
      else if (notice.kind === "configure")
        showConfigureTranscriptionNotice(notice.recording);
      else if (notice.kind === "cloud_failed")
        showCloudFailedNotice(notice.recording, notice, meeting.current, transcribe);
      else showFallbackNotice(notice.recording, notice.reason, meeting.current);
    });
  }, [
    bridge,
    showCloudFailedNotice,
    transcribe,
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
