import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessSupervisor,
  stopOrphans,
  type ChildHandle,
  type ChildSpec,
} from "../local-backend/supervisor";

class FakeChild implements ChildHandle {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #resolve!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  #ignores: Set<NodeJS.Signals>;

  constructor(ignores: NodeJS.Signals[] = []) {
    this.#ignores = new Set(ignores);
    this.exited = new Promise((resolve) => (this.#resolve = resolve));
  }

  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (!this.#ignores.has(signal)) this.#resolve({ code: null, signal });
  }

  crash(code = 1) {
    this.#resolve({ code, signal: null });
  }
}

function spec(name: string, overrides: Partial<ChildSpec> = {}): ChildSpec {
  return {
    name,
    command: `/App/${name}`,
    args: [],
    env: {},
    cwd: "/data",
    logFile: `/data/logs/${name}.log`,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 5_000,
    ...overrides,
  };
}

function harness(ignores: Record<string, NodeJS.Signals[]> = {}) {
  const spawned: Record<string, FakeChild[]> = {};
  const failures: { name: string; reason: string }[] = [];
  const supervisor = new ProcessSupervisor({
    spawn: (child) => {
      const fake = new FakeChild(ignores[child.name]);
      (spawned[child.name] ??= []).push(fake);
      return fake;
    },
    onGaveUp: (name, reason) => failures.push({ name, reason }),
  });
  const latest = (name: string) => spawned[name]!.at(-1)!;
  return { failures, latest, spawned, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("local backend process supervisor", () => {
  it("restarts a crashed process with a growing wait", async () => {
    const { latest, spawned, supervisor } = harness();
    await supervisor.start(spec("redis"));

    latest("redis").crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(spawned.redis).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned.redis).toHaveLength(2);

    latest("redis").crash();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(spawned.redis).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned.redis).toHaveLength(3);
    expect(supervisor.status("redis")).toBe("running");
  });

  it("gives up after five failures within two minutes", async () => {
    const { failures, latest, spawned, supervisor } = harness();
    await supervisor.start(spec("minio"));

    for (const wait of [1_000, 2_000, 4_000, 8_000]) {
      latest("minio").crash();
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(spawned.minio).toHaveLength(5);
    latest("minio").crash(3);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawned.minio).toHaveLength(5);
    expect(supervisor.status("minio")).toBe("failed");
    expect(failures).toEqual([
      { name: "minio", reason: "minio stopped 5 times within 2 minutes (exit code 3)" },
    ]);
  });

  it("keeps restarting failures that are spread over more than two minutes", async () => {
    const { failures, latest, spawned, supervisor } = harness();
    await supervisor.start(spec("redis"));

    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      latest("redis").crash();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(failures).toEqual([]);
    expect(spawned.redis).toHaveLength(7);
  });

  it("restarts after one second again once a process has run for two minutes", async () => {
    const { latest, spawned, supervisor } = harness();
    await supervisor.start(spec("redis"));

    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(180_000);
      const before = spawned.redis!.length;
      latest("redis").crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawned.redis).toHaveLength(before + 1);
    }
  });

  it("stops in order, uses each stop signal, and kills a process that ignores it", async () => {
    const { latest, supervisor } = harness({ backend: ["SIGTERM"] });
    await supervisor.start(spec("postgres", { stopSignal: "SIGINT" }));
    await supervisor.start(spec("backend"));

    const stopping = supervisor.stopAll(["backend", "postgres"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest("backend").signals).toEqual(["SIGTERM"]);
    expect(latest("postgres").signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(latest("backend").signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(latest("postgres").signals).toEqual(["SIGINT"]);
    expect(supervisor.status("backend")).toBe("stopped");
  });

  it("does not restart a process that stopped because the app is quitting", async () => {
    const { spawned, supervisor } = harness();
    await supervisor.start(spec("redis"));
    await supervisor.stopAll(["redis"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned.redis).toHaveLength(1);
  });

  it("reports a process that never becomes ready as a failed start", async () => {
    const { latest, supervisor } = harness();
    const starting = supervisor.start(
      spec("backend", { ready: async () => false, readyTimeoutMs: 3_000 })
    );
    const outcome = expect(starting).rejects.toThrow(
      "backend did not become ready within 3 seconds"
    );
    await vi.advanceTimersByTimeAsync(3_500);
    await outcome;
    expect(latest("backend").signals).toContain("SIGTERM");
  });
});

describe("orphans of a previous session", () => {
  it("signals a recorded process only while its executable is still the recorded one", async () => {
    vi.useRealTimers();
    const alive = new Set([10, 11]);
    const signals: [number, NodeJS.Signals][] = [];
    await stopOrphans(
      {
        postgres: { pid: 10, executable: "/App/local-backend/postgres/bin/postgres" },
        redis: { pid: 11, executable: "/App/local-backend/redis/bin/redis-server" },
        minio: { pid: 12, executable: "/App/local-backend/minio/minio" },
      },
      {
        executableOf: (pid) =>
          pid === 10
            ? "/App/local-backend/postgres/bin/postgres"
            : pid === 11
              ? "/Applications/Other.app/Contents/MacOS/Other"
              : undefined,
        isAlive: (pid) => alive.has(pid),
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          alive.delete(pid);
        },
        timeoutMs: 1_000,
      }
    );
    expect(signals).toEqual([[10, "SIGTERM"]]);
  });

  it("kills an orphan that does not exit after the polite signal", async () => {
    vi.useRealTimers();
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    await stopOrphans(
      { backend: { pid: 20, executable: "/App/beam.smp" } },
      {
        executableOf: () => "/App/beam.smp",
        isAlive: () => alive,
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") alive = false;
        },
        timeoutMs: 200,
      }
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
