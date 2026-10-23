import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MicrophoneCapture } from "../modules/audio-capture/microphone";
import { WAV_TARGET_SAMPLE_RATE, WavSink } from "../modules/audio-capture/wav";
import type { PushToTalkMicrophone, PushToTalkRecording } from "./controller";

/** 50 ms of 16 kHz audio: one level reading per window, ~20 Hz. */
const levelWindowSamples = WAV_TARGET_SAMPLE_RATE / 20;
/** Levels map -50 dBFS (silence) .. -10 dBFS (loud speech) onto 0..1. */
const levelFloorDb = -50;
const levelRangeDb = 40;

/**
 * Records one turn with the MicCaptureHost helper into a 16 kHz mono WAV in
 * `directory`. `start` resolves at the helper's ready signal and passes its
 * `MicrophoneDeniedError` on; the controller deletes the WAV after the turn.
 * `onLevel` gets the RMS level of every 50 ms of audio, 0..1.
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

  async start(
    input: { onLevel?: (level: number) => void } = {}
  ): Promise<PushToTalkRecording> {
    await mkdir(this.#directory, { recursive: true });
    const path = join(this.#directory, `push-to-talk-${randomUUID()}.wav`);
    const sink = await WavSink.open({
      channels: 1,
      path,
      sampleRate: WAV_TARGET_SAMPLE_RATE,
    });
    const meter = input.onLevel && levelMeter(input.onLevel);
    let session: Awaited<ReturnType<MicrophoneCapture["start"]>>;
    try {
      session = await this.#capture.start({
        sampleRate: WAV_TARGET_SAMPLE_RATE,
        onFrames: (frames) => {
          sink.write(frames);
          meter?.(frames);
        },
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

function levelMeter(onLevel: (level: number) => void) {
  let sumOfSquares = 0;
  let samples = 0;
  return (frames: Float32Array) => {
    for (const sample of frames) {
      sumOfSquares += sample * sample;
      samples += 1;
      if (samples < levelWindowSamples) continue;
      const rms = Math.sqrt(sumOfSquares / samples);
      const db = rms > 0 ? 20 * Math.log10(rms) : levelFloorDb;
      onLevel(Math.min(1, Math.max(0, (db - levelFloorDb) / levelRangeDb)));
      sumOfSquares = 0;
      samples = 0;
    }
  };
}
