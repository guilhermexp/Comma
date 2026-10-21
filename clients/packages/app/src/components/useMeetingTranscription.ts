import type { useCommaMessages } from "@comma/i18n/react";
import {
  getNativeBridge,
  type MeetingTranscriptionProvider,
  type MeetingTranscriptionActionResult,
  type MeetingTranscriptionSetProviderInput,
  type MeetingTranscriptionState,
} from "@comma/native-bridge";
import { useCallback, useEffect, useState } from "react";

type Action = "setProvider" | "clearKey" | "retryVerify";

/** The provider's name in the privacy notice: Groq, or the API's host. */
export function meetingProviderName(
  m: ReturnType<typeof useCommaMessages>,
  provider: MeetingTranscriptionProvider,
  host: string | undefined
): string {
  if (provider === "groq") return m.settings_meeting_transcription_engine_groq();
  return host ?? m.settings_meeting_transcription_engine_compatible();
}

/** A cloud failure reason (`cloud_quota`, …) in the user's words. */
export function cloudReasonLabel(
  m: ReturnType<typeof useCommaMessages>,
  reason: string
): string {
  switch (reason) {
    case "cloud_unreachable":
      return m.recording_cloud_reason_unreachable();
    case "cloud_quota":
      return m.recording_cloud_reason_quota();
    case "cloud_auth_rejected":
      return m.recording_cloud_reason_auth();
    case "cloud_server_error":
      return m.recording_cloud_reason_server();
    case "cloud_timeout":
      return m.recording_cloud_reason_timeout();
    case "cloud_bad_response":
      return m.recording_cloud_reason_bad_response();
    default:
      return m.recording_cloud_reason_other();
  }
}

/** A cloud provider's name for a notice: Groq, or the saved API's host. */
export function cloudProviderName(
  m: ReturnType<typeof useCommaMessages>,
  provider: "groq" | "openai_compatible",
  state: MeetingTranscriptionState | undefined
): string {
  return meetingProviderName(
    m,
    provider,
    state?.cloud?.kind === provider ? state.cloud.baseHost : undefined
  );
}

/** The selected provider's name from Main's state, for a notice. */
export function stateProviderName(
  m: ReturnType<typeof useCommaMessages>,
  state: MeetingTranscriptionState | undefined
): string {
  return meetingProviderName(
    m,
    state?.provider === "openai_compatible" ? "openai_compatible" : "groq",
    state?.cloud?.baseHost
  );
}

/**
 * Main's meeting transcription engine (openspec add-cloud-meeting-asr, C8)
 * and its three commands. The state never carries a key, only whether one
 * is saved.
 */
export function useMeetingTranscription() {
  const bridge = getNativeBridge();
  const [state, setState] = useState<MeetingTranscriptionState>();
  const [pending, setPending] = useState<Action>();
  const [refusal, setRefusal] = useState<MeetingTranscriptionActionResult["reason"]>();

  useEffect(() => bridge.meetingTranscription.state.subscribe(setState), [bridge]);

  const run = useCallback(
    async (action: Action, call: () => Promise<MeetingTranscriptionActionResult>) => {
      setPending(action);
      setRefusal(undefined);
      try {
        const result = await call();
        if (!result.accepted) setRefusal(result.reason ?? "unsupported");
        return result;
      } finally {
        setPending(undefined);
      }
    },
    []
  );

  return {
    state,
    pending,
    /** Why the last command was refused, such as `key_rejected`. */
    refusal,
    setProvider: (input: MeetingTranscriptionSetProviderInput) =>
      run("setProvider", () => bridge.meetingTranscription.setProvider(input)),
    clearKey: () => run("clearKey", () => bridge.meetingTranscription.clearKey()),
    retryVerify: () =>
      run("retryVerify", () => bridge.meetingTranscription.retryVerify()),
  };
}
