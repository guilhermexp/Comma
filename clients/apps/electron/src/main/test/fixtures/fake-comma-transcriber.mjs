#!/usr/bin/env node
// A stand-in for CommaTranscriber's status, install and remove subcommands
// (openspec add-local-meeting-asr, contract C1). FAKE_TRANSCRIBER_MODE picks
// the install outcome: ok, checksum, slow (waits for SIGTERM) or exit.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const modelsDir = args[args.indexOf("--models-dir") + 1];
const mode = process.env.FAKE_TRANSCRIBER_MODE ?? "ok";
const totalBytes = 654_000_000;
const marker = join(modelsDir, "ready");
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const staging = join(modelsDir, ".staging-fake");

if (command === "status") {
  const unsupported = process.env.FAKE_TRANSCRIBER_UNSUPPORTED;
  emit({
    type: "status",
    supported: !unsupported,
    reason: unsupported || null,
    installed: existsSync(marker),
    downloadBytes: totalBytes,
  });
  process.exit(0);
}

if (command === "remove") {
  rmSync(modelsDir, { recursive: true, force: true });
  emit({ type: "result", ok: true });
  process.exit(0);
}

if (command === "install") {
  mkdirSync(staging, { recursive: true });
  process.on("SIGTERM", () => {
    rmSync(staging, { recursive: true, force: true });
    emit({
      type: "result",
      ok: false,
      error: { code: "cancelled", message: "Cancelled." },
    });
    process.exit(1);
  });
  for (const fraction of [0.25, 0.5]) {
    emit({
      type: "progress",
      phase: "downloading",
      fraction,
      bytes: fraction * totalBytes,
      totalBytes,
    });
  }
  if (mode === "slow") {
    setInterval(() => undefined, 1_000);
  } else if (mode === "exit") {
    process.exit(3);
  } else if (mode === "checksum") {
    rmSync(staging, { recursive: true, force: true });
    emit({
      type: "result",
      ok: false,
      error: {
        code: "checksum_mismatch",
        message: "Encoder.mlmodelc/weights/weight.bin does not match the manifest.",
      },
    });
    process.exit(1);
  } else {
    emit({
      type: "progress",
      phase: "downloading",
      fraction: 1,
      bytes: totalBytes,
      totalBytes,
    });
    emit({ type: "progress", phase: "preparing" });
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(marker, "");
    emit({ type: "result", ok: true });
    process.exit(0);
  }
}
