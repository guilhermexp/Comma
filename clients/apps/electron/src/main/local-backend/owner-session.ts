import type { SecureSessionInput } from "../secure-store";

/** The single owner of a local installation; no email is ever sent to it. */
export const localOwnerEmail = "owner@local.comma";
const localOwnerName = "Comma";
/** The local environment's `local_dev_session_ttl_seconds` (config/runtime.exs). */
const localSessionTtlSeconds = 10 * 365 * 24 * 60 * 60;

class AdminRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function adminRequest<T>(
  {
    apiBaseUrl,
    adminToken,
    fetch: request,
  }: { apiBaseUrl: string; adminToken: string; fetch: typeof fetch },
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await request(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "unexpected";
    throw new AdminRequestError(
      response.status,
      `${method} ${path.split("?")[0]} returned ${response.status} (${code})`
    );
  }
  return payload as T;
}

async function findOrCreateOwner(input: {
  apiBaseUrl: string;
  adminToken: string;
  fetch: typeof fetch;
}): Promise<string> {
  const page = await adminRequest<{ data?: { id?: string; email?: string }[] }>(
    input,
    "GET",
    `/v1/comma/admin/users?limit=1&email=${encodeURIComponent(localOwnerEmail)}`
  );
  const existing = page.data?.find(
    (user) => user.email?.toLowerCase() === localOwnerEmail
  );
  if (existing?.id) return existing.id;
  const created = await adminRequest<{ id?: string }>(
    input,
    "POST",
    "/v1/comma/admin/users",
    {
      email: localOwnerEmail,
      name: localOwnerName,
    }
  );
  if (!created.id) throw new Error("POST /v1/comma/admin/users returned no user id");
  return created.id;
}

/**
 * Opens a full local Session for the installation's owner through the admin
 * API that only loopback callers may use. The first launch creates the owner;
 * later launches reuse the id kept in state.json. The Session's placeholder
 * identity is replaced by the server's when Main reconciles it.
 */
export async function mintLocalOwnerSession({
  apiBaseUrl,
  adminToken,
  ownerUserId,
  rememberOwner,
  fetch: request = fetch,
}: {
  apiBaseUrl: string;
  adminToken: string;
  ownerUserId?: string | undefined;
  rememberOwner: (userId: string) => void;
  fetch?: typeof fetch | undefined;
}): Promise<SecureSessionInput> {
  const client = { apiBaseUrl, adminToken, fetch: request };
  const openSession = (userId: string) =>
    adminRequest<{ token?: string }>(
      client,
      "POST",
      `/v1/comma/admin/users/${encodeURIComponent(userId)}/sessions`,
      { local_dev: true, ttl_seconds: localSessionTtlSeconds }
    );

  let userId = ownerUserId;
  let session: { token?: string } | undefined;
  if (userId) {
    try {
      session = await openSession(userId);
    } catch (error) {
      if (!(error instanceof AdminRequestError && error.status === 404)) throw error;
      userId = undefined;
    }
  }
  if (!userId || !session) {
    userId = await findOrCreateOwner(client);
    rememberOwner(userId);
    session = await openSession(userId);
  }
  if (!session.token) throw new Error("The local owner Session has no token");
  return {
    audience: apiBaseUrl,
    email: localOwnerEmail,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + localSessionTtlSeconds,
    sessionId: `local-owner-session:${userId}`,
    token: session.token,
    userId: `local-owner:${userId}`,
  };
}

/**
 * Keeps the owner signed in. Whenever the Session ends — the backend rejected
 * it or the person chose Sign out — a new one is minted and adopted, so the
 * login screen never appears in local mode.
 */
export class LocalOwnerSessionKeeper {
  readonly #mint: () => Promise<SecureSessionInput>;
  readonly #adopt: (input: SecureSessionInput) => Promise<void>;
  readonly #onFailure: (message: string) => void;
  #pending: Promise<void> | undefined;

  constructor(options: {
    mint: () => Promise<SecureSessionInput>;
    adopt: (input: SecureSessionInput) => Promise<void>;
    onFailure: (message: string) => void;
  }) {
    this.#mint = options.mint;
    this.#adopt = options.adopt;
    this.#onFailure = options.onFailure;
  }

  ensure(): Promise<void> {
    this.#pending ??= (async () => {
      try {
        await this.#adopt(await this.#mint());
      } catch (error) {
        this.#onFailure(error instanceof Error ? error.message : String(error));
      } finally {
        this.#pending = undefined;
      }
    })();
    return this.#pending;
  }

  followSessionState(state: { phase: string; reason?: string }): Promise<void> {
    if (state.phase !== "signed_out") return Promise.resolve();
    return this.ensure();
  }
}
