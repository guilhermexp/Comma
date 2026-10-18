/**
 * Runs the assembled local backend (dist/local-backend, built by
 * `pnpm build:local-backend`) with the real supervisor: an empty data
 * directory, only /usr/bin:/bin on PATH, every listener on 127.0.0.1, and a
 * clean stop. Skipped when the tree has not been built; the desktop release
 * workflow runs it after assembling.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readLocalBackendState } from "../src/main/local-backend/files";
import { mintLocalOwnerSession } from "../src/main/local-backend/owner-session";
import { nodeLocalBackendRuntime } from "../src/main/local-backend/runtime";
import { LocalBackendService } from "../src/main/local-backend/service";

const resourcesDir = resolve(
  process.env.COMMA_LOCAL_BACKEND_DIR ??
    join(import.meta.dirname, "..", "dist", "local-backend")
);
const built =
  process.platform === "darwin" &&
  existsSync(join(resourcesDir, "comma", "bin", "comma"));
// COMMA_LOCAL_BACKEND_TEST_DIR keeps the data and logs for inspection.
const keptRoot = process.env.COMMA_LOCAL_BACKEND_TEST_DIR;
const root = keptRoot ?? mkdtempSync(join(tmpdir(), "comma-local-backend-runtime-"));
const dataDir = join(root, "data");

function listeners(pids: number[]) {
  const output = execFileSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")],
    { encoding: "utf8" }
  );
  return output
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).at(-2)!);
}

function migrationCount(ports: Record<string, number>, password: string) {
  return execFileSync(
    join(resourcesDir, "postgres", "bin", "psql"),
    [
      "-h",
      "127.0.0.1",
      "-p",
      String(ports.postgres),
      "-U",
      "postgres",
      "-d",
      "comma",
      "-Atc",
      "SELECT (SELECT count(*) FROM schema_migrations) + (SELECT count(*) FROM salix_schema_migrations)",
    ],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", PGPASSWORD: password } }
  ).trim();
}

afterAll(() => {
  if (!keptRoot) rmSync(root, { force: true, recursive: true });
});

describe.runIf(built)("assembled local backend", () => {
  const service = (appVersion: string) =>
    new LocalBackendService({
      layout: { dataDir, resourcesDir },
      appVersion,
      runtime: nodeLocalBackendRuntime,
      log: (message) => console.log(message),
    });

  it("starts on an empty data directory, serves only on loopback, and stops cleanly", async () => {
    const backend = service("0.0.3");
    try {
      const { apiBaseUrl } = await backend.prepare();
      const started = await backend.start();
      if (!started) console.error(backend.snapshot().failure);
      expect(started).toBe(true);

      const health = await fetch(`${apiBaseUrl}/health`);
      expect(await health.json()).toEqual({ status: "ok" });

      const state = readLocalBackendState(dataDir);
      const pids = Object.values(state.processes).map((record) => record!.pid);
      expect(pids).toHaveLength(4);
      // Every listener is on loopback and on a port this installation chose:
      // none may share a fixed port such as the development stack's 4200.
      const chosen = new Set(Object.values(state.ports).map(String));
      const bound = listeners(pids);
      expect(bound.length).toBeGreaterThanOrEqual(6);
      for (const address of bound) {
        expect(address).toMatch(/^(127\.0\.0\.1|\[::1\]):\d+$/);
        expect(chosen.has(address.split(":").at(-1)!)).toBe(true);
      }

      const owner = await mintLocalOwnerSession({
        apiBaseUrl,
        adminToken: backend.adminToken,
        rememberOwner: (id) => backend.rememberOwner(id),
      });
      const me = await fetch(`${apiBaseUrl}/v1/comma/auth/session`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${owner.token}`,
          "x-comma-session-transport": "bearer",
        },
      });
      expect(me.status).toBe(200);

      await backend.stop();
      for (const pid of pids) expect(nodeLocalBackendRuntime.isAlive(pid)).toBe(false);
      expect(nodeLocalBackendRuntime.processesUnder(resourcesDir)).toEqual([]);
    } finally {
      await backend.stop();
    }
  }, 600_000);

  it("prepares an existing database again by applying only pending migrations", async () => {
    const first = service("0.0.3");
    const again = service("0.0.4");
    try {
      await first.prepare();
      const secrets = JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8"));
      expect(await first.start()).toBe(true);
      const ports = readLocalBackendState(dataDir).ports as Record<string, number>;
      const before = migrationCount(ports, secrets.postgresPassword);
      await first.stop();
      const preparations = () =>
        readFileSync(join(dataDir, "logs", "prepare.log"), "utf8").split("=== ")
          .length - 1;
      const preparedBefore = preparations();

      await again.prepare();
      expect(await again.start()).toBe(true);
      expect(preparations()).toBe(preparedBefore + 1);
      expect(migrationCount(ports, secrets.postgresPassword)).toBe(before);
      expect(again.snapshot().lastBackupPath).toMatch(/0\.0\.3-to-0\.0\.4\.dump$/);
    } finally {
      await first.stop();
      await again.stop();
    }
  }, 600_000);
});
