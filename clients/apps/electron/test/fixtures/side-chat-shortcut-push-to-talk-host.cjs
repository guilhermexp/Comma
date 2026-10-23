#!/usr/bin/env node
"use strict";

// Side Chat helper stand-in for the hold-to-talk chord. It acknowledges every
// command and logs each received push-to-talk.shortcut frame to
// COMMA_PTT_FIXTURE_LOG. COMMA_PTT_FIXTURE_MODE selects the behavior:
// - "crash-while-held": the first helper presses the chord with Safari in
//   front and exits while it is held; the restarted helper presses (no
//   frontmost app) and releases after the replayed registration.
// - "reject": every registration with a keyCode is refused.

const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");

const protocolVersion = 3;
const logPath = process.env.COMMA_PTT_FIXTURE_LOG;
const mode = process.env.COMMA_PTT_FIXTURE_MODE;
const crashedMarker = `${logPath}.crashed`;

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

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }

  const requestId = typeof frame.requestId === "string" ? frame.requestId : "fixture";
  if (frame.kind === "push-to-talk.shortcut") {
    appendFileSync(
      logPath,
      `${JSON.stringify({ keyCode: frame.keyCode ?? null, modifiers: frame.modifiers })}\n`
    );
    if (mode === "reject" && frame.keyCode !== undefined) {
      emitResult(requestId, false, "The fixture refused the push-to-talk chord.");
      return;
    }
    emitResult(requestId, true);
    if (mode !== "crash-while-held" || frame.keyCode === undefined) return;

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
