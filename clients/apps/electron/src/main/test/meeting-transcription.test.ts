import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingTranscriptionState } from "@comma/native-bridge";
import { LocalTranscriptionManager } from "../local-transcription/manager";
import { MeetingTranscriptionService } from "../local-transcription/meeting-transcription";
import {
  MeetingProviderStore,
  type SafeStorageLike,
} from "../local-transcription/provider-store";
import { TranscriberProviderClient } from "../local-transcription/helper-provider-client";

const helper = join(import.meta.dirname, "fixtures", "fake-comma-transcriber.mjs");
chmodSync(helper, 0o755);
const groqKey = "gsk_secret_groq_key_0123456789";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x33)),
    decryptString: (data) => Buffer.from(data.map((byte) => byte ^ 0x33)).toString(),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Answers `GET {groq}/models` like Groq would for `keys`. */
function groqFetch(keys: Record<string, number>) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    expect(String(url)).toBe("https://api.groq.com/openai/v1/models");
    return new Response("{}", {
      status: keys[authorization.replace(/^Bearer /, "")] ?? 401,
    });
  });
}

async function fixture(
  options: { fetch?: typeof fetch; safeStorage?: SafeStorageLike } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "comma-meeting-transcription-"));
  cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const modelsDir = join(root, "Models");
  const tokenFile = join(root, "asr-token");
  const token = "helper-bearer-token";
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const argvLog = join(root, "argv.jsonl");
  vi.stubEnv("FAKE_TRANSCRIBER_ARGV_LOG", argvLog);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const helperLog: string[] = [];
  const startHelper = async () => {
    child = spawn(
      helper,
      [
        "serve",
        "--port",
        String(port),
        "--token-file",
        tokenFile,
        "--models-dir",
        modelsDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout!.on("data", (data) => helperLog.push(String(data)));
    child.stderr!.on("data", (data) => helperLog.push(String(data)));
    await vi.waitFor(async () => expect((await fetch(`${url}/health`)).ok).toBe(true), {
      timeout: 5_000,
      interval: 50,
    });
  };
  const stopHelper = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    await new Promise((resolve) => {
      running.once("exit", resolve);
      running.kill("SIGTERM");
    });
  };
  cleanups.push(stopHelper);
  await startHelper();

  const logs: string[] = [];
  const states: MeetingTranscriptionState[] = [];
  const store = new MeetingProviderStore({
    path: join(root, "asr-provider.bin"),
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
  });
  let service: MeetingTranscriptionService | undefined;
  const local = new LocalTranscriptionManager({
    environment: {
      localMode: true,
      arch: "arm64",
      macosVersion: "15.1.0",
      executable: helper,
      modelsDir,
    },
    health: async () => ({ busy: false }),
    onState: () => service?.localChanged(),
    keepDiarization: () => service?.cloudSelected() ?? false,
    onDiarization: () => service?.localChanged(),
    log: (message) => logs.push(message),
  });
  service = new MeetingTranscriptionService({
    store,
    local,
    helper: new TranscriberProviderClient({ url: () => url, token: () => token }),
    fetch: options.fetch,
    onState: (state) => states.push(state),
    log: (message) => logs.push(message),
  });
  const delivered = async () =>
    (await (
      await fetch(`${url}/fake/provider`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { provider: Record<string, unknown>; configured: boolean };
  const failCloud = async (failure: Record<string, string>) =>
    fetch(`${url}/fake/last-failure`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(failure),
    });
  const helperAck = async (mode: "ok" | "refuse" | "lost") =>
    fetch(`${url}/fake/provider-ack`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode }),
    });
  /** The provider a job sent to the helper now would use. */
  const jobProvider = async () =>
    (
      (await (
        await fetch(`${url}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { provider: string }
    ).provider;
  const processes = () =>
    readFileSync(argvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => line);
  return {
    service,
    local,
    store,
    root,
    modelsDir,
    logs,
    helperLog,
    states,
    delivered,
    failCloud,
    helperAck,
    jobProvider,
    processes,
    startHelper,
    stopHelper,
  };
}

/** The helper's whole-second ISO-8601 time. */
const at = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const groq = { kind: "groq", model: "whisper-large-v3", apiKey: groqKey } as const;

describe("meeting transcription provider (openspec add-cloud-meeting-asr)", () => {
  it("starts on Local and asks for the local model until it is installed", async () => {
    const { service } = await fixture();
    expect(await service.state()).toEqual({
      provider: "local",
      ready: false,
      reason: "local_model_missing",
      diarization: "not_installed",
    });
  });

  it("verifies a Groq key at the fixed URL, saves it, installs only the separator and delivers it", async () => {
    const fetcher = groqFetch({ [groqKey]: 200 });
    const { service, modelsDir, delivered, store } = await fixture({ fetch: fetcher });

    expect(await service.setProvider(groq)).toEqual({ accepted: true });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      `Bearer ${groqKey}`
    );
    expect(store.read()).toEqual({
      selected: "groq",
      cloud: {
        kind: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3",
        apiKey: groqKey,
      },
    });
    expect(await delivered()).toEqual({
      configured: true,
      provider: {
        kind: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3",
        apiKey: groqKey,
        maxUploadBytes: 24_000_000,
      },
    });
    await vi.waitFor(async () => expect((await service.state()).ready).toBe(true), {
      timeout: 5_000,
    });
    expect(await service.state()).toEqual({
      provider: "groq",
      ready: true,
      cloud: {
        kind: "groq",
        model: "whisper-large-v3",
        baseHost: "api.groq.com",
        hasKey: true,
        verification: "valid",
      },
      diarization: "ready",
    });
    expect(existsSync(join(modelsDir, "ready-diarization"))).toBe(true);
    expect(existsSync(join(modelsDir, "ready-asr"))).toBe(false);
  });

  it("keeps the previous provider when the key is rejected", async () => {
    const { service, store, delivered } = await fixture({ fetch: groqFetch({}) });

    expect(await service.setProvider(groq)).toEqual({
      accepted: false,
      reason: "key_rejected",
    });
    expect(store.read()).toEqual({ selected: "local" });
    expect((await service.state()).provider).toBe("local");
    expect((await delivered()).provider).toEqual({ kind: "local" });
  });

  it("refuses an http URL outside this Mac without contacting it", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { service } = await fixture({ fetch: fetcher });
    expect(
      await service.setProvider({
        kind: "openai_compatible",
        baseUrl: "http://asr.example.com/v1",
        model: "whisper-1",
        apiKey: "sk-1",
      })
    ).toEqual({ accepted: false, reason: "insecure_url" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies an OpenAI-compatible API without /models through the helper", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));
    const { service, delivered } = await fixture({ fetch: fetcher });
    const config = {
      kind: "openai_compatible",
      baseUrl: "http://localhost:9000/v1/",
      model: "whisper-1",
    } as const;

    expect(await service.setProvider({ ...config, apiKey: "wrong" })).toEqual({
      accepted: false,
      reason: "key_rejected",
    });
    expect(await service.setProvider({ ...config, apiKey: "valid-key" })).toEqual({
      accepted: true,
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:9000/v1/models",
      "http://localhost:9000/v1/models",
    ]);
    expect((await delivered()).provider).toMatchObject({
      kind: "openai_compatible",
      baseUrl: "http://localhost:9000/v1",
      apiKey: "valid-key",
    });
    expect((await service.state()).cloud).toMatchObject({ baseHost: "localhost" });
  });

  it("reuses the saved key only for the same provider and URL origin", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const { service, store } = await fixture({ fetch: fetcher });
    const config = {
      kind: "openai_compatible",
      baseUrl: "https://asr.example.com/v1",
      model: "whisper-1",
    } as const;
    await service.setProvider({ ...config, apiKey: "sk-first" });

    expect(await service.setProvider({ ...config, model: "whisper-2" })).toEqual({
      accepted: true,
    });
    expect(store.read()).toMatchObject({
      cloud: { model: "whisper-2", apiKey: "sk-first" },
    });
    // Without a URL, the saved one is reused with its key.
    expect(
      await service.setProvider({ kind: "openai_compatible", model: "whisper-3" })
    ).toEqual({ accepted: true });
    expect(store.read()).toMatchObject({
      cloud: { baseUrl: "https://asr.example.com/v1", model: "whisper-3" },
    });
    // A changed origin never receives the saved key.
    expect(
      await service.setProvider({ ...config, baseUrl: "https://other.example.com/v1" })
    ).toEqual({ accepted: false, reason: "key_missing" });
    expect(
      await service.setProvider({ kind: "groq", model: "whisper-large-v3" })
    ).toEqual({ accepted: false, reason: "key_missing" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("makes cloud providers unavailable without safeStorage", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { service, root } = await fixture({
      fetch: fetcher,
      safeStorage: fakeSafeStorage(false),
    });
    expect(await service.setProvider(groq)).toEqual({
      accepted: false,
      reason: "secure_storage_unavailable",
    });
    expect((await service.state()).reason).toBe("secure_storage_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(root, "asr-provider.bin"))).toBe(false);
  });

  it("delivers the provider again after the helper restarts and when /health says it lost it", async () => {
    const { service, delivered, startHelper, stopHelper } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    await service.setProvider(groq);

    await stopHelper();
    await startHelper();
    expect((await delivered()).configured).toBe(false);
    await service.helperStarted();
    expect((await delivered()).provider).toMatchObject({
      kind: "groq",
      apiKey: groqKey,
    });

    await stopHelper();
    await startHelper();
    expect(await service.ensureDelivered()).toBe(true);
    expect((await delivered()).provider).toMatchObject({ kind: "groq" });
    // Nothing is sent again while the helper still holds it.
    expect(await service.ensureDelivered()).toBe(false);
  });

  it("refuses a change the helper does not acknowledge and keeps the previous provider", async () => {
    const { service, store, delivered, helperAck } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    expect(await service.setProvider(groq)).toEqual({ accepted: true });

    // The helper applies the new model but its answer is lost.
    await helperAck("lost");
    const turbo = { ...groq, model: "whisper-large-v3-turbo" } as const;
    expect(await service.setProvider(turbo)).toEqual({
      accepted: false,
      reason: "helper_unavailable",
    });
    expect((await delivered()).provider).toMatchObject({
      model: "whisper-large-v3-turbo",
    });
    expect(store.read().cloud).toMatchObject({ model: "whisper-large-v3" });
    expect((await service.state()).cloud).toMatchObject({ model: "whisper-large-v3" });

    // Same kind, still configured: the saved revision goes again until acknowledged.
    await helperAck("ok");
    expect(await service.ensureDelivered()).toBe(true);
    expect((await delivered()).provider).toMatchObject({
      kind: "groq",
      model: "whisper-large-v3",
    });
    expect(await service.ensureDelivered()).toBe(false);
  });

  it("never refuses Local or deleting the key, and applies them before the next job", async () => {
    const { service, root, store, delivered, helperAck, jobProvider } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    expect(await service.setProvider(groq)).toEqual({ accepted: true });

    // The helper is busy and keeps Groq: Local is still saved and accepted.
    await helperAck("refuse");
    expect(await service.setProvider({ kind: "local" })).toEqual({ accepted: true });
    expect(store.read()).toMatchObject({ selected: "local" });
    expect(await service.state()).toMatchObject({ provider: "local", applying: true });
    expect((await delivered()).provider).toMatchObject({ kind: "groq" });

    // Deleting the key removes it from disk at once, unacknowledged too.
    expect(await service.clearKey()).toEqual({ accepted: true });
    expect(existsSync(join(root, "asr-provider.bin"))).toBe(false);
    expect((await service.state()).cloud).toBeUndefined();

    // The helper answers again: the hook that runs before every job
    // (beforeTranscribe) gives it Local, so the job never reaches Groq.
    await helperAck("ok");
    await service.ensureDelivered();
    expect(await jobProvider()).toBe("local");
    expect((await delivered()).provider).toEqual({ kind: "local" });
    expect((await service.state()).applying).toBeUndefined();
  });

  it("applies an unacknowledged Local switch in the background", async () => {
    const { service, helperAck, jobProvider } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    await service.setProvider(groq);
    await helperAck("refuse");
    expect(await service.setProvider({ kind: "local" })).toEqual({ accepted: true });
    await helperAck("ok");

    await vi.waitFor(async () => expect(await jobProvider()).toBe("local"), {
      timeout: 5_000,
      interval: 100,
    });
    await vi.waitFor(async () =>
      expect((await service.state()).applying).toBeUndefined()
    );
  });

  it("retries an unacknowledged provider in the background until the helper takes it", async () => {
    const { service, delivered, helperAck } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    expect(await service.setProvider(groq)).toEqual({ accepted: true });
    await helperAck("lost");
    expect(
      (await service.setProvider({ ...groq, model: "whisper-large-v3-turbo" })).accepted
    ).toBe(false);
    await helperAck("ok");

    await vi.waitFor(
      async () =>
        expect((await delivered()).provider).toMatchObject({
          model: "whisper-large-v3",
        }),
      { timeout: 5_000, interval: 100 }
    );
  });

  it("keeps the key out of the helper's argv, environment and every log", async () => {
    const { service, processes, logs, helperLog, startHelper, stopHelper } =
      await fixture({ fetch: groqFetch({ [groqKey]: 200 }) });
    await service.setProvider(groq);
    await stopHelper();
    await startHelper();
    await service.helperStarted();
    await service.retryVerify();

    expect(processes().length).toBeGreaterThan(2);
    for (const line of [...processes(), ...logs, ...helperLog])
      expect(line).not.toContain(groqKey);
    expect(JSON.stringify(await service.state())).not.toContain(groqKey);
  });

  it("keeps the Groq key when Local is chosen and reuses it when Groq is chosen again", async () => {
    const fetcher = groqFetch({ [groqKey]: 200 });
    const { service, store, delivered } = await fixture({ fetch: fetcher });
    await service.setProvider(groq);

    expect(await service.setProvider({ kind: "local" })).toEqual({ accepted: true });
    expect((await delivered()).provider).toEqual({ kind: "local" });
    expect(store.read()).toMatchObject({
      selected: "local",
      cloud: { kind: "groq", apiKey: groqKey },
    });
    const local = await service.state();
    expect(local).toMatchObject({
      provider: "local",
      cloud: { kind: "groq", hasKey: true, model: "whisper-large-v3" },
    });
    expect(JSON.stringify(local)).not.toContain(groqKey);
    // Local never hears about a rejected cloud key.
    expect(local.reason).toBe("local_model_missing");

    expect(
      await service.setProvider({ kind: "groq", model: "whisper-large-v3-turbo" })
    ).toEqual({ accepted: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await delivered()).provider).toMatchObject({
      kind: "groq",
      model: "whisper-large-v3-turbo",
      apiKey: groqKey,
    });
    expect((await service.state()).provider).toBe("groq");
  });

  it("deletes a kept key while Local is selected", async () => {
    const { service, root, store } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    await service.setProvider(groq);
    await service.setProvider({ kind: "local" });

    expect(await service.clearKey()).toEqual({ accepted: true });
    expect(existsSync(join(root, "asr-provider.bin"))).toBe(false);
    expect(store.read()).toEqual({ selected: "local" });
    expect((await service.state()).cloud).toBeUndefined();
    expect(
      await service.setProvider({ kind: "groq", model: "whisper-large-v3" })
    ).toEqual({ accepted: false, reason: "key_missing" });
  });

  it("names the selected cloud provider for a cloud failure notice", async () => {
    const { service } = await fixture({ fetch: groqFetch({ [groqKey]: 200 }) });
    expect(service.cloudFailed("cloud_quota")).toBeUndefined();
    await service.setProvider(groq);
    expect(service.cloudFailed("cloud_quota")).toBe("groq");
  });

  it("reports the helper's last cloud failure since a time, for a meeting Task's job", async () => {
    const { service, failCloud } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    await service.setProvider(groq);
    const since = new Date(Date.now() - 1_000);
    expect(await service.cloudFailureSince(since)).toBeUndefined();

    await failCloud({ reason: "cloud_quota", provider: "groq", at: at(new Date()) });
    expect(await service.cloudFailureSince(since)).toEqual({
      reason: "cloud_quota",
      provider: "groq",
    });
    // A failure from before the recording is not this recording's.
    expect(
      await service.cloudFailureSince(new Date(Date.now() + 60_000))
    ).toBeUndefined();

    // A revoked key also marks the provider in Settings.
    await failCloud({
      reason: "cloud_auth_rejected",
      provider: "groq",
      at: at(new Date()),
    });
    expect(await service.cloudFailureSince(since)).toMatchObject({
      reason: "cloud_auth_rejected",
    });
    expect((await service.state()).reason).toBe("key_rejected");

    // With Local selected, the cloud is not the cause.
    await service.setProvider({ kind: "local" });
    await failCloud({ reason: "cloud_quota", provider: "groq", at: at(new Date()) });
    expect(await service.cloudFailureSince(since)).toBeUndefined();
  });

  it("returns to Local and forgets the key when it is deleted", async () => {
    const { service, root, delivered } = await fixture({
      fetch: groqFetch({ [groqKey]: 200 }),
    });
    await service.setProvider(groq);

    expect(await service.clearKey()).toEqual({ accepted: true });
    expect(existsSync(join(root, "asr-provider.bin"))).toBe(false);
    expect((await service.state()).provider).toBe("local");
    expect((await delivered()).provider).toEqual({ kind: "local" });
  });

  it("marks the key rejected after a revoked-key failure or a failed recheck", async () => {
    const keys: Record<string, number> = { [groqKey]: 200 };
    const { service } = await fixture({ fetch: groqFetch(keys) });
    await service.setProvider(groq);
    await vi.waitFor(async () => expect((await service.state()).ready).toBe(true), {
      timeout: 5_000,
    });

    service.cloudFailed("cloud_auth_rejected");
    expect(await service.state()).toMatchObject({
      ready: false,
      reason: "key_rejected",
      cloud: { verification: "rejected" },
    });

    expect(await service.retryVerify()).toEqual({ accepted: true });
    expect((await service.state()).cloud?.verification).toBe("valid");

    delete keys[groqKey];
    expect(await service.retryVerify()).toEqual({
      accepted: false,
      reason: "key_rejected",
    });
    expect((await service.state()).reason).toBe("key_rejected");
  });

  it("picks the notice a saved recording needs", async () => {
    const { service, local } = await fixture({ fetch: groqFetch({ [groqKey]: 200 }) });
    expect(await service.recordingNotice()).toBe("install_local");

    await service.setProvider(groq);
    await vi.waitFor(async () => expect((await service.state()).ready).toBe(true), {
      timeout: 5_000,
    });
    expect(await service.recordingNotice()).toBeUndefined();

    service.cloudFailed("cloud_auth_rejected");
    expect(await service.recordingNotice()).toBe("configure");

    await service.setProvider({ kind: "local" });
    await local.install();
    await vi.waitFor(async () => expect((await local.state()).phase).toBe("ready"), {
      timeout: 5_000,
    });
    expect(await service.recordingNotice()).toBeUndefined();
  });
});
