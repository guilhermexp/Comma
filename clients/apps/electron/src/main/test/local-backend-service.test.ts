import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLocalBackendState, writeLocalBackendState } from "../local-backend/files";
import type { LocalBackendPorts } from "../local-backend/ports";
import {
  LocalBackendService,
  type LocalBackendRuntime,
  type LocalBackendSnapshot,
  type RunOptions,
} from "../local-backend/service";
import type { ChildExit, ChildHandle, ChildSpec } from "../local-backend/supervisor";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const ports: LocalBackendPorts = {
  postgres: 52001,
  redis: 52002,
  minio: 52003,
  minioConsole: 52004,
  salix: 52005,
  comma: 52006,
  transfer: 52007,
  metrics: 52008,
};

class FakeChild implements ChildHandle {
  static nextPid = 4000;
  readonly pid = FakeChild.nextPid++;
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<ChildExit>;
  #resolve!: (exit: ChildExit) => void;
  constructor(readonly spec: ChildSpec) {
    this.exited = new Promise((resolve) => (this.#resolve = resolve));
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.#resolve({ code: null, signal });
  }
  crash() {
    this.#resolve({ code: 1, signal: null });
  }
}

class FakeRuntime implements LocalBackendRuntime {
  readonly events: string[] = [];
  readonly children: FakeChild[] = [];
  readonly killed: [number, NodeJS.Signals][] = [];
  readonly alive = new Set<number>();
  readonly executables = new Map<number, string>();
  failOn: string | undefined;
  databaseExists = false;
  /** Helpers the backend left behind, keyed by PID, with their executables. */
  readonly strays = new Map<number, string>();

  resolvePorts = async () => ports;

  spawn(spec: ChildSpec) {
    const child = new FakeChild(spec);
    this.children.push(child);
    this.executables.set(child.pid, spec.command);
    this.events.push(`spawn ${spec.name}`);
    return child;
  }

  async run(command: string, args: string[], options: RunOptions) {
    const name = basename(command);
    const label =
      name === "comma" ? `${name} ${args.join(" ")}` : name === "psql" ? "psql" : name;
    if (label === "psql" && args.includes("SELECT 1")) return;
    this.events.push(`run ${label}`);
    if (this.failOn && label.startsWith(this.failOn)) {
      throw new Error(`${label} exited with status 1. Log: ${options.logFile}`);
    }
    if (name === "initdb") {
      const data = args[args.indexOf("-D") + 1]!;
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "PG_VERSION"), "16");
    }
    if (name === "psql" && !this.databaseExists) {
      throw new Error("database comma does not exist");
    }
    if (name === "createdb") this.databaseExists = true;
    if (name === "pg_dump") {
      const file = args
        .find((arg) => arg.startsWith("--file="))!
        .slice("--file=".length);
      writeFileSync(file, "dump");
    }
  }

  async httpOk() {
    return true;
  }
  async redisPing() {
    return true;
  }
  executableOf(pid: number) {
    return this.executables.get(pid);
  }
  isAlive(pid: number) {
    return this.alive.has(pid);
  }
  kill(pid: number, signal: NodeJS.Signals) {
    this.killed.push([pid, signal]);
    this.alive.delete(pid);
    if (signal === "SIGKILL") this.strays.delete(pid);
  }
  processesUnder(dir: string) {
    return [...this.strays]
      .filter(([, path]) => path.startsWith(dir))
      .map(([pid]) => pid);
  }
  child(name: string) {
    return this.children.filter((child) => child.spec.name === name).at(-1)!;
  }
}

function install(previous?: { appVersion: string }) {
  const root = mkdtempSync(join(tmpdir(), "comma-local-backend-service-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  if (previous) {
    mkdirSync(join(dataDir, "postgres"), { recursive: true });
    writeFileSync(join(dataDir, "postgres", "PG_VERSION"), "16");
    writeLocalBackendState(dataDir, {
      version: 1,
      appVersion: previous.appVersion,
      ports: {},
      processes: {},
    });
  }
  return { dataDir, resourcesDir: join(root, "Resources", "local-backend") };
}

function service(
  layout: ReturnType<typeof install>,
  runtime: FakeRuntime,
  appVersion = "0.0.3"
) {
  const snapshots: LocalBackendSnapshot[] = [];
  const logs: string[] = [];
  const backend = new LocalBackendService({
    layout,
    appVersion,
    runtime,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    log: (message) => logs.push(message),
  });
  return { backend, logs, snapshots };
}

describe("local backend service", () => {
  it("initializes a first launch, prepares the database, and serves on loopback", async () => {
    const layout = install();
    const runtime = new FakeRuntime();
    const { backend, logs, snapshots } = service(layout, runtime);

    expect(await backend.prepare()).toEqual({ apiBaseUrl: "http://127.0.0.1:52006" });
    expect(await backend.start()).toBe(true);

    expect(runtime.events).toEqual([
      "run initdb",
      "spawn postgres",
      "run psql",
      "run createdb",
      "spawn redis",
      "spawn minio",
      "run comma eval Comma.LocalInstall.run()",
      "spawn backend",
    ]);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "starting",
      "preparing",
      "ready",
    ]);
    const state = readLocalBackendState(layout.dataDir);
    expect(state.appVersion).toBe("0.0.3");
    expect(Object.keys(state.processes).toSorted()).toEqual([
      "backend",
      "minio",
      "postgres",
      "redis",
    ]);
    for (const file of [
      "secrets.json",
      "config.json",
      "redis.conf",
      "minio.env",
      "pgpass",
    ]) {
      expect(statSync(join(layout.dataDir, file)).mode & 0o777).toBe(0o600);
    }
    const secrets = JSON.parse(
      readFileSync(join(layout.dataDir, "secrets.json"), "utf8")
    );
    expect(logs.join("\n")).not.toContain(secrets.adminToken);
    const backendChild = runtime.child("backend");
    expect(backendChild.spec.env).toMatchObject({
      COMMA_ENVIRONMENT: "local",
      COMMA_DESKTOP_LOCAL: "1",
      COMMA_LISTEN_IP: "127.0.0.1",
      RELEASE_DISTRIBUTION: "none",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    expect(JSON.stringify(backendChild.spec.env)).not.toContain(secrets.adminToken);
    expect(JSON.stringify(backendChild.spec.args)).not.toContain(secrets.adminToken);
  });

  it("reuses the installation on the next launch without initdb or a backup", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    runtime.events.length = 0;

    expect(await backend.start()).toBe(true);
    expect(runtime.events).toEqual([
      "spawn postgres",
      "run psql",
      "spawn redis",
      "spawn minio",
      "run comma eval Comma.LocalInstall.run()",
      "spawn backend",
    ]);
  });

  it("backs up the database before a new app version migrates it", async () => {
    const layout = install({ appVersion: "0.0.2" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime, "0.0.3");
    await backend.prepare();
    runtime.events.length = 0;

    expect(await backend.start()).toBe(true);
    expect(runtime.events.indexOf("run pg_dump")).toBeLessThan(
      runtime.events.indexOf("run comma eval Comma.LocalInstall.run()")
    );
    expect(backend.snapshot().lastBackupPath).toMatch(
      /backups\/comma-\d{8}T\d{6}Z-0\.0\.2-to-0\.0\.3\.dump$/
    );
  });

  it("stops without opening the backend when a migration fails and points to the backup", async () => {
    const layout = install({ appVersion: "0.0.2" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    runtime.failOn = "comma eval";
    const { backend } = service(layout, runtime, "0.0.3");
    await backend.prepare();

    expect(await backend.start()).toBe(false);
    const snapshot = backend.snapshot();
    expect(snapshot.phase).toBe("failed");
    expect(snapshot.failure?.code).toBe("migration_failed");
    expect(snapshot.lastBackupPath).toMatch(/0\.0\.2-to-0\.0\.3\.dump$/);
    expect(runtime.events).not.toContain("spawn backend");
    for (const name of ["postgres", "redis", "minio"]) {
      expect(runtime.child(name).signals.length).toBeGreaterThan(0);
    }
    expect(readLocalBackendState(layout.dataDir).appVersion).toBe("0.0.2");
  });

  it("stops processes left by a forced quit before starting new ones", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const leftover = {
      pid: 99,
      executable: join(layout.resourcesDir, "postgres/bin/postgres"),
    };
    runtime.alive.add(99);
    runtime.executables.set(99, leftover.executable);
    writeLocalBackendState(layout.dataDir, {
      ...readLocalBackendState(layout.dataDir),
      processes: { postgres: leftover },
    });
    const { backend } = service(layout, runtime);
    await backend.prepare();

    expect(await backend.start()).toBe(true);
    expect(runtime.killed).toEqual([[99, "SIGTERM"]]);
  });

  it("quits by stopping the backend first and Postgres with a fast shutdown", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    await backend.start();
    const order: string[] = [];
    for (const child of runtime.children) {
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        order.push(`${child.spec.name} ${signal}`);
        kill(signal);
      };
    }

    await backend.stop();
    expect(order).toEqual([
      "backend SIGTERM",
      "postgres SIGINT",
      "redis SIGTERM",
      "minio SIGTERM",
    ]);
    expect(backend.snapshot().phase).toBe("stopped");
    expect(readLocalBackendState(layout.dataDir).processes).toEqual({});
  });

  it("leaves no helper process of the backend running after quitting", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    await backend.start();
    runtime.strays.set(
      7001,
      join(layout.resourcesDir, "comma/lib/salix_agent-0.1.0/priv/spinfoam")
    );
    runtime.strays.set(7002, "/Applications/Other.app/Contents/MacOS/Other");

    await backend.stop();
    expect(runtime.killed).toContainEqual([7001, "SIGKILL"]);
    expect(runtime.killed.map(([pid]) => pid)).not.toContain(7002);
  }, 10_000);

  it("reports the failure when a process keeps stopping", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    await backend.start();
    vi.useFakeTimers();

    for (const wait of [1_000, 2_000, 4_000, 8_000, 0]) {
      runtime.child("redis").crash();
      await vi.advanceTimersByTimeAsync(wait);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.snapshot()).toMatchObject({
      phase: "failed",
      failure: { code: "process_stopped" },
    });
  });
});
