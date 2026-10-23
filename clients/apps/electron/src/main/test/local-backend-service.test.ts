import {
  chmodSync,
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
  asr: 52009,
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

  resolvePorts: (saved: Partial<Record<string, number>>) => Promise<LocalBackendPorts> =
    async () => ports;

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

  readonly probed: string[] = [];
  async httpOk(url: string) {
    this.probed.push(url);
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

const transcriber = {
  executable:
    "/Applications/Comma.app/Contents/Resources/native/macos/CommaTranscriber",
  modelsDir: "/Users/owner/Library/Application Support/Comma/Models",
};

function service(
  layout: ReturnType<typeof install>,
  runtime: FakeRuntime,
  appVersion = "0.0.3",
  options: {
    transcriber?: typeof transcriber;
    onTranscriberStarted?: () => void;
  } = {}
) {
  const snapshots: LocalBackendSnapshot[] = [];
  const logs: string[] = [];
  const backend = new LocalBackendService({
    layout,
    appVersion,
    runtime,
    ...options,
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

    const events = runtime.events;
    const at = (event: string) => events.indexOf(event);
    expect(events.filter((event) => event === "run initdb")).toHaveLength(1);
    expect(at("run initdb")).toBeLessThan(at("spawn postgres"));
    expect(at("spawn postgres")).toBeLessThan(at("run createdb"));
    expect(at("run comma eval Comma.LocalInstall.run()")).toBeLessThan(
      at("spawn backend")
    );
    for (const name of ["postgres", "redis", "minio"]) {
      expect(at(`spawn ${name}`)).toBeLessThan(
        at("run comma eval Comma.LocalInstall.run()")
      );
    }
    expect(events).not.toContain("run pg_dump");
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

  it("keeps the data folders private even when they already existed", async () => {
    const layout = install();
    for (const dir of ["", "logs", "backups"]) {
      mkdirSync(join(layout.dataDir, dir), { recursive: true, mode: 0o755 });
      chmodSync(join(layout.dataDir, dir), 0o755);
    }
    const { backend } = service(layout, new FakeRuntime());

    await backend.prepare();
    for (const dir of ["", "logs", "backups", "redis", "minio"]) {
      expect(statSync(join(layout.dataDir, dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps a data folder with spaces as one Redis directory", async () => {
    // The real data folder is under "Application Support"; Redis splits an
    // unquoted value on spaces and refuses to start.
    const root = mkdtempSync(join(tmpdir(), "comma local backend "));
    dirs.push(root);
    const layout = {
      dataDir: join(root, "Application Support", "Comma \"local\""),
      resourcesDir: join(root, "Resources", "local-backend"),
    };
    const { backend } = service(layout, new FakeRuntime());

    await backend.prepare();
    const conf = readFileSync(join(layout.dataDir, "redis.conf"), "utf8");
    const dirLine = conf.split("\n").find((line) => line.startsWith("dir "));
    const quoted = dirLine?.slice("dir ".length) ?? "";
    expect(JSON.parse(quoted)).toBe(join(layout.dataDir, "redis"));
  });

  it("reuses the installation on the next launch without initdb or a backup", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    runtime.events.length = 0;

    expect(await backend.start()).toBe(true);
    expect(runtime.events).not.toContain("run initdb");
    expect(runtime.events).not.toContain("run createdb");
    expect(runtime.events).not.toContain("run pg_dump");
    expect(runtime.events).toContain("run comma eval Comma.LocalInstall.run()");
    expect(runtime.events).toContain("spawn backend");
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
    expect(order.indexOf("backend SIGTERM")).toBeLessThan(
      order.indexOf("postgres SIGINT")
    );
    expect(order).not.toContain("postgres SIGKILL");
    for (const child of runtime.children) {
      expect(child.signals.length).toBeGreaterThan(0);
    }
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

  it("chooses new ports on Try again when a chosen port was taken", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    const resolved: Partial<Record<string, number>>[] = [];
    runtime.resolvePorts = async (saved) => {
      resolved.push(saved);
      return { ...ports, postgres: 52101 };
    };

    expect(await backend.retry()).toBe(true);
    expect(resolved).toEqual([ports]);
    const config = readFileSync(join(layout.dataDir, "config.json"), "utf8");
    expect(config).toContain("127.0.0.1:52101/comma");
    expect(readFileSync(join(layout.dataDir, "pgpass"), "utf8")).toContain(":52101:");
    expect(runtime.child("postgres").spec.args).toContain("52101");
    expect(readLocalBackendState(layout.dataDir).ports.postgres).toBe(52101);
    expect(backend.apiBaseUrl).toBe("http://127.0.0.1:52006");
  });

  it("asks to reopen Comma when Try again would move the API port", async () => {
    const layout = install({ appVersion: "0.0.3" });
    const runtime = new FakeRuntime();
    runtime.databaseExists = true;
    const { backend } = service(layout, runtime);
    await backend.prepare();
    runtime.resolvePorts = async () => ({ ...ports, comma: 52106 });

    expect(await backend.retry()).toBe(false);
    expect(backend.snapshot()).toMatchObject({
      phase: "failed",
      failure: { code: "start_failed", message: expect.stringContaining("52006") },
    });
    expect(runtime.children).toEqual([]);
  });

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

  describe("with the local transcription helper", () => {
    it("starts it at utility priority after MinIO and before the backend, with its token in a private file", async () => {
      const layout = install();
      const runtime = new FakeRuntime();
      const { backend, logs } = service(layout, runtime, "0.0.3", { transcriber });

      await backend.prepare();
      expect(await backend.start()).toBe(true);

      const at = (event: string) => runtime.events.indexOf(event);
      expect(at("spawn minio")).toBeLessThan(at("spawn asr"));
      expect(at("spawn asr")).toBeLessThan(at("spawn backend"));
      const tokenFile = join(layout.dataDir, "asr-token");
      const asr = runtime.child("asr").spec;
      expect([asr.command, ...asr.args]).toEqual([
        "/usr/sbin/taskpolicy",
        "-c",
        "utility",
        transcriber.executable,
        "serve",
        "--port",
        "52009",
        "--token-file",
        tokenFile,
        "--models-dir",
        transcriber.modelsDir,
      ]);
      expect(asr.logFile).toBe(join(layout.dataDir, "logs", "asr.log"));
      expect(runtime.probed).toContain("http://127.0.0.1:52009/health");

      const secrets = JSON.parse(
        readFileSync(join(layout.dataDir, "secrets.json"), "utf8")
      );
      expect(readFileSync(tokenFile, "utf8")).toBe(secrets.asrToken);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      for (const child of runtime.children) {
        expect(JSON.stringify([child.spec.args, child.spec.env])).not.toContain(
          secrets.asrToken
        );
      }
      expect(logs.join("\n")).not.toContain(secrets.asrToken);
      const config = JSON.parse(
        readFileSync(join(layout.dataDir, "config.json"), "utf8")
      );
      expect(config.meetings).toEqual({
        asr_template: "local-meeting-asr",
        local_asr: { base_url: "http://127.0.0.1:52009/v1", api_key: secrets.asrToken },
      });
      expect(Object.keys(readLocalBackendState(layout.dataDir).processes)).toContain(
        "asr"
      );
    });

    it("leaves meeting transcription unconfigured when the app has no helper", async () => {
      const layout = install();
      const runtime = new FakeRuntime();
      const { backend } = service(layout, runtime);

      await backend.prepare();
      expect(await backend.start()).toBe(true);
      expect(runtime.events).not.toContain("spawn asr");
      const config = JSON.parse(
        readFileSync(join(layout.dataDir, "config.json"), "utf8")
      );
      expect(config).not.toHaveProperty("meetings");
    });

    it("restarts a stopped helper and stops it after the backend on quit", async () => {
      const layout = install({ appVersion: "0.0.3" });
      const runtime = new FakeRuntime();
      runtime.databaseExists = true;
      // Main delivers the meeting provider to every new helper (add-cloud-meeting-asr, D2).
      const onTranscriberStarted = vi.fn();
      const { backend } = service(layout, runtime, "0.0.3", {
        transcriber,
        onTranscriberStarted,
      });
      await backend.prepare();
      await backend.start();
      expect(onTranscriberStarted).toHaveBeenCalledOnce();
      expect(backend.transcriberToken).toBe(
        readFileSync(join(layout.dataDir, "asr-token"), "utf8")
      );
      vi.useFakeTimers();

      const first = runtime.child("asr");
      first.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      const second = runtime.child("asr");
      expect(second).not.toBe(first);
      expect(onTranscriberStarted).toHaveBeenCalledTimes(2);
      expect(second.spec.command).toBe("/usr/sbin/taskpolicy");
      expect(backend.snapshot().phase).toBe("ready");

      vi.useRealTimers();
      const order: string[] = [];
      for (const child of runtime.children) {
        const kill = child.kill.bind(child);
        child.kill = (signal) => {
          order.push(`${child.spec.name} ${signal}`);
          kill(signal);
        };
      }
      await backend.stop();
      expect(order.indexOf("backend SIGTERM")).toBeLessThan(
        order.indexOf("asr SIGTERM")
      );
      expect(order.indexOf("asr SIGTERM")).toBeLessThan(
        order.indexOf("postgres SIGINT")
      );
      expect(second.signals).toEqual(["SIGTERM"]);
    });

    it("stops a helper a forced quit left behind", async () => {
      const layout = install({ appVersion: "0.0.3" });
      const runtime = new FakeRuntime();
      runtime.databaseExists = true;
      runtime.alive.add(98);
      runtime.executables.set(98, transcriber.executable);
      writeLocalBackendState(layout.dataDir, {
        ...readLocalBackendState(layout.dataDir),
        processes: { asr: { pid: 98, executable: transcriber.executable } },
      });
      const { backend } = service(layout, runtime, "0.0.3", { transcriber });
      await backend.prepare();

      expect(await backend.start()).toBe(true);
      expect(runtime.killed).toEqual([[98, "SIGTERM"]]);
    });
  });
});
