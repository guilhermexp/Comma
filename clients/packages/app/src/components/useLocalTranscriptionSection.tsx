import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import type { LocalTranscriptionState } from "@comma/native-bridge";
import { Dialog, type SettingsPanelItem, type SettingsPanelSection } from "@comma/ui";
import { useState, type ReactNode } from "react";
import { useLocalTranscription } from "./useLocalTranscription";

/** Decimal megabytes, as the docs and release notes give the download size. */
function formatMegabytes(bytes: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);
}

/**
 * Settings → Work → Meeting → Local transcription: one row for the speech
 * model, whose status dot, text and single action follow Main's state. The
 * status stays text ("Downloading 42%") rather than a spinner, so progress
 * is readable at a glance. Remove asks first, in `removalDialog`, which the
 * caller renders beside its other Settings dialogs.
 *
 * With a cloud provider selected the model stays the fallback, so its ready
 * row names the provider it stands in for (`fallbackProvider`).
 */
export function useLocalTranscriptionSection({
  fallbackProvider,
}: { fallbackProvider?: string | undefined } = {}): {
  section: SettingsPanelSection;
  removalDialog: ReactNode;
} {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const { state, pending, refusal, install, cancel, remove } = useLocalTranscription();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const size = state?.sizeBytes ? formatMegabytes(state.sizeBytes, locale) : "";
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
          description: fallbackProvider
            ? m.settings_meeting_transcription_local_fallback({
                provider: fallbackProvider,
                size,
              })
            : m.settings_local_transcription_ready_description({ size }),
          status: {
            label: m.settings_local_transcription_status_ready(),
            color: "success",
          },
          control: {
            type: "button",
            label: m.settings_local_transcription_remove(),
            tone: "danger",
            disabled: busy,
            onPress: () => setConfirmingRemoval(true),
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
    section: {
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
    },
    removalDialog:
      confirmingRemoval && state?.phase === "ready" ? (
        <Dialog
          isOpen
          isDismissable
          onOpenChange={setConfirmingRemoval}
          title={m.settings_local_transcription_remove_confirm_title()}
          description={m.settings_local_transcription_remove_confirm_description({
            size,
          })}
          actions={[
            {
              label: m.settings_local_transcription_cancel(),
              hierarchy: "secondary-gray",
              onPress: () => setConfirmingRemoval(false),
            },
            {
              label: m.settings_local_transcription_remove(),
              hierarchy: "destructive",
              onPress: () => {
                setConfirmingRemoval(false);
                void remove();
              },
            },
          ]}
        />
      ) : null,
  };
}
