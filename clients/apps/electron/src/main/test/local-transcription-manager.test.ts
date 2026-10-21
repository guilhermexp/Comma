import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalTranscriptionState } from "@comma/native-bridge";
import {
  LocalTranscriptionManager,
  type LocalTranscriptionEnvironment,
} from "../local-transcription/manager";

const helper = join(import.meta.dirname, "fixtures", "fake-comma-transcriber.mjs");
chmodSync(helper, 0o755);
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function manager(
  overrides: Partial<LocalTranscriptionEnvironment> = {},
  options: { busy?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "comma-local-transcription-"));
  dirs.push(root);
  const states: LocalTranscriptionState[] = [];
  const health = vi.fn(async () => ({ busy: options.busy ?? false }));
  const subject = new LocalTranscriptionManager({
    environment: {
      localMode: true,
      arch: "arm64",
      macosVersion: "15.1.0",
      executable: helper,
      modelsDir: join(root, "Models"),
      ...overrides,
    },
    health,
    onState: (state) => states.push(state),
  });
  return { subject, states, health, modelsDir: join(root, "Models") };
}

const settled = (subject: LocalTranscriptionManager, phase: string) =>
  vi.waitFor(
    async () => {
      expect((await subject.state()).phase).toBe(phase);
    },
    { timeout: 5_000 }
  );

describe("local transcription model manager", () => {
  it("reports an installable model with its download size on a supported Mac", async () => {
    const { subject } = manager();
    expect(await subject.state()).toEqual({
      supported: true,
      phase: "not_installed",
      sizeBytes: 654_000_000,
    });
  });

  it("publishes download progress, then preparing, and ends ready", async () => {
    const { subject, states } = manager();
    await subject.state();

    expect(await subject.install()).toEqual({ accepted: true });
    await settled(subject, "ready");

    const phases = states.map((state) =>
      state.phase === "downloading" ? `downloading ${state.fraction}` : state.phase
    );
    expect(phases).toEqual([
      "not_installed",
      "downloading 0",
      "downloading 0.25",
      "downloading 0.5",
      "downloading 1",
      "preparing",
      "ready",
    ]);
    expect(states.at(-1)).toEqual({
      supported: true,
      phase: "ready",
      sizeBytes: 654_000_000,
    });
  });

  it("fails a download whose files do not match the manifest and never reports ready", async () => {
    vi.stubEnv("FAKE_TRANSCRIBER_MODE", "checksum");
    const { subject, states, modelsDir } = manager();
    await subject.state();

    await subject.install();
    await settled(subject, "failed");

    expect((await subject.state()).error).toEqual({
      code: "checksum_mismatch",
      message: "Encoder.mlmodelc/weights/weight.bin does not match the manifest.",
    });
    expect(states.map((state) => state.phase)).not.toContain("ready");
    expect(existsSync(join(modelsDir, "ready"))).toBe(false);
    // Try again starts a new download.
    vi.stubEnv("FAKE_TRANSCRIBER_MODE", "ok");
    expect(await subject.install()).toEqual({ accepted: true });
    await settled(subject, "ready");
    expect((await subject.state()).error).toBeUndefined();
  });

  it("treats a helper that exits without a result as a failed install", async () => {
    vi.stubEnv("FAKE_TRANSCRIBER_MODE", "exit");
    const { subject } = manager();
    await subject.install();
    await settled(subject, "failed");
    expect((await subject.state()).error?.code).toBe("io");
  });

  it("cancels a running download and returns to not installed", async () => {
    vi.stubEnv("FAKE_TRANSCRIBER_MODE", "slow");
    const { subject, modelsDir } = manager();
    await subject.install();
    await vi.waitFor(async () => expect((await subject.state()).fraction).toBe(0.5));
    expect(await subject.install()).toEqual({ accepted: false, reason: "in_progress" });

    expect(await subject.cancel()).toEqual({ accepted: true });
    await settled(subject, "not_installed");
    expect((await subject.state()).error).toBeUndefined();
    expect(existsSync(join(modelsDir, ".staging-fake"))).toBe(false);
    expect(await subject.cancel()).toEqual({ accepted: false });
  });

  it("refuses to remove the model while a transcription runs", async () => {
    const { subject, health, modelsDir } = manager({}, { busy: true });
    await subject.install();
    await settled(subject, "ready");

    expect(await subject.remove()).toEqual({ accepted: false, reason: "busy" });
    expect(health).toHaveBeenCalled();
    expect((await subject.state()).phase).toBe("ready");
    expect(existsSync(join(modelsDir, "ready"))).toBe(true);
  });

  it("removes the model folder and returns to not installed", async () => {
    const { subject, modelsDir } = manager();
    await subject.install();
    await settled(subject, "ready");

    expect(await subject.remove()).toEqual({ accepted: true });
    expect((await subject.state()).phase).toBe("not_installed");
    expect(existsSync(modelsDir)).toBe(false);
  });

  it.each([
    [{ arch: "x64" }, "unsupported_cpu"],
    [{ macosVersion: "14.7.1" }, "unsupported_os"],
    [{ localMode: false }, "remote_backend"],
    [{ executable: undefined }, "helper_missing"],
  ] as const)(
    "is unavailable without installing on %o",
    async (environment, reason) => {
      const { subject, modelsDir } = manager(environment);

      expect(await subject.state()).toMatchObject({ supported: false, reason });
      expect(await subject.install()).toEqual({
        accepted: false,
        reason: "unsupported",
      });
      expect(existsSync(modelsDir)).toBe(false);
      expect(subject.needsInstall()).toBe(false);
    }
  );

  it("follows the helper when it reports the Mac unsupported", async () => {
    vi.stubEnv("FAKE_TRANSCRIBER_UNSUPPORTED", "unsupported_os");
    const { subject } = manager();
    expect(await subject.state()).toMatchObject({
      supported: false,
      reason: "unsupported_os",
    });
  });

  it("asks for an install only while a supported model is missing", async () => {
    const { subject } = manager();
    await subject.state();
    expect(subject.needsInstall()).toBe(true);
    await subject.install();
    await settled(subject, "ready");
    expect(subject.needsInstall()).toBe(false);
  });
});
