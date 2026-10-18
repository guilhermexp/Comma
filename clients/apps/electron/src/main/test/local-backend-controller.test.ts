import {
  localBackendStatusSchema,
  type LocalBackendStatus,
} from "@comma/native-bridge";
import { describe, expect, it } from "vitest";
import { LocalBackendController } from "../local-backend/controller";
import type {
  LocalBackendService,
  LocalBackendSnapshot,
} from "../local-backend/service";
import type { SecureSessionInput } from "../secure-store";

const adminToken = "admin-token-only-in-main";
const sessionToken = "owner-session-token-only-in-main";

function noop() {}

function fakeService() {
  let snapshot: LocalBackendSnapshot = {
    phase: "idle",
    logsDir: "/data/logs",
    backupsDir: "/data/backups",
  };
  let onChange: () => void = noop;
  const service = {
    apiBaseUrl: "http://127.0.0.1:54001",
    adminToken,
    ownerUserId: "user-1" as string | undefined,
    snapshot: () => snapshot,
    rememberOwner: () => undefined,
    reportOwnerSessionFailure: (message: string) => {
      snapshot = {
        ...snapshot,
        phase: "failed",
        failure: { code: "owner_session_failed", message },
      };
      onChange();
    },
    start: async () => {
      snapshot = { ...snapshot, phase: "ready" };
      onChange();
      return true;
    },
    retry: async () => true,
    stop: async () => undefined,
    prepare: async () => ({ apiBaseUrl: "http://127.0.0.1:54001" }),
  };
  return {
    service: service as unknown as LocalBackendService,
    follow: (listener: () => void) => (onChange = listener),
  };
}

function backendFetch() {
  let minted = 0;
  return (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/v1/comma/admin/users/user-1/sessions") {
      minted += 1;
      return new Response(JSON.stringify({ token: `${sessionToken}-${minted}` }), {
        status: 201,
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }) as unknown as typeof fetch;
}

describe("local backend controller", () => {
  it("gives the renderer only the startup status, never the admin or Session token", async () => {
    const { service, follow } = fakeService();
    const published: LocalBackendStatus[] = [];
    const adopted: SecureSessionInput[] = [];
    const controller = new LocalBackendController({
      service,
      onStatus: (status) => published.push(status),
      openPath: async () => "",
      fetch: backendFetch(),
    });
    follow(() => controller.publish());
    controller.attachSession(async (input) => {
      adopted.push(input);
      controller.followSessionState({ phase: "signed_in" });
    });

    await controller.launch();
    controller.followSessionState({ phase: "signed_out", reason: "user_signed_out" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adopted.map((input) => input.token)).toEqual([
      `${sessionToken}-1`,
      `${sessionToken}-2`,
    ]);
    expect(published.map((status) => status.phase)).toEqual([
      "signing_in",
      "ready",
      "signing_in",
      "ready",
    ]);
    const visible = JSON.stringify([...published, controller.state()]);
    expect(visible).not.toContain(adminToken);
    expect(visible).not.toContain(sessionToken);
    for (const status of published) {
      expect(() => localBackendStatusSchema.parse(status)).not.toThrow();
    }
    expect(() =>
      localBackendStatusSchema.parse({ ...controller.state(), token: sessionToken })
    ).toThrow();
  });

  it("stops signing the owner in again once the app is quitting", async () => {
    const { service, follow } = fakeService();
    const adopted: SecureSessionInput[] = [];
    const controller = new LocalBackendController({
      service,
      onStatus: () => undefined,
      openPath: async () => "",
      fetch: backendFetch(),
    });
    follow(() => controller.publish());
    controller.attachSession(async (input) => {
      adopted.push(input);
    });
    await controller.launch();

    controller.beginShutdown();
    controller.followSessionState({ phase: "signed_out", reason: "no_session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adopted).toHaveLength(1);
  });

  it("keeps the owner signed in again when the quit is cancelled", async () => {
    const { service, follow } = fakeService();
    const adopted: SecureSessionInput[] = [];
    const controller = new LocalBackendController({
      service,
      onStatus: () => undefined,
      openPath: async () => "",
      fetch: backendFetch(),
    });
    follow(() => controller.publish());
    controller.attachSession(async (input) => {
      adopted.push(input);
    });
    await controller.launch();

    controller.beginShutdown();
    controller.cancelShutdown();
    controller.followSessionState({ phase: "signed_out", reason: "unauthorized" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adopted).toHaveLength(2);
    expect(await controller.retry()).toEqual({ accepted: true });
  });

  it("shows the owner sign-in failure on the startup screen", async () => {
    const { service, follow } = fakeService();
    const published: LocalBackendStatus[] = [];
    const controller = new LocalBackendController({
      service,
      onStatus: (status) => published.push(status),
      openPath: async () => "",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
        })) as unknown as typeof fetch,
    });
    follow(() => controller.publish());
    controller.attachSession(async () => undefined);

    await controller.launch();
    expect(controller.state()).toMatchObject({
      phase: "failed",
      failure: { code: "owner_session_failed" },
    });
    expect(JSON.stringify(published)).not.toContain(adminToken);
  });
});
