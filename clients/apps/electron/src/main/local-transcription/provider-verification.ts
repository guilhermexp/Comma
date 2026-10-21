import type { StoredCloudProvider } from "./provider-store";

/** The outcome of checking a key against its provider (openspec add-cloud-meeting-asr, D7). */
export type ProviderVerification =
  | "valid"
  | "rejected"
  | "unreachable"
  | "server_error"
  | "bad_response"
  | "insecure_url"
  | "invalid_url";

/** The helper's `POST /v1/provider/verify` answer (contract C6). */
export interface HelperVerifyAnswer {
  ok: boolean;
  reason?: string | undefined;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost"]);

/**
 * D7's URL rule: `https:` always, `http:` only for this Mac. The key travels
 * in the Authorization header, so a URL that carries credentials is refused
 * too. The result drops a trailing slash, so `{baseUrl}/models` is exact.
 */
export function checkProviderUrl(
  raw: string
):
  | { ok: true; baseUrl: string }
  | { ok: false; reason: "invalid_url" | "insecure_url" } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  if (!secure) return { ok: false, reason: "insecure_url" };
  url.hash = "";
  url.search = "";
  return { ok: true, baseUrl: url.toString().replace(/\/+$/, "") };
}

/**
 * `GET {baseUrl}/models` with the key as a Bearer: 200 is valid and 401/403
 * rejected. An OpenAI-compatible API without `/models` (404/405) is checked
 * by the helper with a one-second test transcription instead.
 */
export async function verifyProviderKey(
  provider: StoredCloudProvider,
  options: {
    helperVerify: (provider: StoredCloudProvider) => Promise<HelperVerifyAnswer>;
    fetch?: typeof fetch | undefined;
  }
): Promise<ProviderVerification> {
  const checked = checkProviderUrl(provider.baseUrl);
  if (!checked.ok) return checked.reason;
  let status: number;
  try {
    const response = await (options.fetch ?? fetch)(`${checked.baseUrl}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      // A redirect could carry the key to a host the user did not name.
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    return "unreachable";
  }
  if (status >= 200 && status < 300) return "valid";
  if (status === 401 || status === 403) return "rejected";
  // A rate limit answers only an authenticated key.
  if (status === 429) return "valid";
  if (status === 404 || status === 405) {
    try {
      const answer = await options.helperVerify({
        ...provider,
        baseUrl: checked.baseUrl,
      });
      if (answer.ok) return "valid";
      switch (answer.reason) {
        case "cloud_auth_rejected":
          return "rejected";
        case "cloud_unreachable":
          return "unreachable";
        case "cloud_server_error":
          return "server_error";
        default:
          return "bad_response";
      }
    } catch {
      return "unreachable";
    }
  }
  return status >= 500 ? "server_error" : "bad_response";
}
