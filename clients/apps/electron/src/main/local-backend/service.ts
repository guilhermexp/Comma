import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupBeforeUpgrade } from "./backup";
import {
  buildBackendConfig,
  localBackendDatabase,
  loopbackHost,
  redactSecrets,
  redisUrl,
} from "./config";
import {
  ensureLocalBackendSecrets,
  readLocalBackendState,
  writeLocalBackendState,
  writePrivateFile,
  type LocalBackendSecrets,
  type LocalBackendState,
} from "./files";
import { localBackendPaths, type LocalBackendLayout } from "./layout";
import { resolveLocalBackendPorts, type LocalBackendPorts } from "./ports";
import {
  ProcessSupervisor,
  stopOrphans,
  type ChildHandle,
  type ChildSpec,
} from "./supervisor";

export type LocalBackendPhase =
  | "idle"
  | "starting"
  | "preparing"
  | "ready"
  | "failed"
  | "stopping"
  | "stopped";

export type LocalBackendFailureCode =
  | "start_failed"
  | "backup_failed"
  | "migration_failed"
  | "process_stopped"
  | "owner_session_failed";

export interface LocalBackendSnapshot {
  phase: LocalBackendPhase;
  failure?: { code: LocalBackendFailureCode; message: string } | undefined;
  logsDir: string;
  backupsDir: string;
  lastBackupPath?: string | undefined;
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFile: string;
  timeoutMs: number;
}

/** The operating-system side effects of the service; tests replace them with fakes. */
export interface LocalBackendRuntime {
  spawn(spec: ChildSpec): ChildHandle;
  /** Runs a command to completion; rejects with a summary on a non-zero exit. */
  run(command: string, args: string[], options: RunOptions): Promise<void>;
  httpOk(url: string): Promise<boolean>;
  redisPing(port: number, password: string): Promise<boolean>;
  executableOf(pid: number): string | undefined;
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** This user's processes whose executable lies under dir (the bundled programs). */
  processesUnder(dir: string): number[];
  resolvePorts?:
    | ((saved: Partial<Record<string, number>>) => Promise<LocalBackendPorts>)
    | undefined;
}

/**
 * Stop order on quit: the backend first, then the transcription helper,
 * Postgres ("fast"), Redis and MinIO.
 */
const stopOrder = ["backend", "asr", "postgres", "redis", "minio"];
const orphanOrder = ["backend", "asr", "minio", "redis", "postgres"];

/** The bundled CommaTranscriber and the models folder it serves from (contract C1/C4). */
export interface LocalTranscriber {
  executable: string;
  modelsDir: string;
}

class StepError extends Error {
  constructor(
    readonly code: LocalBackendFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/**
 * Starts, supervises and stops the local backend of the macOS app: Postgres,
 * Redis, MinIO and the `comma` release, all bound to 127.0.0.1 with this
 * installation's secrets (openspec desktop-local-backend).
 */
export class LocalBackendService {
  readonly #layout: LocalBackendLayout;
  readonly #paths: ReturnType<typeof localBackendPaths>;
  readonly #appVersion: string;
  readonly #runtime: LocalBackendRuntime;
  readonly #onSnapshot: (snapshot: LocalBackendSnapshot) => void;
  readonly #log: (message: string) => void;
  readonly #transcriber: LocalTranscriber | undefined;
  #snapshot: LocalBackendSnapshot;
  #secrets: LocalBackendSecrets | undefined;
  #ports: LocalBackendPorts | undefined;
  #state: LocalBackendState | undefined;
  #supervisor: ProcessSupervisor | undefined;
  #starting: Promise<boolean> | undefined;

  constructor(options: {
    layout: LocalBackendLayout;
    appVersion: string;
    runtime: LocalBackendRuntime;
    onSnapshot?: ((snapshot: LocalBackendSnapshot) => void) | undefined;
    log?: ((message: string) => void) | undefined;
    /** Absent when the app has no helper: meeting ASR then stays unconfigured. */
    transcriber?: LocalTranscriber | undefined;
  }) {
    this.#layout = options.layout;
    this.#paths = localBackendPaths(options.layout);
    this.#appVersion = options.appVersion;
    this.#runtime = options.runtime;
    this.#onSnapshot = options.onSnapshot ?? (() => undefined);
    this.#log = options.log ?? (() => undefined);
    this.#transcriber = options.transcriber;
    this.#snapshot = {
      phase: "idle",
      logsDir: this.#paths.logsDir,
      backupsDir: this.#paths.backupsDir,
    };
  }

  snapshot(): LocalBackendSnapshot {
    return this.#snapshot;
  }

  get apiBaseUrl(): string {
    if (!this.#ports) throw new Error("The local backend is not prepared.");
    return `http://${loopbackHost}:${this.#ports.comma}`;
  }

  /** Main-only: the per-installation admin token that mints the owner's Session. */
  get adminToken(): string {
    if (!this.#secrets) throw new Error("The local backend is not prepared.");
    return this.#secrets.adminToken;
  }

  /** The serving transcription helper's loopback URL, when the app bundles one. */
  get transcriberUrl(): string | undefined {
    if (!this.#transcriber || !this.#ports) return undefined;
    return `http://${loopbackHost}:${this.#ports.asr}`;
  }

  get ownerUserId(): string | undefined {
    return this.#state?.ownerUserId;
  }

  rememberOwner(userId: string) {
    const state = this.#requireState();
    state.ownerUserId = userId;
    writeLocalBackendState(this.#layout.dataDir, state);
  }

  /**
   * Creates the data directories and secrets, chooses the ports, and writes
   * every configuration file. Fast and offline: Main calls it before it
   * creates windows, so the API base URL is known up front.
   */
  async prepare(): Promise<{ apiBaseUrl: string }> {
    const { dataDir } = this.#layout;
    for (const dir of [
      dataDir,
      this.#paths.logsDir,
      this.#paths.backupsDir,
      this.#paths.redisData,
      this.#paths.minioData,
      this.#paths.minioCerts,
      this.#paths.releaseTmp,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode applies only to a folder it creates.
      chmodSync(dir, 0o700);
    }
    this.#secrets = ensureLocalBackendSecrets(dataDir);
    this.#state = readLocalBackendState(dataDir);
    this.#ports = await (this.#runtime.resolvePorts ?? resolveLocalBackendPorts)(
      this.#state.ports
    );
    this.#state.ports = { ...this.#ports };
    writeLocalBackendState(dataDir, this.#state);
    this.#writeConfigFiles(this.#secrets, this.#ports);
    this.#log(
      `local backend prepared in ${dataDir}: ${JSON.stringify(
        redactSecrets({ ports: this.#ports }, this.#secrets)
      )}`
    );
    return { apiBaseUrl: this.apiBaseUrl };
  }

  #writeConfigFiles(secrets: LocalBackendSecrets, ports: LocalBackendPorts) {
    const config = buildBackendConfig({
      secrets,
      ports,
      logsDir: this.#paths.logsDir,
      localAsr: this.#transcriber
        ? { port: ports.asr, token: secrets.asrToken }
        : undefined,
    });
    writePrivateFile(this.#paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
    // The helper reads its bearer from this file, never from argv or env.
    if (this.#transcriber) writePrivateFile(this.#paths.asrTokenFile, secrets.asrToken);
    writePrivateFile(
      this.#paths.redisConf,
      [
        `bind ${loopbackHost}`,
        `port ${ports.redis}`,
        "protected-mode yes",
        `requirepass ${secrets.redisPassword}`,
        `dir ${this.#paths.redisData}`,
        "appendonly yes",
        'save ""',
        "daemonize no",
        "set-proc-title no",
        "",
      ].join("\n")
    );
    writePrivateFile(
      this.#paths.minioEnv,
      [
        `MINIO_ROOT_USER=${secrets.storageAccessKey}`,
        `MINIO_ROOT_PASSWORD=${secrets.storageSecretKey}`,
        "",
      ].join("\n")
    );
    writePrivateFile(
      this.#paths.pgpass,
      `${loopbackHost}:${ports.postgres}:*:postgres:${secrets.postgresPassword}\n`
    );
  }

  /** Starts every process; resolves true once the backend serves. Never rejects. */
  start(): Promise<boolean> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<boolean> {
    const secrets = this.#secrets;
    const ports = this.#ports;
    if (!secrets || !ports) throw new Error("prepare() must run before start().");
    this.#publish({ phase: "starting", failure: undefined });
    try {
      await stopOrphans(this.#requireState().processes, {
        executableOf: (pid) => this.#runtime.executableOf(pid),
        isAlive: (pid) => this.#runtime.isAlive(pid),
        kill: (pid, signal) => this.#runtime.kill(pid, signal),
        order: orphanOrder,
      });
      await this.#sweepBundledProcesses();
      this.#recordProcesses({});
      this.#supervisor = this.#createSupervisor();

      await this.#startPostgres(secrets, ports);
      await this.#step("start_failed", () =>
        this.#supervisor!.start(this.#redisSpec(secrets, ports))
      );
      await this.#step("start_failed", () =>
        this.#supervisor!.start(this.#minioSpec(ports))
      );
      if (this.#transcriber) {
        const transcriber = this.#transcriber;
        await this.#step("start_failed", () =>
          this.#supervisor!.start(this.#asrSpec(transcriber, ports))
        );
      }

      this.#publish({ phase: "preparing" });
      const backup = await this.#step("backup_failed", () =>
        backupBeforeUpgrade({
          backupsDir: this.#paths.backupsDir,
          previousVersion: this.#requireState().appVersion,
          currentVersion: this.#appVersion,
          dump: (target) =>
            this.#runtime.run(
              this.#paths.postgresBin("pg_dump"),
              [
                ...this.#pgArgs(ports),
                "--format=custom",
                `--file=${target}`,
                localBackendDatabase,
              ],
              this.#runOptions("backup.log", 30 * 60_000)
            ),
        })
      );
      if (backup) this.#publish({ lastBackupPath: backup });

      await this.#step("migration_failed", () =>
        this.#runtime.run(this.#paths.commaBin, ["eval", "Comma.LocalInstall.run()"], {
          ...this.#runOptions("prepare.log", 15 * 60_000),
          env: { ...this.#backendEnv(secrets, ports), COMMA_RELEASE_JOB: "1" },
        })
      );
      const state = this.#requireState();
      state.appVersion = this.#appVersion;
      writeLocalBackendState(this.#layout.dataDir, state);

      await this.#step("start_failed", () =>
        this.#supervisor!.start(this.#backendSpec(secrets, ports))
      );
      this.#publish({ phase: "ready" });
      return true;
    } catch (error) {
      const failure =
        error instanceof StepError
          ? { code: error.code, message: error.message }
          : { code: "start_failed" as const, message: errorMessage(error) };
      await this.#supervisor?.stopAll(stopOrder);
      this.#recordProcesses({});
      this.#publish({
        phase: "failed",
        failure: {
          code: failure.code,
          message: redactSecrets(failure.message, secrets),
        },
      });
      this.#log(
        `local backend failed to start: ${redactSecrets(failure.message, secrets)}`
      );
      return false;
    }
  }

  async #step<T>(code: LocalBackendFailureCode, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof StepError) throw error;
      throw new StepError(code, errorMessage(error), { cause: error });
    }
  }

  async #startPostgres(secrets: LocalBackendSecrets, ports: LocalBackendPorts) {
    const data = this.#paths.postgresData;
    await this.#step("start_failed", async () => {
      if (!existsSync(join(data, "PG_VERSION"))) {
        const pwfile = join(this.#layout.dataDir, ".initdb-password");
        writePrivateFile(pwfile, `${secrets.postgresPassword}\n`);
        try {
          await this.#runtime.run(
            this.#paths.postgresBin("initdb"),
            [
              "-D",
              data,
              "-U",
              "postgres",
              "--auth=scram-sha-256",
              `--pwfile=${pwfile}`,
              "--encoding=UTF8",
              "--locale=en_US.UTF-8",
            ],
            this.#runOptions("initdb.log", 5 * 60_000)
          );
        } finally {
          rmSync(pwfile, { force: true });
        }
      }
      await this.#supervisor!.start(this.#postgresSpec(ports));
      const exists = await this.#runtime
        .run(
          this.#paths.postgresBin("psql"),
          [
            ...this.#pgArgs(ports),
            "-d",
            "postgres",
            "-Atc",
            `SELECT 1/(count(*))::int FROM pg_database WHERE datname = '${localBackendDatabase}'`,
          ],
          this.#runOptions("postgres-setup.log", 30_000)
        )
        .then(
          () => true,
          () => false
        );
      if (!exists) {
        await this.#runtime.run(
          this.#paths.postgresBin("createdb"),
          [...this.#pgArgs(ports), localBackendDatabase],
          this.#runOptions("postgres-setup.log", 60_000)
        );
      }
    });
  }

  #pgArgs(ports: LocalBackendPorts) {
    return ["-h", loopbackHost, "-p", String(ports.postgres), "-U", "postgres", "-w"];
  }

  #baseEnv(): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR,
      PGPASSFILE: this.#paths.pgpass,
    };
  }

  #runOptions(logName: string, timeoutMs: number): RunOptions {
    return {
      env: this.#baseEnv(),
      cwd: this.#layout.dataDir,
      logFile: join(this.#paths.logsDir, logName),
      timeoutMs,
    };
  }

  #child(
    name: string,
    command: string,
    args: string[],
    overrides: Partial<ChildSpec> = {}
  ): ChildSpec {
    return {
      name,
      command,
      args,
      env: this.#baseEnv(),
      cwd: this.#layout.dataDir,
      logFile: join(this.#paths.logsDir, `${name}.log`),
      stopSignal: "SIGTERM",
      stopTimeoutMs: 20_000,
      readyTimeoutMs: 60_000,
      ...overrides,
    };
  }

  #postgresSpec(ports: LocalBackendPorts): ChildSpec {
    return this.#child(
      "postgres",
      this.#paths.postgresBin("postgres"),
      [
        "-D",
        this.#paths.postgresData,
        "-h",
        loopbackHost,
        "-p",
        String(ports.postgres),
        "-k",
        "",
      ],
      {
        stopSignal: "SIGINT",
        stopTimeoutMs: 30_000,
        ready: () =>
          this.#runtime
            .run(
              this.#paths.postgresBin("psql"),
              [...this.#pgArgs(ports), "-d", "postgres", "-Atc", "SELECT 1"],
              this.#runOptions("postgres-setup.log", 5_000)
            )
            .then(
              () => true,
              () => false
            ),
      }
    );
  }

  #redisSpec(secrets: LocalBackendSecrets, ports: LocalBackendPorts): ChildSpec {
    return this.#child("redis", this.#paths.redisServer, [this.#paths.redisConf], {
      ready: () => this.#runtime.redisPing(ports.redis, secrets.redisPassword),
    });
  }

  #minioSpec(ports: LocalBackendPorts): ChildSpec {
    return this.#child(
      "minio",
      this.#paths.minio,
      [
        "server",
        this.#paths.minioData,
        "--address",
        `${loopbackHost}:${ports.minio}`,
        "--console-address",
        `${loopbackHost}:${ports.minioConsole}`,
        "--certs-dir",
        this.#paths.minioCerts,
        "--quiet",
      ],
      {
        env: {
          ...this.#baseEnv(),
          MINIO_CONFIG_ENV_FILE: this.#paths.minioEnv,
          MINIO_BROWSER: "off",
          MINIO_UPDATE: "off",
        },
        ready: () =>
          this.#runtime.httpOk(
            `http://${loopbackHost}:${ports.minio}/minio/health/live`
          ),
      }
    );
  }

  /**
   * CommaTranscriber serve (openspec add-local-meeting-asr, D5/D6). It runs
   * without an installed model too; idle, it holds only a loopback socket.
   * taskpolicy caps the QoS of every thread, including the diarizer's
   * userInitiated workers, and execs in place, so the PID is the helper's.
   */
  #asrSpec(transcriber: LocalTranscriber, ports: LocalBackendPorts): ChildSpec {
    return this.#child(
      "asr",
      "/usr/sbin/taskpolicy",
      [
        "-c",
        "utility",
        transcriber.executable,
        "serve",
        "--port",
        String(ports.asr),
        "--token-file",
        this.#paths.asrTokenFile,
        "--models-dir",
        transcriber.modelsDir,
      ],
      {
        ready: () => this.#runtime.httpOk(`http://${loopbackHost}:${ports.asr}/health`),
      }
    );
  }

  #backendEnv(
    secrets: LocalBackendSecrets,
    ports: LocalBackendPorts
  ): NodeJS.ProcessEnv {
    return {
      ...this.#baseEnv(),
      COMMA_ENVIRONMENT: "local",
      // Single-owner instance: no cloud VM and no billing gate (config/runtime.exs).
      COMMA_DESKTOP_LOCAL: "1",
      COMMA_SUBSYSTEMS: "salix,comma_product",
      COMMA_LISTEN_IP: loopbackHost,
      COMMA_WEB_HTTP_PORT: String(ports.comma),
      COMMA_METRICS_PORT: String(ports.metrics),
      COMMA_PUBLIC_URL: `http://${loopbackHost}:${ports.comma}`,
      COMMA_SESSION_COOKIE_SECURE: "false",
      COMMA_TELEGRAM_ENABLED: "false",
      COMMA_REDIS_URL: redisUrl(secrets, ports),
      SALIX_CONFIG_PATH: this.#paths.configFile,
      SALIX_SNOWFLAKE_WORKER_ID: "0",
      RELEASE_COOKIE: secrets.releaseCookie,
      RELEASE_DISTRIBUTION: "none",
      RELEASE_TMP: this.#paths.releaseTmp,
      ERL_CRASH_DUMP: join(this.#paths.logsDir, "erl_crash.dump"),
    };
  }

  #backendSpec(secrets: LocalBackendSecrets, ports: LocalBackendPorts): ChildSpec {
    const health = (port: number) =>
      this.#runtime.httpOk(`http://${loopbackHost}:${port}/health`);
    return this.#child("backend", this.#paths.commaBin, ["start"], {
      env: this.#backendEnv(secrets, ports),
      stopTimeoutMs: 30_000,
      readyTimeoutMs: 180_000,
      ready: async () => (await health(ports.comma)) && (await health(ports.salix)),
    });
  }

  #createSupervisor() {
    return new ProcessSupervisor({
      spawn: (spec) => this.#runtime.spawn(spec),
      onStarted: (name, handle) => {
        if (handle.pid === undefined) return;
        const executable = this.#runtime.executableOf(handle.pid);
        if (!executable) return;
        const state = this.#requireState();
        this.#recordProcesses({
          ...state.processes,
          [name]: { pid: handle.pid, executable },
        });
      },
      onGaveUp: (_name, reason) => {
        if (this.#snapshot.phase === "stopping" || this.#snapshot.phase === "stopped")
          return;
        this.#log(`local backend: ${reason}`);
        this.#publish({
          phase: "failed",
          failure: { code: "process_stopped", message: reason },
        });
        void this.#supervisor?.stopAll(stopOrder);
      },
    });
  }

  #recordProcesses(processes: LocalBackendState["processes"]) {
    const state = this.#requireState();
    state.processes = processes;
    writeLocalBackendState(this.#layout.dataDir, state);
  }

  /** Stops everything and starts again; the "Try again" action of the error screen. */
  async retry(): Promise<boolean> {
    await this.#starting;
    await this.#supervisor?.stopAll(stopOrder);
    if (!(await this.#refreshPorts())) return false;
    return this.start();
  }

  /**
   * A failure may come from a port another program took after launch, so a
   * retry chooses the ports again and rewrites the configuration. Main's
   * Session already targets the API port, which cannot move until relaunch.
   */
  async #refreshPorts(): Promise<boolean> {
    const secrets = this.#secrets;
    const current = this.#ports;
    if (!secrets || !current) throw new Error("prepare() must run before retry().");
    const next = await (this.#runtime.resolvePorts ?? resolveLocalBackendPorts)({
      ...current,
    });
    if (next.comma !== current.comma) {
      this.#publish({
        phase: "failed",
        failure: {
          code: "start_failed",
          message: `Port ${current.comma} of Comma's API is now used by another program. Quit and reopen Comma to choose another port.`,
        },
      });
      return false;
    }
    this.#ports = next;
    const state = this.#requireState();
    state.ports = { ...next };
    writeLocalBackendState(this.#layout.dataDir, state);
    this.#writeConfigFiles(secrets, next);
    return true;
  }

  /** The owner's Session could not be created; the error screen offers Try again. */
  reportOwnerSessionFailure(message: string) {
    this.#publish({
      phase: "failed",
      failure: {
        code: "owner_session_failed",
        message: this.#secrets ? redactSecrets(message, this.#secrets) : message,
      },
    });
  }

  /** Stops every process (quit). Postgres receives SIGINT ("fast" shutdown). */
  async stop() {
    this.#publish({ phase: "stopping" });
    await this.#starting?.catch(() => undefined);
    await this.#supervisor?.stopAll(stopOrder);
    await this.#sweepBundledProcesses();
    if (this.#state) this.#recordProcesses({});
    this.#publish({ phase: "stopped" });
  }

  /**
   * The backend's own helpers (DNS resolver, spinfoam, subscription worker)
   * exit shortly after it. Waits for them, then kills any that remain, so no
   * bundled program outlives the app or a forced quit.
   */
  async #sweepBundledProcesses(graceMs = 5_000) {
    const deadline = Date.now() + graceMs;
    let remaining = this.#runtime.processesUnder(this.#layout.resourcesDir);
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      remaining = this.#runtime.processesUnder(this.#layout.resourcesDir);
    }
    for (const pid of remaining) this.#runtime.kill(pid, "SIGKILL");
  }

  #requireState(): LocalBackendState {
    if (!this.#state) throw new Error("The local backend is not prepared.");
    return this.#state;
  }

  #publish(patch: Partial<LocalBackendSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (this.#snapshot.phase !== "failed") delete this.#snapshot.failure;
    this.#onSnapshot(this.#snapshot);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
