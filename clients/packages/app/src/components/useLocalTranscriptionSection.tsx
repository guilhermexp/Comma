import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import type { LocalTranscriptionState } from "@comma/native-bridge";
import type { SettingsPanelItem, SettingsPanelSection } from "@comma/ui";
import { formatAttachmentSize } from "./chat/thread/attachments/attachmentLabels";
import { useLocalTranscription } from "./useLocalTranscription";

/**
 * Settings → Work → Meeting → Local transcription: one row for the speech
 * model, whose status dot, text and single action follow Main's state. The
 * status stays text ("Downloading 42%") rather than a spinner, so progress
 * is readable at a glance.
 */
export function useLocalTranscriptionSection(): SettingsPanelSection {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const { state, pending, refusal, install, cancel, remove } = useLocalTranscription();
  const size = formatAttachmentSize(state?.sizeBytes || undefined, locale) ?? "";
  const busy = pending !== undefined;

  const row = (
    current: LocalTranscriptionState
  ): Pick<SettingsPanelItem, "description" | "status" | "control" | "errorMessage"> => {
    if (!current.supported) {
      return {
        description:
          current.reason === "remote_backend"
            ? m.settings_local_transcription_unsupported_remote()
            : current.reason === "helper_missing"
              ? m.settings_local_transcription_unsupported_helper()
              : m.settings_local_transcription_unsupported_hardware(),
        status: {
          label: m.settings_local_transcription_status_unavailable(),
          color: "gray",
        },
      };
    }
    switch (current.phase) {
      case "downloading":
        return {
          description: m.settings_local_transcription_downloading_description(),
          status: {
            label: m.settings_local_transcription_status_downloading({
              percent: String(Math.floor((current.fraction ?? 0) * 100)),
            }),
            color: "blue",
          },
          control: {
            type: "button",
            label: m.settings_local_transcription_cancel(),
            disabled: busy,
            onPress: () => void cancel(),
          },
        };
      case "preparing":
        return {
          description: m.settings_local_transcription_preparing_description(),
          status: {
            label: m.settings_local_transcription_status_preparing(),
            color: "blue",
          },
        };
      case "ready":
        return {
          description: m.settings_local_transcription_ready_description({ size }),
          status: {
            label: m.settings_local_transcription_status_ready(),
            color: "success",
          },
          control: {
            type: "button",
            label: m.settings_local_transcription_remove(),
            tone: "danger",
            disabled: busy,
            onPress: () => void remove(),
          },
          ...(refusal === "busy"
            ? { errorMessage: m.settings_local_transcription_remove_busy() }
            : {}),
        };
      case "failed":
        return {
          description: m.settings_local_transcription_failed_description(),
          status: {
            label: m.settings_local_transcription_status_failed(),
            color: "error",
          },
          errorMessage:
            current.error?.code === "checksum_mismatch"
              ? m.settings_local_transcription_error_checksum()
              : current.error?.code === "network"
                ? m.settings_local_transcription_error_network()
                : m.settings_local_transcription_error_other({
                    message: current.error?.message ?? "",
                  }),
          control: {
            type: "button",
            label: m.settings_local_transcription_retry(),
            disabled: busy,
            onPress: () => void install(),
          },
        };
      default:
        return {
          description: m.settings_local_transcription_not_installed_description({
            size,
          }),
          status: {
            label: m.settings_local_transcription_status_not_installed(),
            color: "gray",
          },
          control: {
            type: "button",
            label: m.settings_local_transcription_install(),
            disabled: busy,
            onPress: () => void install(),
          },
        };
    }
  };

  return {
    id: "meeting.local-transcription",
    title: m.settings_local_transcription(),
    items: [
      {
        id: "meeting.local-transcription.model",
        title: m.settings_local_transcription_model(),
        keywords: ["transcription", "speech", "parakeet", "speaker", "asr"],
        ...(state ? row(state) : { descriptionLoading: true }),
      },
    ],
  };
}
