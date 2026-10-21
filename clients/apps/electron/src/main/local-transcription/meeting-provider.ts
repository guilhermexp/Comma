import {
  unavailableMeetingTranscriptionState,
  type MeetingTranscriptionActionResult,
  type MeetingTranscriptionSetProviderInput,
  type MeetingTranscriptionState,
} from "@comma/native-bridge";

/** Main's handler of the `meetingTranscription.*` native capabilities (contract C8). */
export interface MeetingTranscriptionProvider {
  state(input: void): Promise<MeetingTranscriptionState>;
  setProvider(
    input: MeetingTranscriptionSetProviderInput
  ): Promise<MeetingTranscriptionActionResult>;
  clearKey(input: void): Promise<MeetingTranscriptionActionResult>;
  retryVerify(input: void): Promise<MeetingTranscriptionActionResult>;
}

/** Builds with a remote backend: transcription runs on the server, nothing to choose. */
export const unavailableMeetingTranscriptionProvider: MeetingTranscriptionProvider = {
  state: async () => unavailableMeetingTranscriptionState,
  setProvider: async () => ({ accepted: false, reason: "unsupported" }),
  clearKey: async () => ({ accepted: false, reason: "unsupported" }),
  retryVerify: async () => ({ accepted: false, reason: "unsupported" }),
};
