import {
  readCollapsedHomeRails,
  toggleCollapsedHomeRail,
} from "./home/homeRailCollapse";
import { useCommaMessages } from "@comma/i18n/react";
import {
  getNativeBridge,
  type AudioCaptureDriveFile,
  type AudioCaptureRecording,
} from "@comma/native-bridge";
import { toast } from "@comma/ui";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useContext, useRef, useState } from "react";
import type { SessionProductLease } from "@comma/session-contract";
import { CommaAuthContext } from "./auth-context";
import type { DriveFile } from "./drive/driveStore";

let revealSequence = 0;

/** Main's exact reason when the local speech model is missing (contract C3). */
const localModelMissing = "local_asr_model_not_installed";

/** Toasts that ask for the install; they are stale once the model is ready. */
const installNoticeIds = new Set<string>();

/** Dismisses every install notice, for example when the model becomes ready. */
export function dismissLocalTranscriptionInstallNotices() {
  for (const id of installNoticeIds) toast.dismiss(id);
  installNoticeIds.clear();
}

/** Settings → Work → Meeting, where the Local transcription section lives. */
export function openLocalTranscriptionSettings() {
  window.location.hash = "/settings?category=meeting";
}

/**
 * Recordings that can be sent through transcription again: the AAC files
 * under `recording/<day>/` without a `.transcript.txt` beside them. An ASR
 * error writes only the `.transcript.json`, so a failed one qualifies too.
 */
export function transcribableRecordingIds(files: readonly DriveFile[]) {
  const transcripts = new Set(
    files
      .filter((file) => file.name.endsWith(".transcript.txt"))
      .map((file) => `${file.spaceId}:${file.folderPath ?? ""}/${file.name}`)
  );
  return new Set(
    files
      .filter(
        (file) =>
          /^recording\/\d{4}-\d{2}-\d{2}$/.test(file.folderPath ?? "") &&
          file.name.endsWith(".m4a") &&
          !transcripts.has(
            `${file.spaceId}:${file.folderPath}/${file.name.replace(/\.m4a$/, ".transcript.txt")}`
          )
      )
      .map((file) => file.id)
  );
}

/** The card and both recording completion paths act on Main's saved target. */
export function useRecordingFileActions() {
  const messages = useCommaMessages();
  // Composers also render in isolated previews without a route or session.
  const router = useRouter({ warn: false });
  const productLease = useContext(CommaAuthContext)?.productLease;
  const [pending, setPending] = useState<"reveal" | "open">();
  const [error, setError] = useState<string>();
  const busy = useRef(false);

  const reveal = useCallback(
    async (recording: AudioCaptureRecording) => {
      if (busy.current) return;
      busy.current = true;
      setPending("reveal");
      setError(undefined);
      try {
        if (!router) throw new Error("Drive navigation is unavailable.");
        await router.navigate({
          to: "/drive",
          search: {
            path: recording.driveFile.path,
            reveal: `recording-${++revealSequence}`,
            space: recording.driveFile.space,
          },
        });
      } catch {
        const message = messages.recording_reveal_failed();
        setError(message);
        toast.error(message, { id: "recording-reveal-failed" });
      } finally {
        busy.current = false;
        setPending(undefined);
      }
    },
    [messages, router]
  );

  const open = useCallback(
    async (recording: AudioCaptureRecording) => {
      if (busy.current) return;
      busy.current = true;
      setPending("open");
      setError(undefined);
      let detail: string | undefined;
      try {
        if (!productLease) throw new Error("Recording session is unavailable.");
        const result = await getNativeBridge().audioCapture.openSaved({
          driveFile: recording.driveFile,
          session: productLease,
        });
        if (result.status !== "opened") {
          detail = result.reason;
          throw new Error("Recording could not be opened.");
        }
      } catch {
        const message = [messages.recording_open_failed(), detail]
          .filter(Boolean)
          .join(" ");
        setError(message);
        toast.error(message, { id: "recording-open-failed" });
      } finally {
        busy.current = false;
        setPending(undefined);
      }
    },
    [messages, productLease]
  );

  const showSaved = useCallback(
    (
      recording: AudioCaptureRecording,
      id: string,
      testId: string,
      meeting?: {
        summary?: "pending" | "queued" | "error" | undefined;
        summaryError?: string | undefined;
        smartSummary?: boolean | undefined;
        archive?: "done" | "error" | undefined;
        task?: { groupId: string; taskId: string } | undefined;
      }
    ) => {
      setError(undefined);
      const show =
        meeting?.summary === "error" || meeting?.archive === "error"
          ? toast.error
          : toast.success;
      const title =
        meeting?.archive === "error"
          ? messages.meeting_archive_failed()
          : meeting?.archive === "done"
            ? messages.meeting_archive_done()
            : meeting?.summary === "pending" && meeting.smartSummary !== false
              ? messages.recording_summary_preparing()
              : meeting?.summary === "error"
                ? messages.recording_summary_failed()
                : messages.chat_voice_capture_saved({ name: recording.file.name });
      const message =
        meeting?.summary === "error" && meeting.summaryError
          ? `${title} ${meeting.summaryError}`
          : title;
      show(message, {
        actions: meeting
          ? [
              ...(meeting.summary !== undefined
                ? [
                    {
                      hierarchy: "secondary-gray" as const,
                      label:
                        meeting.smartSummary === false
                          ? messages.recording_view_meeting()
                          : messages.recording_check_summary(),
                      onPress: () => {
                        if (readCollapsedHomeRails().tasks)
                          toggleCollapsedHomeRail("tasks");
                        void router?.navigate({
                          to: "/",
                          search: meeting.task
                            ? {
                                meetingTask: meeting.task.taskId,
                                meetingGroup: meeting.task.groupId,
                              }
                            : {},
                        });
                      },
                    },
                  ]
                : []),
              ...(meeting.summary === "error" || meeting.archive === "error"
                ? [
                    {
                      hierarchy: "tertiary-gray" as const,
                      label: messages.common_retry(),
                      onPress: () => {
                        void getNativeBridge()
                          .meetingRecorder.retryTaskSync()
                          .catch(() =>
                            toast.error(messages.recording_summary_failed())
                          );
                      },
                    },
                  ]
                : []),
              {
                hierarchy:
                  meeting.summary !== undefined ? "tertiary-gray" : "secondary-gray",
                label: messages.ui_meeting_recorder_show_in_drive(),
                onPress: () => void reveal(recording),
              },
            ]
          : [
              {
                hierarchy: "secondary-gray",
                label: messages.ui_meeting_recorder_show_in_drive(),
                onPress: () => void reveal(recording),
              },
              {
                hierarchy: "tertiary-gray",
                label: messages.ui_meeting_recorder_open_file(),
                onPress: () => void open(recording),
              },
            ],
        id,
        testId,
      });
    },
    [messages, open, reveal, router]
  );

  /** A recording was saved but the local model is missing: offer the install. */
  const showLocalTranscriptionNotice = useCallback(
    (recording: AudioCaptureRecording) => {
      installNoticeIds.add("local-transcription-notice");
      toast.info(messages.recording_local_transcription_missing(), {
        actions: [
          {
            hierarchy: "secondary-gray",
            label: messages.recording_local_transcription_install(),
            onPress: openLocalTranscriptionSettings,
          },
          {
            hierarchy: "tertiary-gray",
            label: messages.ui_meeting_recorder_show_in_drive(),
            onPress: () => void reveal(recording),
          },
        ],
        id: "local-transcription-notice",
        testId: "local-transcription-notice",
      });
    },
    [messages, reveal]
  );

  return {
    error,
    open,
    pending,
    reveal,
    showLocalTranscriptionNotice,
    showSaved,
  };
}

/**
 * Sends a saved recording through transcription again (Drive's row menu);
 * the transcript lands beside it. Needs no router, so any surface can use it.
 */
export function useRecordingTranscription(
  productLease: SessionProductLease | null | undefined
) {
  const messages = useCommaMessages();
  return useCallback(
    async (driveFile: AudioCaptureDriveFile) => {
      const name = driveFile.path.split("/").at(-1) ?? driveFile.path;
      const id = `recording-transcribe-${driveFile.path}`;
      toast.info(messages.recording_transcribe_started({ name }), { id, testId: id });
      let reason: string;
      try {
        if (!productLease) throw new Error("Recording session is unavailable.");
        const result = await getNativeBridge().audioCapture.transcribeSaved({
          driveFile,
          session: productLease,
        });
        if (result.status === "ready") {
          toast.success(messages.recording_transcribe_done({ name }), {
            id,
            testId: id,
          });
          return;
        }
        reason = result.reason;
      } catch (failure) {
        reason = failure instanceof Error ? failure.message : String(failure);
      }
      const missingModel = reason === localModelMissing;
      if (missingModel) installNoticeIds.add(id);
      toast.error(
        messages.recording_transcribe_failed({
          name,
          reason: missingModel
            ? messages.recording_local_transcription_install_hint()
            : reason,
        }),
        {
          id,
          testId: id,
          ...(missingModel
            ? {
                actions: [
                  {
                    hierarchy: "secondary-gray" as const,
                    label: messages.recording_local_transcription_install(),
                    onPress: openLocalTranscriptionSettings,
                  },
                ],
              }
            : {}),
        }
      );
    },
    [messages, productLease]
  );
}
