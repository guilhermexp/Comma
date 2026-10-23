import { openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import type { RecordingEncoder } from "../modules/audio-capture/encoder";
import { localModelMissingReason } from "../modules/audio-capture/transcription";
import { readTranscriptionStream } from "../modules/audio-capture/transcription-stream";
import type { RecordingASRSession } from "../modules/audio-capture/transcription";
import {
  PushToTalkTranscriptionError,
  type PushToTalkTranscriber,
  type PushToTalkTranscript,
} from "./transcriber";

/** A short turn needs far less than the recordings' ten-minute wait. */
const remoteTranscriptionTimeoutMs = 120_000;

// `[HH:MM:SS] ` and an optional `Speaker N: ` lead each transcript line
// (salix_llm/transcribe.ex).
const transcriptLabel = /^\[\d{2,}:\d{2}:\d{2}\]\s*(?:Speaker \d+:\s*)?/;

/** The turn's words without the meeting transcript's clock and speaker labels. */
export function stripTranscriptLabels(transcript: string) {
  return transcript
    .split("\n")
    .map((line) => line.trim().replace(transcriptLabel, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Remote mode: encodes the WAV to M4A with the native helper and sends it to
 * `POST /v1/comma/me/recordings/transcribe`, where the server's meeting
 * engine transcribes it. The M4A is deleted when the call ends.
 */
export class RemotePushToTalkTranscriber implements PushToTalkTranscriber {
  readonly #encoder: RecordingEncoder;
  readonly #bindSession: () => RecordingASRSession;
  readonly #runOwned: <T>(handler: () => Promise<T>) => Promise<T>;

  constructor(options: {
    encoder: RecordingEncoder;
    bindSession: () => RecordingASRSession;
    /** The turn starts from the native hotkey, outside any renderer call. */
    runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
  }) {
    this.#encoder = options.encoder;
    this.#bindSession = options.bindSession;
    this.#runOwned = options.runOwned;
  }

  /** The server owns the engine; its refusal arrives with the answer. */
  async ready() {
    return true;
  }

  transcribe(wavPath: string): Promise<PushToTalkTranscript> {
    return this.#runOwned(() => this.#transcribe(wavPath));
  }

  async #transcribe(wavPath: string): Promise<PushToTalkTranscript> {
    const session = this.#bindSession();
    let m4aPath: string | undefined;
    try {
      m4aPath = await this.#encoder.encode(wavPath);
      const response = await session.fetch(session.url, {
        method: "POST",
        headers: { "content-type": "audio/mp4", accept: "text/event-stream" },
        body: await openAsBlob(m4aPath, { type: "audio/mp4" }),
        signal: AbortSignal.timeout(remoteTranscriptionTimeoutMs),
      });
      session.assertCurrent();
      const result = response.ok ? await readTranscriptionStream(response) : undefined;
      if (!result)
        throw new PushToTalkTranscriptionError(
          "transcription_failed",
          `HTTP ${response.status}`
        );
      if (result.status === "error")
        throw new PushToTalkTranscriptionError(
          result.reason === localModelMissingReason
            ? "transcription_unavailable"
            : "transcription_failed",
          result.reason
        );
      const { transcript, fallback } = result.result;
      return {
        text: stripTranscriptLabels(transcript),
        ...(fallback ? { fallback } : {}),
      };
    } catch (error) {
      if (error instanceof PushToTalkTranscriptionError) throw error;
      throw new PushToTalkTranscriptionError(
        "transcription_failed",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      if (m4aPath) await rm(m4aPath, { force: true }).catch(() => undefined);
    }
  }
}
