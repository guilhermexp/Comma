import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MicrophoneCapture } from "../modules/audio-capture/microphone";
import { WAV_TARGET_SAMPLE_RATE, WavSink } from "../modules/audio-capture/wav";
import type { PushToTalkMicrophone, PushToTalkRecording } from "./controller";

/**
 * Records one turn with the MicCaptureHost helper into a 16 kHz mono WAV in
 * `directory`. `start` resolves at the helper's ready signal and passes its
 * `MicrophoneDeniedError` on; the controller deletes the WAV after the turn.
 */
export class HelperPushToTalkMicrophone implements PushToTalkMicrophone {
  readonly #capture: MicrophoneCapture;
  readonly #directory: string;
  readonly #log: ((message: string) => void) | undefined;

  constructor(options: {
    capture: MicrophoneCapture;
    directory: string;
    log?: (message: string) => void;
  }) {
    this.#capture = options.capture;
    this.#directory = options.directory;
    this.#log = options.log;
  }

  async start(): Promise<PushToTalkRecording> {
    await mkdir(this.#directory, { recursive: true });
    const path = join(this.#directory, `push-to-talk-${randomUUID()}.wav`);
    const sink = await WavSink.open({
      channels: 1,
      path,
      sampleRate: WAV_TARGET_SAMPLE_RATE,
    });
    let session: Awaited<ReturnType<MicrophoneCapture["start"]>>;
    try {
      session = await this.#capture.start({
        sampleRate: WAV_TARGET_SAMPLE_RATE,
        onFrames: (frames) => sink.write(frames),
        // A helper failure after ready ends the audio early; the WAV keeps
        // what arrived and the release still transcribes it.
        onError: (error) => this.#log?.(`Push-to-talk microphone: ${error.message}`),
      });
    } catch (error) {
      await sink.discard().catch(() => undefined);
      throw error;
    }
    return {
      stop: async () => {
        try {
          await session.stop();
          await sink.finalize();
        } catch (error) {
          await sink.discard().catch(() => undefined);
          throw error;
        }
        return path;
      },
    };
  }
}
