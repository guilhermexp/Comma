import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MicrophoneDeniedError,
  type MicrophoneCapture,
  type MicrophoneStartInput,
} from "../modules/audio-capture/microphone";
import { HelperPushToTalkMicrophone } from "../push-to-talk/microphone";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "comma-ptt-mic-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function capture(
  start: (input: MicrophoneStartInput) => Promise<{ stop(): Promise<void> }>
) {
  return {
    available: () => true,
    devices: vi.fn(),
    start: vi.fn(start),
  } satisfies MicrophoneCapture;
}

describe("HelperPushToTalkMicrophone", () => {
  it("records the helper's frames into a 16 kHz mono WAV once the helper is ready", async () => {
    let feed: ((frames: Float32Array) => void) | undefined;
    const session = { stop: vi.fn(async () => undefined) };
    const helper = capture(async (input) => {
      feed = input.onFrames;
      return session;
    });
    const microphone = new HelperPushToTalkMicrophone({ capture: helper, directory });

    const recording = await microphone.start();
    expect(helper.start).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16_000 })
    );
    feed?.(new Float32Array(1_600).fill(0.5));
    const path = await recording.stop();

    expect(session.stop).toHaveBeenCalledOnce();
    expect(path.startsWith(directory)).toBe(true);
    const wav = await readFile(path);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(1_600 * 2);
  });

  it("passes macOS's denial on as MicrophoneDeniedError and leaves no file", async () => {
    const microphone = new HelperPushToTalkMicrophone({
      capture: capture(() => Promise.reject(new MicrophoneDeniedError())),
      directory,
    });

    await expect(microphone.start()).rejects.toBeInstanceOf(MicrophoneDeniedError);
    expect(await readdir(directory)).toEqual([]);
  });
});
