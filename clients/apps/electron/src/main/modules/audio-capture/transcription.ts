import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { createParser } from "eventsource-parser";
import { z } from "zod";
import type {
  AudioCaptureDriveFile,
  AudioCaptureRecording,
  AudioCaptureTranscribeSavedResult,
} from "@comma/native-bridge";
import type { DriveRecordingStore, RecordingDriveTarget } from "./drive-recordings";

const transcriptResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    result: z.object({
      transcript: z.string().max(8_000_000),
      duration_seconds: z.number().int().nonnegative(),
      chunks: z
        .array(
          z.object({
            index: z.number().int().nonnegative(),
            offset_seconds: z.number().nonnegative(),
            transcript: z.string().max(8_000_000),
          })
        )
        .max(48),
    }),
  }),
  z.object({ status: z.literal("error"), reason: z.string().max(500) }),
]);

/** Two hours of AAC at 48 kbps is about 41 MiB (openspec add-local-meeting-asr, D8). */
export const maxTranscriptionBytes = 64 * 1024 * 1024;

/** The server's exact reason when the local transcription model is missing (contract C3). */
export const localModelMissingReason = "local_asr_model_not_installed";

export interface RecordingASRSession {
  fetch: typeof fetch;
  url: URL;
  assertCurrent(): void;
}

/** Audio is already in Drive. ASR failures cannot change its saved receipt. */
export class RecordingTranscriptionService {
  #active = 0;
  constructor(
    private readonly drive: Pick<
      DriveRecordingStore,
      "writeTranscript" | "resolveSaved"
    >,
    private readonly bindSession: () => RecordingASRSession,
    private readonly options: {
      /** The server has no local model: the renderer shows the install notice. */
      onModelMissing?: (recording: AudioCaptureRecording) => void;
    } = {}
  ) {}

  /**
   * Sends a recording already in Drive through transcription again, for one
   * without a transcript or whose transcript recorded an error.
   */
  async transcribeSaved(
    driveFile: AudioCaptureDriveFile
  ): Promise<AudioCaptureTranscribeSavedResult> {
    let saved;
    try {
      saved = await this.drive.resolveSaved(driveFile);
    } catch {
      return { status: "failed", reason: "The recording is not available in Drive." };
    }
    const name = basename(driveFile.path);
    // Only the Drive reference, name and size reach the transcript files.
    const recording: AudioCaptureRecording = {
      channels: 1,
      durationMs: 0,
      sampleRate: 48_000,
      driveFile,
      file: {
        name,
        size: saved.size,
        mediaType: name.endsWith(".m4a") ? "audio/mp4" : "audio/wav",
      },
    };
    return this.process(recording, saved.target, saved.path);
  }

  async process(
    recording: AudioCaptureRecording,
    target: RecordingDriveTarget,
    sourcePath: string
  ): Promise<AudioCaptureTranscribeSavedResult> {
    const session = this.bindSession();
    let admitted = false;
    try {
      // At most two ASR requests per client, with no queue or automatic replay.
      if (this.#active >= 2)
        throw new Error("Transcription is busy. The audio remains in Drive.");
      admitted = true;
      this.#active++;
      if (recording.file.size > maxTranscriptionBytes)
        throw new Error(
          "ASR accepts recordings up to 64 MiB. The audio remains in Drive."
        );
      const result = await transcribeRecording(session, sourcePath);
      session.assertCurrent();
      await this.drive.writeTranscript(recording, target, "txt", result.transcript);
      session.assertCurrent();
      await this.drive.writeTranscript(
        recording,
        target,
        "json",
        JSON.stringify(
          {
            status: "ready",
            source: recording.driveFile,
            ...result,
          },
          null,
          2
        )
      );
      return { status: "ready" };
    } catch (error) {
      session.assertCurrent();
      const reason =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Transcription failed. The audio remains in Drive.";
      if (reason === localModelMissingReason) this.options.onModelMissing?.(recording);
      await this.drive.writeTranscript(
        recording,
        target,
        "json",
        JSON.stringify(
          {
            status: "error",
            source: recording.driveFile,
            reason,
          },
          null,
          2
        )
      );
      return { status: "failed", reason };
    } finally {
      if (admitted) this.#active--;
    }
  }
}

async function transcribeRecording(session: RecordingASRSession, sourcePath: string) {
  const response = await session.fetch(session.url, {
    method: "POST",
    headers: { "content-type": "audio/mp4", accept: "text/event-stream" },
    body: await openAsBlob(sourcePath, { type: "audio/mp4" }),
    signal: AbortSignal.timeout(620_000),
  });
  if (!response.ok || !response.body)
    throw new Error("Transcription is unavailable. The audio remains in Drive.");
  let result: z.infer<typeof transcriptResult> | undefined;
  const parser = createParser({
    maxBufferSize: 16 * 1024 * 1024,
    onEvent(event) {
      if (event.event === "transcription")
        result = transcriptResult.parse(JSON.parse(event.data));
    },
    onError(error) {
      throw error;
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (result) break;
    }
    parser.feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!result)
    throw new Error("Transcription was interrupted. The audio remains in Drive.");
  if (result.status === "error") throw new Error(result.reason);
  return result.result;
}
