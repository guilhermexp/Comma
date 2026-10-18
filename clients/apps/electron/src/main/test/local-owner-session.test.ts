import { describe, expect, it } from "vitest";
import {
  LocalOwnerSessionKeeper,
  localOwnerEmail,
  mintLocalOwnerSession,
} from "../local-backend/owner-session";

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}

function backend(routes: Record<string, (call: Call) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init.headers).get("authorization"),
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    const [status, body] = route ? route(call) : [404, { error: "not_found" }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const apiBaseUrl = "http://127.0.0.1:53001";
const adminToken = "admin-token-from-secrets";

describe("local owner session", () => {
  it("creates the owner on the first launch, remembers it, and opens a full local Session", async () => {
    const remembered: string[] = [];
    const server = backend({
      "GET /v1/comma/admin/users": () => [200, { data: [] }],
      "POST /v1/comma/admin/users": () => [
        201,
        { id: "user-1", email: localOwnerEmail },
      ],
      "POST /v1/comma/admin/users/user-1/sessions": () => [
        201,
        { token: "session-token-1" },
      ],
    });

    const session = await mintLocalOwnerSession({
      apiBaseUrl,
      adminToken,
      fetch: server.fetch,
      rememberOwner: (id) => remembered.push(id),
    });

    expect(session).toMatchObject({
      audience: apiBaseUrl,
      email: localOwnerEmail,
      token: "session-token-1",
      userId: "local-owner:user-1",
    });
    expect(remembered).toEqual(["user-1"]);
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /v1/comma/admin/users?limit=1&email=${encodeURIComponent(localOwnerEmail)}`,
      "POST /v1/comma/admin/users",
      "POST /v1/comma/admin/users/user-1/sessions",
    ]);
    expect(
      server.calls.every((call) => call.authorization === `Bearer ${adminToken}`)
    ).toBe(true);
    expect(server.calls[2]!.body).toEqual({
      local_dev: true,
      ttl_seconds: 315_360_000,
    });
  });

  it("reuses the remembered owner on later launches", async () => {
    const server = backend({
      "POST /v1/comma/admin/users/user-1/sessions": () => [
        201,
        { token: "session-token-2" },
      ],
    });

    const session = await mintLocalOwnerSession({
      apiBaseUrl,
      adminToken,
      fetch: server.fetch,
      ownerUserId: "user-1",
      rememberOwner: () => undefined,
    });

    expect(session.token).toBe("session-token-2");
    expect(server.calls).toHaveLength(1);
  });

  it("finds the owner again when the remembered id no longer exists", async () => {
    const remembered: string[] = [];
    const server = backend({
      "POST /v1/comma/admin/users/stale/sessions": () => [404, { error: "not_found" }],
      "GET /v1/comma/admin/users": () => [
        200,
        { data: [{ id: "user-7", email: localOwnerEmail }] },
      ],
      "POST /v1/comma/admin/users/user-7/sessions": () => [
        201,
        { token: "session-token-7" },
      ],
    });

    const session = await mintLocalOwnerSession({
      apiBaseUrl,
      adminToken,
      fetch: server.fetch,
      ownerUserId: "stale",
      rememberOwner: (id) => remembered.push(id),
    });

    expect(session.token).toBe("session-token-7");
    expect(remembered).toEqual(["user-7"]);
  });

  it("reports a refused request without the admin token", async () => {
    const server = backend({
      "POST /v1/comma/admin/users/user-1/sessions": () => [403, { error: "forbidden" }],
    });

    const failure = mintLocalOwnerSession({
      apiBaseUrl,
      adminToken,
      fetch: server.fetch,
      ownerUserId: "user-1",
      rememberOwner: () => undefined,
    });
    await expect(failure).rejects.toThrow(
      "POST /v1/comma/admin/users/user-1/sessions returned 403 (forbidden)"
    );
    await failure.catch((error: Error) =>
      expect(error.message).not.toContain(adminToken)
    );
  });
});

describe("local owner session keeper", () => {
  function keeper() {
    const adopted: string[] = [];
    let minted = 0;
    const failures: string[] = [];
    const sessionKeeper = new LocalOwnerSessionKeeper({
      mint: async () => {
        minted += 1;
        return {
          audience: apiBaseUrl,
          email: localOwnerEmail,
          expiresAtEpochSeconds: 4_102_444_800,
          sessionId: `local-owner-session:${minted}`,
          token: `token-${minted}`,
          userId: "local-owner:user-1",
        };
      },
      adopt: async (input) => {
        adopted.push(input.token);
      },
      onFailure: (message) => failures.push(message),
    });
    return { adopted, failures, sessionKeeper };
  }

  it("signs the owner in again when the backend rejects the stored Session", async () => {
    const { adopted, sessionKeeper } = keeper();
    await sessionKeeper.ensure();

    await sessionKeeper.followSessionState({
      phase: "signed_out",
      reason: "unauthorized",
    });
    expect(adopted).toEqual(["token-1", "token-2"]);
  });

  it("signs the owner in again after Sign out instead of showing the login screen", async () => {
    const { adopted, sessionKeeper } = keeper();
    await sessionKeeper.ensure();

    await sessionKeeper.followSessionState({
      phase: "signed_out",
      reason: "user_signed_out",
    });
    expect(adopted).toEqual(["token-1", "token-2"]);
  });

  it("creates one Session when several sign-outs arrive together", async () => {
    const { adopted, sessionKeeper } = keeper();
    await Promise.all([
      sessionKeeper.followSessionState({ phase: "signed_out", reason: "no_session" }),
      sessionKeeper.followSessionState({ phase: "signed_out", reason: "no_session" }),
    ]);
    expect(adopted).toEqual(["token-1"]);
  });

  it("does nothing while signed in and reports a failed sign-in", async () => {
    const failures: string[] = [];
    const sessionKeeper = new LocalOwnerSessionKeeper({
      mint: async () => {
        throw new Error("POST /v1/comma/admin/users returned 500 (internal)");
      },
      adopt: async () => undefined,
      onFailure: (message) => failures.push(message),
    });
    await sessionKeeper.followSessionState({ phase: "signed_in" });
    expect(failures).toEqual([]);
    await sessionKeeper.followSessionState({
      phase: "signed_out",
      reason: "unauthorized",
    });
    expect(failures).toEqual(["POST /v1/comma/admin/users returned 500 (internal)"]);
  });
});
