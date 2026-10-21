#!/usr/bin/env node
// A stand-in for CommaTranscriber's status, install, remove and serve
// subcommands (openspec add-local-meeting-asr C1/C2, add-cloud-meeting-asr
// C5/C6). FAKE_TRANSCRIBER_MODE picks the install outcome: ok, checksum,
// slow (waits for SIGTERM) or exit. FAKE_TRANSCRIBER_LEGACY omits the
// components from status, as a helper from before C5 does.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const modelsDir = option("--models-dir");
const component = option("--component") ?? "all";
const mode = process.env.FAKE_TRANSCRIBER_MODE ?? "ok";
const componentBytes = { asr: 632_000_000, diarization: 22_000_000 };
const totalBytes = componentBytes.asr + componentBytes.diarization;
// A tree from before C5 has only `ready`, which counts as both components.
const legacyMarker = join(modelsDir ?? ".", "ready");
const marker = (name) => join(modelsDir ?? ".", `ready-${name}`);
const installed = (name) => existsSync(legacyMarker) || existsSync(marker(name));
const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const staging = join(modelsDir ?? ".", ".staging-fake");

if (process.env.FAKE_TRANSCRIBER_ARGV_LOG)
  appendFileSync(
    process.env.FAKE_TRANSCRIBER_ARGV_LOG,
    `${JSON.stringify({ argv: process.argv.slice(2), env: process.env })}\n`
  );

if (command === "status") {
  const unsupported = process.env.FAKE_TRANSCRIBER_UNSUPPORTED;
  const components = { asr: installed("asr"), diarization: installed("diarization") };
  emit({
    type: "status",
    supported: !unsupported,
    reason: unsupported || null,
    installed: components.asr && components.diarization,
    downloadBytes: totalBytes,
    ...(process.env.FAKE_TRANSCRIBER_LEGACY ? {} : { components, componentBytes }),
  });
  process.exit(0);
}

if (command === "remove") {
  if (component === "asr") {
    if (existsSync(legacyMarker)) {
      rmSync(legacyMarker);
      writeFileSync(marker("diarization"), "");
    }
    rmSync(marker("asr"), { force: true });
  } else {
    rmSync(modelsDir, { recursive: true, force: true });
  }
  emit({ type: "result", ok: true });
  process.exit(0);
}

if (command === "install") {
  const bytes = component === "all" ? totalBytes : componentBytes[component];
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
      bytes: fraction * bytes,
      totalBytes: bytes,
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
      bytes,
      totalBytes: bytes,
    });
    emit({ type: "progress", phase: "preparing" });
    rmSync(staging, { recursive: true, force: true });
    for (const name of component === "all" ? ["asr", "diarization"] : [component])
      writeFileSync(marker(name), "");
    emit({ type: "result", ok: true });
    process.exit(0);
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};
const cloudBody = (body) =>
  (body.kind === "groq" || body.kind === "openai_compatible") &&
  typeof body.baseUrl === "string" &&
  typeof body.model === "string" &&
  typeof body.apiKey === "string" &&
  Number.isInteger(body.maxUploadBytes);

// C6: the provider lives in memory only, so a restarted helper reports
// `configured: false` until Main sends it again. GET /fake/provider is this
// fake's own probe, so tests can see what Main delivered. PUT
// /fake/last-failure sets the 502 failure /health reports, as the real
// helper does after a job that no local model took over.
if (command === "serve") {
  const token = readFileSync(option("--token-file"), "utf8").trim();
  let provider = { kind: "local" };
  let configured = false;
  let lastFailure;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.method === "GET" && request.url === "/health")
      return json(response, 200, {
        status: "ok",
        busy: Boolean(process.env.FAKE_TRANSCRIBER_BUSY),
        model: installed("asr") ? "ready" : "not_installed",
        provider: {
          kind: provider.kind,
          configured,
          ...(lastFailure ? { lastFailure } : {}),
        },
        components: { asr: installed("asr"), diarization: installed("diarization") },
      });
    if (request.headers.authorization !== `Bearer ${token}`)
      return json(response, 401, { error: { code: "unauthorized" } });
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return json(response, 400, { error: { code: "bad_request" } });
    }
    if (request.method === "PUT" && request.url === "/v1/provider") {
      if (body?.kind !== "local" && !cloudBody(body ?? {}))
        return json(response, 400, { error: { code: "bad_request" } });
      provider = body;
      configured = true;
      lastFailure = undefined;
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "POST" && request.url === "/v1/provider/verify") {
      if (!cloudBody(body ?? {}))
        return json(response, 400, { error: { code: "bad_request" } });
      return json(
        response,
        200,
        body.apiKey.startsWith("valid")
          ? { ok: true }
          : { ok: false, reason: "cloud_auth_rejected" }
      );
    }
    if (request.method === "PUT" && request.url === "/fake/last-failure") {
      lastFailure = body;
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "GET" && request.url === "/fake/provider")
      return json(response, 200, { provider, configured });
    return json(response, 404, { error: { code: "not_found" } });
  });
  server.listen(Number(option("--port")), "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
