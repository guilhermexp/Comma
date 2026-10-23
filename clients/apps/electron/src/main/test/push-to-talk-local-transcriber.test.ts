import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalPushToTalkTranscriber } from "../local-transcription/push-to-talk-transcriber";
import { PushToTalkTranscriptionError } from "../push-to-talk/transcriber";

const helper = join(import.meta.dirname, "fixtures", "fake-comma-transcriber.mjs");
chmodSync(helper, 0o755);
const token = "helper-bearer-token";
let root: string;
let url: string;
let wavPath: string;
let child: ChildProcess;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "comma-ptt-transcriber-"));
  const tokenFile = join(root, "asr-token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  wavPath = join(root, "turn.wav");
  writeFileSync(wavPath, Buffer.from("RIFF fake wav"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  url = `http://127.0.0.1:${port}`;
  child = spawn(
    helper,
    ["serve", "--port", String(port), "--token-file", tokenFile, "--models-dir", root],
    { stdio: "ignore" }
  );
  await vi.waitFor(async () => expect((await fetch(`${url}/health`)).ok).toBe(true), {
    timeout: 5_000,
    interval: 50,
  });
});

afterAll(async () => {
  if (child.exitCode === null)
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  rmSync(root, { recursive: true, force: true });
});

async function script(status: number, body: unknown) {
  await fetch(`${url}/fake/transcription`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ status, body }),
  });
}

function transcriber(ready = true) {
  const beforeTranscribe = vi.fn(async () => true);
  return {
    beforeTranscribe,
    client: new LocalPushToTalkTranscriber({
      url: () => url,
      token: () => token,
      state: async () => ({ ready }),
      beforeTranscribe,
    }),
  };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(PushToTalkTranscriptionError);
  return (error as PushToTalkTranscriptionError).code;
}

describe("LocalPushToTalkTranscriber", () => {
  it("posts the WAV as multipart and returns the trimmed text", async () => {
    await script(200, { text: " Qual é esse botão? ", provider: "local" });
    const { client, beforeTranscribe } = transcriber();
    expect(await client.transcribe(wavPath)).toEqual({ text: "Qual é esse botão?" });
    expect(beforeTranscribe).toHaveBeenCalledOnce();
    const last = await (
      await fetch(`${url}/fake/last-transcription`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(last).toMatchObject({
      contentType: expect.stringMatching(/^multipart\/form-data; boundary=/),
      fileName: "turn.wav",
      responseFormat: "verbose_json",
    });
  });

  it("returns an empty text for silence", async () => {
    await script(200, { text: "", provider: "local" });
    expect(await transcriber().client.transcribe(wavPath)).toEqual({ text: "" });
  });

  it("reports the local model's fallback after a cloud failure", async () => {
    await script(200, {
      text: "ligar o tema escuro",
      provider: "local",
      fallback: { from: "groq", reason: "cloud_unreachable" },
    });
    expect(await transcriber().client.transcribe(wavPath)).toEqual({
      text: "ligar o tema escuro",
      fallback: { from: "groq", reason: "cloud_unreachable" },
    });
  });

  it.each([
    [409, "cloud_asr_not_ready"],
    [409, "local_asr_model_not_installed"],
  ])("maps %i %s to transcription_unavailable", async (status, code) => {
    await script(status, { error: { code } });
    expect(await failure(transcriber().client.transcribe(wavPath))).toBe(
      "transcription_unavailable"
    );
  });

  it("maps a cloud failure with no local model to transcription_failed", async () => {
    await script(502, {
      error: { code: "cloud_asr_failed", reason: "cloud_quota", provider: "groq" },
    });
    expect(await failure(transcriber().client.transcribe(wavPath))).toBe(
      "transcription_failed"
    );
  });

  it("is unavailable without a serving helper and follows the meeting readiness", async () => {
    const offline = new LocalPushToTalkTranscriber({
      url: () => undefined,
      token: () => undefined,
      state: async () => ({ ready: true }),
    });
    expect(await offline.ready()).toBe(false);
    expect(await failure(offline.transcribe(wavPath))).toBe(
      "transcription_unavailable"
    );
    expect(await transcriber(true).client.ready()).toBe(true);
    expect(await transcriber(false).client.ready()).toBe(false);
  });

  it("reports a busy helper when the answer exceeds the wait limit", async () => {
    const hanging = new LocalPushToTalkTranscriber({
      url: () => url,
      token: () => token,
      state: async () => ({ ready: true }),
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        ),
      timeoutMs: 20,
    });
    expect(await failure(hanging.transcribe(wavPath))).toBe("transcription_busy");
  });
});
