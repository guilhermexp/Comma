import { z } from "zod";
import type { StoredCloudProvider, StoredMeetingProvider } from "./provider-store";
import type { HelperVerifyAnswer } from "./provider-verification";

/** The upload limit Main gives the helper: Groq's free 25 MB less 1 MB of headroom (D4). */
export const cloudMaxUploadBytes = 24_000_000;

// Contract C6: GET /health extends C2 with the provider and the components.
const healthSchema = z.object({
  busy: z.boolean().optional(),
  provider: z
    .object({
      kind: z.enum(["local", "groq", "openai_compatible"]),
      configured: z.boolean(),
    })
    .optional(),
});
export type TranscriberHealth = z.output<typeof healthSchema>;

const verifySchema = z.object({
  ok: z.boolean(),
  reason: z.string().max(100).optional(),
});

/**
 * Main's client of the serving CommaTranscriber's provider routes (contract
 * C6). The key travels only in these loopback request bodies, under the
 * helper's bearer token; never in argv, the environment or a log.
 */
export class TranscriberProviderClient {
  readonly #url: () => string | undefined;
  readonly #token: () => string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: {
    url: () => string | undefined;
    token: () => string | undefined;
    fetch?: typeof fetch | undefined;
  }) {
    this.#url = options.url;
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  /** GET /health; undefined when the helper does not answer. */
  async health(): Promise<TranscriberHealth | undefined> {
    const url = this.#url();
    if (!url) return undefined;
    try {
      const response = await this.#fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return undefined;
      const parsed = healthSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** PUT /v1/provider; true when the helper answered 204. */
  async setProvider(provider: StoredMeetingProvider): Promise<boolean> {
    const response = await this.#request("PUT", "/v1/provider", helperBody(provider));
    await response?.body?.cancel().catch(() => undefined);
    return response?.status === 204;
  }

  /** POST /v1/provider/verify: a one-second test transcription that saves nothing. */
  async verify(provider: StoredCloudProvider): Promise<HelperVerifyAnswer> {
    const response = await this.#request("POST", "/v1/provider/verify", {
      ...helperBody(provider),
    });
    if (!response?.ok)
      throw new Error("The transcription helper did not verify the key.");
    return verifySchema.parse(await response.json());
  }

  async #request(method: string, path: string, body: unknown) {
    const url = this.#url();
    const token = this.#token();
    if (!url || !token) return undefined;
    try {
      return await this.#fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return undefined;
    }
  }
}

function helperBody(provider: StoredMeetingProvider) {
  return provider.kind === "local"
    ? { kind: "local" }
    : { ...provider, maxUploadBytes: cloudMaxUploadBytes };
}
