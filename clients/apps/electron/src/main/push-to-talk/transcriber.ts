import type { PushToTalkErrorCode } from "./types";

export type PushToTalkTranscript = {
  text: string;
  /** The cloud provider failed and this Mac's model transcribed instead. */
  fallback?: { from: string; reason: string };
};

/** Transcribes one turn's WAV with the engine chosen for meetings (D5). */
export interface PushToTalkTranscriber {
  /** Checked at the press: false shows the error without recording. */
  ready(): Promise<boolean>;
  transcribe(wavPath: string): Promise<PushToTalkTranscript>;
}

export type PushToTalkTranscriptionErrorCode = Extract<
  PushToTalkErrorCode,
  "transcription_unavailable" | "transcription_busy" | "transcription_failed"
>;

/** A transcription failure that names the pill it shows. */
export class PushToTalkTranscriptionError extends Error {
  constructor(
    readonly code: PushToTalkTranscriptionErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = "PushToTalkTranscriptionError";
  }
}
