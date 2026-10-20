import {
  unavailableLocalTranscriptionState,
  type LocalTranscriptionActionResult,
  type LocalTranscriptionState,
} from "@comma/native-bridge";

/** Main's handler of the `localTranscription.*` native capabilities. */
export interface LocalTranscriptionProvider {
  state(input: void): Promise<LocalTranscriptionState>;
  install(input: void): Promise<LocalTranscriptionActionResult>;
  cancel(input: void): Promise<LocalTranscriptionActionResult>;
  remove(input: void): Promise<LocalTranscriptionActionResult>;
}

/** Builds with a remote backend: transcription runs on the server, nothing to install. */
export const unavailableLocalTranscriptionProvider: LocalTranscriptionProvider = {
  state: async () => unavailableLocalTranscriptionState,
  install: async () => ({ accepted: false, reason: "unsupported" }),
  cancel: async () => ({ accepted: false }),
  remove: async () => ({ accepted: false, reason: "unsupported" }),
};
