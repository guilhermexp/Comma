import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  PushToTalkTranscriptionError,
  type PushToTalkTranscriber,
  type PushToTalkTranscript,
} from "../push-to-talk/transcriber";

/**
 * How long a turn waits for the helper. A meeting job ahead in its queue
 * holds the turn in "Transcribing" until this ends (openspec
 * add-push-to-talk-agent, R3).
 */
export const pushToTalkTranscriptionTimeoutMs = 60_000;

// `verbose_json` is the format that carries the local fallback mark.
const transcriptSchema = z.object({
  text: z.string().max(1_000_000),
  fallback: z
    .object({ from: z.string().max(100), reason: z.string().max(100) })
    .optional(),
});
const errorSchema = z.object({ error: z.object({ code: z.string().max(100) }) });

// 409 from the helper: the chosen engine cannot take a job (contract C3/C6).
const unavailableCodes = new Set([
  "local_asr_model_not_installed",
  "cloud_asr_not_ready",
]);

/**
 * Local mode: sends one push-to-talk WAV to the serving CommaTranscriber's
 * `POST /v1/audio/transcriptions`, which picks Local, Groq or an
 * OpenAI-compatible API with the meeting fallback. The bearer stays in Main.
 */
export class LocalPushToTalkTranscriber implements PushToTalkTranscriber {
  readonly #url: () => string | undefined;
  readonly #token: () => string | undefined;
  readonly #fetch: typeof fetch;
  readonly #state: () => Promise<{ ready: boolean }>;
  readonly #beforeTranscribe: (() => Promise<unknown>) | undefined;
  readonly #timeoutMs: number;

  constructor(options: {
    url: () => string | undefined;
    token: () => string | undefined;
    /** `MeetingTranscriptionService.state()`. */
    state: () => Promise<{ ready: boolean }>;
    /** Delivers the saved provider to the helper, as recordings do. */
    beforeTranscribe?: () => Promise<unknown>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#url = options.url;
    this.#token = options.token;
    this.#state = options.state;
    this.#beforeTranscribe = options.beforeTranscribe;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? pushToTalkTranscriptionTimeoutMs;
  }

  async ready(): Promise<boolean> {
    if (!this.#url() || !this.#token()) return false;
    return (await this.#state().catch(() => ({ ready: false }))).ready;
  }

  async transcribe(wavPath: string): Promise<PushToTalkTranscript> {
    const url = this.#url();
    const token = this.#token();
    if (!url || !token)
      throw new PushToTalkTranscriptionError("transcription_unavailable");
    // A failed delivery leaves the helper as it is; the request still runs.
    await this.#beforeTranscribe?.().catch(() => undefined);
    const form = new FormData();
    form.append(
      "file",
      await openAsBlob(wavPath, { type: "audio/wav" }),
      basename(wavPath)
    );
    form.append("response_format", "verbose_json");
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${url}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new PushToTalkTranscriptionError("transcription_busy");
      throw new PushToTalkTranscriptionError(
        "transcription_unavailable",
        error instanceof Error ? error.message : String(error)
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = transcriptSchema.safeParse(body);
      if (!parsed.success)
        throw new PushToTalkTranscriptionError("transcription_failed");
      const { text, fallback } = parsed.data;
      return { text: text.trim(), ...(fallback ? { fallback } : {}) };
    }
    const code = errorSchema.safeParse(body).data?.error.code;
    throw new PushToTalkTranscriptionError(
      code && unavailableCodes.has(code)
        ? "transcription_unavailable"
        : "transcription_failed",
      code ?? `HTTP ${response.status}`
    );
  }
}
