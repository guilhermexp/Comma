#!/usr/bin/env node
"use strict";

// Side Chat helper stand-in for the hold-to-talk chord. It acknowledges every
// command and logs each received push-to-talk.shortcut frame to
// COMMA_PTT_FIXTURE_LOG. COMMA_PTT_FIXTURE_MODE selects the behavior:
// - "crash-while-held": the first helper presses the chord with Safari in
//   front and exits while it is held; the restarted helper presses (no
//   frontmost app) and releases after the replayed registration.
// - "reject": every registration with a keyCode is refused.
// - "chord": a modifier-only binding reports Input Monitoring denied until
//   push-to-talk.request-input-monitoring grants it; the grant is followed by
//   a press and release, then a press cancelled by another key.

const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");

const protocolVersion = 3;
const logPath = process.env.COMMA_PTT_FIXTURE_LOG;
const mode = process.env.COMMA_PTT_FIXTURE_MODE;
const crashedMarker = `${logPath}.crashed`;
let inputMonitoring = "denied";

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emitResult(requestId, ok, error) {
  emit({
    ...(error ? { error } : {}),
    kind: "command.result",
    ok,
    protocolVersion,
    requestId,
  });
}

function emitPermission() {
  emit({
    inputMonitoring,
    kind: "push-to-talk.permission",
    protocolVersion,
    requestId: "fixture-permission",
  });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }

  const requestId = typeof frame.requestId === "string" ? frame.requestId : "fixture";
  if (frame.kind === "push-to-talk.request-input-monitoring") {
    appendFileSync(logPath, `${JSON.stringify({ request: "input-monitoring" })}\n`);
    inputMonitoring = "granted";
    emitPermission();
    emitResult(requestId, true);
    if (mode !== "chord") return;
    for (const [kind, extra] of [
      ["push-to-talk.pressed", { frontmostApp: { name: "Finder" } }],
      ["push-to-talk.released", { cancelled: false }],
      ["push-to-talk.pressed", {}],
      ["push-to-talk.released", { cancelled: true }],
    ]) {
      emit({ ...extra, kind, protocolVersion, requestId: `fixture-${kind}` });
    }
    return;
  }

  if (frame.kind === "push-to-talk.shortcut") {
    const binding = frame.binding ?? null;
    appendFileSync(logPath, `${JSON.stringify({ binding })}\n`);
    if (mode === "reject" && binding?.keyCode !== undefined) {
      emitResult(requestId, false, "The fixture refused the push-to-talk chord.");
      return;
    }
    if (binding && binding.keyCode === undefined) emitPermission();
    emitResult(requestId, true);
    if (mode !== "crash-while-held" || binding?.keyCode === undefined) return;

    if (!existsSync(crashedMarker)) {
      writeFileSync(crashedMarker, "1");
      emit({
        frontmostApp: { bundleId: "com.apple.Safari", name: "Safari" },
        kind: "push-to-talk.pressed",
        protocolVersion,
        requestId: "fixture-pressed-1",
      });
      setTimeout(() => process.exit(1), 30);
      return;
    }
    emit({
      kind: "push-to-talk.pressed",
      protocolVersion,
      requestId: "fixture-pressed-2",
    });
    emit({
      cancelled: false,
      kind: "push-to-talk.released",
      protocolVersion,
      requestId: "fixture-released-2",
    });
    return;
  }

  if (frame.kind === "side-chat.stop") {
    emitResult(requestId, true);
    setImmediate(() => process.exit(0));
    return;
  }

  if (frame.kind !== "command.result" && frame.kind !== "chat.snapshot") {
    emitResult(requestId, true);
  }
});
input.on("close", () => process.exit(0));

emit({
  kind: "side-chat.ready",
  protocolVersion,
  requestId: "push-to-talk-fixture-ready",
});
