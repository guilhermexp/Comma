import type { LocalBackendProcessRecord } from "./files";

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFile: string;
  /** Postgres uses SIGINT ("fast" shutdown: no confirmed data is lost). */
  stopSignal: NodeJS.Signals;
  stopTimeoutMs: number;
  /** Resolves true once the process serves; polled until readyTimeoutMs. */
  ready?: (() => Promise<boolean>) | undefined;
  readyTimeoutMs?: number | undefined;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChildHandle {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<ChildExit>;
}

export type ChildStatus = "starting" | "running" | "restarting" | "failed" | "stopped";

interface Supervised {
  spec: ChildSpec;
  handle: ChildHandle;
  status: ChildStatus;
  failures: number[];
  restartTimer?: ReturnType<typeof setTimeout> | undefined;
  stopping: boolean;
}

const maxFailures = 5;
const failureWindowMs = 120_000;
const maxBackoffMs = 30_000;
const readyIntervalMs = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeExit(exit: ChildExit) {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
}

/**
 * Supervises the local backend's child processes. A child that stops on its
 * own restarts after 1 s, 2 s, 4 s, … up to 30 s. Five stops within two
 * minutes end its supervision and report the failure.
 */
export class ProcessSupervisor {
  readonly #children = new Map<string, Supervised>();
  readonly #spawn: (spec: ChildSpec) => ChildHandle;
  readonly #onGaveUp: (name: string, reason: string) => void;
  readonly #onStarted: ((name: string, handle: ChildHandle) => void) | undefined;
  readonly #now: () => number;

  constructor(options: {
    spawn: (spec: ChildSpec) => ChildHandle;
    onGaveUp: (name: string, reason: string) => void;
    onStarted?: ((name: string, handle: ChildHandle) => void) | undefined;
    now?: (() => number) | undefined;
  }) {
    this.#spawn = options.spawn;
    this.#onGaveUp = options.onGaveUp;
    this.#onStarted = options.onStarted;
    this.#now = options.now ?? Date.now;
  }

  status(name: string): ChildStatus | undefined {
    return this.#children.get(name)?.status;
  }

  pid(name: string): number | undefined {
    return this.#children.get(name)?.handle.pid;
  }

  /** Starts a child and resolves once it is ready; a failed start stops it again. */
  async start(spec: ChildSpec): Promise<void> {
    const existing = this.#children.get(spec.name);
    if (existing && existing.status !== "stopped" && existing.status !== "failed") {
      throw new Error(`${spec.name} is already supervised.`);
    }
    const child: Supervised = {
      spec,
      handle: this.#spawn(spec),
      status: "starting",
      failures: [],
      stopping: false,
    };
    this.#children.set(spec.name, child);
    const exitedEarly = child.handle.exited.then((exit) => exit);
    try {
      await this.#waitReady(child, exitedEarly);
    } catch (error) {
      child.stopping = true;
      await this.#stop(child);
      throw error;
    }
    child.status = "running";
    this.#watch(child);
    this.#onStarted?.(spec.name, child.handle);
  }

  async #waitReady(child: Supervised, exited: Promise<ChildExit>) {
    const { spec } = child;
    if (!spec.ready) return;
    const timeoutMs = spec.readyTimeoutMs ?? 60_000;
    const deadline = this.#now() + timeoutMs;
    let exit: ChildExit | undefined;
    void exited.then((value) => (exit = value));
    while (this.#now() < deadline) {
      if (exit) {
        throw new Error(
          `${spec.name} stopped before it became ready (${describeExit(exit)}).`
        );
      }
      if (await spec.ready().catch(() => false)) return;
      await sleep(readyIntervalMs);
    }
    throw new Error(
      `${spec.name} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`
    );
  }

  #watch(child: Supervised) {
    const handle = child.handle;
    void handle.exited.then((exit) => {
      if (child.handle !== handle || child.stopping) return;
      const now = this.#now();
      child.failures = [
        ...child.failures.filter((at) => now - at < failureWindowMs),
        now,
      ];
      if (child.failures.length >= maxFailures) {
        child.status = "failed";
        this.#onGaveUp(
          child.spec.name,
          `${child.spec.name} stopped ${maxFailures} times within 2 minutes (${describeExit(exit)})`
        );
        return;
      }
      // The wait grows with the stops of the last two minutes, so a process
      // that ran steadily since its last stop restarts after one second again.
      const delay = Math.min(1_000 * 2 ** (child.failures.length - 1), maxBackoffMs);
      child.status = "restarting";
      child.restartTimer = setTimeout(() => {
        child.restartTimer = undefined;
        if (child.stopping) return;
        child.handle = this.#spawn(child.spec);
        child.status = "running";
        this.#watch(child);
        this.#onStarted?.(child.spec.name, child.handle);
      }, delay);
    });
  }

  async #stop(child: Supervised) {
    if (child.restartTimer) clearTimeout(child.restartTimer);
    child.restartTimer = undefined;
    const { handle, spec } = child;
    let exited = false;
    void handle.exited.then(() => (exited = true));
    await Promise.resolve();
    if (!exited) {
      handle.kill(spec.stopSignal);
      const timedOut = await Promise.race([
        handle.exited.then(() => false),
        sleep(spec.stopTimeoutMs).then(() => true),
      ]);
      if (timedOut) {
        handle.kill("SIGKILL");
        await handle.exited;
      }
    }
    child.status = "stopped";
  }

  /** Stops the named children one after another, then any others. */
  async stopAll(order: string[]) {
    const names = [
      ...order.filter((name) => this.#children.has(name)),
      ...[...this.#children.keys()].filter((name) => !order.includes(name)),
    ];
    for (const child of this.#children.values()) child.stopping = true;
    for (const name of names) {
      await this.#stop(this.#children.get(name)!);
    }
  }
}

/**
 * Stops processes a previous session left behind (for example after a forced
 * quit). A recorded PID is signaled only while it still runs the recorded
 * executable, so a PID the system reused for another program is never touched.
 */
export async function stopOrphans(
  records: Partial<Record<string, LocalBackendProcessRecord>>,
  {
    executableOf,
    isAlive,
    kill,
    timeoutMs = 10_000,
    order = Object.keys(records),
  }: {
    executableOf: (pid: number) => string | undefined;
    isAlive: (pid: number) => boolean;
    kill: (pid: number, signal: NodeJS.Signals) => void;
    timeoutMs?: number;
    order?: string[];
  }
) {
  for (const name of order) {
    const record = records[name];
    if (!record || !isAlive(record.pid)) continue;
    if (executableOf(record.pid) !== record.executable) continue;
    kill(record.pid, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (isAlive(record.pid) && Date.now() < deadline) await sleep(50);
    if (isAlive(record.pid)) kill(record.pid, "SIGKILL");
  }
}
