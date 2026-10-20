import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  LocalTranscriptionActionResult,
  LocalTranscriptionErrorCode,
  LocalTranscriptionState,
  LocalTranscriptionUnsupportedReason,
} from "@comma/native-bridge";

/** What Main knows before asking the helper (D7: the support check stays in Main). */
export interface LocalTranscriptionEnvironment {
  localMode: boolean;
  /** process.arch; Rosetta reports x64. */
  arch: string;
  /** process.getSystemVersion(), for example "15.1.0". */
  macosVersion: string;
  /** The bundled CommaTranscriber, or undefined when the build has none. */
  executable: string | undefined;
  modelsDir: string;
}

/** One run of a CommaTranscriber subcommand: its stdout lines and its exit. */
export interface TranscriberRun {
  lines: AsyncIterable<string>;
  exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

export type RunTranscriber = (executable: string, args: string[]) => TranscriberRun;

// Contract C1: every stdout line is one JSON object.
const statusLine = z.object({
  type: z.literal("status"),
  supported: z.boolean(),
  reason: z.enum(["unsupported_cpu", "unsupported_os"]).nullable().optional(),
  installed: z.boolean(),
  downloadBytes: z.number().int().nonnegative(),
});
const progressLine = z.object({
  type: z.literal("progress"),
  phase: z.enum(["downloading", "preparing"]),
  fraction: z.number().min(0).max(1).optional(),
});
const resultLine = z.object({
  type: z.literal("result"),
  ok: z.boolean(),
  error: z
    .object({
      code: z.enum(["unsupported", "network", "checksum_mismatch", "cancelled", "io"]),
      message: z.string(),
    })
    .optional(),
});
const helperLine = z.discriminatedUnion("type", [statusLine, progressLine, resultLine]);
type HelperLine = z.infer<typeof helperLine>;

const minimumMacosMajor = 15;

/** Spawns the helper with piped stdout; stderr is its log. */
export const spawnTranscriber: RunTranscriber = (executable, args) => {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return {
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    exited,
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
};

/**
 * Main's owner of the speech models (openspec add-local-meeting-asr, task
 * 3.4). It runs CommaTranscriber's status, install and remove subcommands,
 * turns their JSONL into the `localTranscription` state, and refuses to
 * remove the model while the serving helper reports a transcription.
 */
export class LocalTranscriptionManager {
  readonly #environment: LocalTranscriptionEnvironment;
  readonly #run: RunTranscriber;
  readonly #health: () => Promise<{ busy: boolean } | undefined>;
  readonly #onState: (state: LocalTranscriptionState) => void;
  readonly #log: (message: string) => void;
  #state: LocalTranscriptionState;
  #checked: Promise<void>;
  #install: TranscriberRun | undefined;
  #removing = false;

  constructor(options: {
    environment: LocalTranscriptionEnvironment;
    /** GET /health of the serving helper; undefined when it does not answer. */
    health: () => Promise<{ busy: boolean } | undefined>;
    onState: (state: LocalTranscriptionState) => void;
    run?: RunTranscriber | undefined;
    log?: ((message: string) => void) | undefined;
  }) {
    this.#environment = options.environment;
    this.#run = options.run ?? spawnTranscriber;
    this.#health = options.health;
    this.#onState = options.onState;
    this.#log = options.log ?? (() => undefined);
    const reason = this.#unsupportedReason();
    this.#state = {
      supported: !reason,
      ...(reason ? { reason } : {}),
      phase: "not_installed",
      sizeBytes: 0,
    };
    this.#checked = reason ? Promise.resolve() : this.#refresh();
  }

  /** The current state, once the first status check has answered. */
  async state(): Promise<LocalTranscriptionState> {
    await this.#checked;
    return this.#state;
  }

  /** True when a recording cannot be transcribed until the user installs the model. */
  needsInstall() {
    return (
      this.#state.supported &&
      (this.#state.phase === "not_installed" || this.#state.phase === "failed")
    );
  }

  /** Reads the installed state again, for example after the server reported no model. */
  refresh() {
    if (!this.#state.supported || this.#install || this.#removing) return this.#checked;
    this.#checked = this.#refresh();
    return this.#checked;
  }

  async install(): Promise<LocalTranscriptionActionResult> {
    await this.#checked;
    const executable = this.#environment.executable;
    if (!this.#state.supported || !executable)
      return { accepted: false, reason: "unsupported" };
    if (this.#install || this.#removing)
      return { accepted: false, reason: "in_progress" };
    if (this.#state.phase === "ready") return { accepted: true };
    const run = this.#run(executable, ["install", ...this.#modelsArgs()]);
    this.#install = run;
    this.#publish({ phase: "downloading", fraction: 0, error: undefined });
    void this.#follow(run).finally(() => {
      this.#install = undefined;
    });
    return { accepted: true };
  }

  /** SIGTERM: the helper deletes its staging folder and reports `cancelled`. */
  async cancel(): Promise<LocalTranscriptionActionResult> {
    if (!this.#install) return { accepted: false };
    this.#install.kill("SIGTERM");
    return { accepted: true };
  }

  async remove(): Promise<LocalTranscriptionActionResult> {
    await this.#checked;
    const executable = this.#environment.executable;
    if (!this.#state.supported || !executable)
      return { accepted: false, reason: "unsupported" };
    if (this.#install || this.#removing)
      return { accepted: false, reason: "in_progress" };
    // GET /health reports an active job; a helper that does not answer runs none.
    if ((await this.#health().catch(() => undefined))?.busy)
      return { accepted: false, reason: "busy" };
    this.#removing = true;
    try {
      const { result } = await this.#collect(
        this.#run(executable, ["remove", ...this.#modelsArgs()])
      );
      if (result?.ok) this.#publish({ phase: "not_installed", error: undefined });
      else
        this.#publish({
          phase: "failed",
          error: {
            code: "io",
            message: truncate(result?.error?.message ?? "The model was not removed."),
          },
        });
      return { accepted: true };
    } finally {
      this.#removing = false;
    }
  }

  #unsupportedReason(): LocalTranscriptionUnsupportedReason | undefined {
    const environment = this.#environment;
    if (!environment.localMode) return "remote_backend";
    if (environment.arch !== "arm64") return "unsupported_cpu";
    const major = Number.parseInt(environment.macosVersion.split(".")[0] ?? "", 10);
    if (!(major >= minimumMacosMajor)) return "unsupported_os";
    if (!environment.executable) return "helper_missing";
    return undefined;
  }

  #modelsArgs() {
    return ["--models-dir", this.#environment.modelsDir];
  }

  async #refresh() {
    const executable = this.#environment.executable;
    if (!executable) return;
    const { status } = await this.#collect(
      this.#run(executable, ["status", ...this.#modelsArgs()])
    );
    if (!status) {
      this.#log("CommaTranscriber status gave no answer.");
      return;
    }
    if (!status.supported) {
      this.#publish({
        supported: false,
        reason: status.reason ?? "unsupported_os",
        phase: "not_installed",
        sizeBytes: status.downloadBytes,
      });
      return;
    }
    this.#publish({
      sizeBytes: status.downloadBytes,
      ...(this.#state.phase === "failed"
        ? {}
        : { phase: status.installed ? "ready" : "not_installed" }),
    });
  }

  async #follow(run: TranscriberRun) {
    let result: z.infer<typeof resultLine> | undefined;
    for await (const line of parsedLines(run.lines, this.#log)) {
      if (line.type === "progress") {
        this.#publish(
          line.phase === "downloading"
            ? { phase: "downloading", fraction: line.fraction ?? 0 }
            : { phase: "preparing", fraction: undefined }
        );
      } else if (line.type === "result") {
        result = line;
      }
    }
    const code = await run.exited;
    if (result?.ok && code === 0) {
      this.#publish({ phase: "ready", fraction: undefined, error: undefined });
    } else if (result?.error?.code === "cancelled") {
      this.#publish({ phase: "not_installed", fraction: undefined, error: undefined });
    } else {
      this.#publish({
        phase: "failed",
        fraction: undefined,
        error: {
          code: (result?.error?.code ?? "io") as LocalTranscriptionErrorCode,
          message: truncate(
            result?.error?.message ??
              `The transcription helper stopped (exit code ${code ?? "unknown"}).`
          ),
        },
      });
    }
  }

  async #collect(run: TranscriberRun) {
    let status: z.infer<typeof statusLine> | undefined;
    let result: z.infer<typeof resultLine> | undefined;
    for await (const line of parsedLines(run.lines, this.#log)) {
      if (line.type === "status") status = line;
      if (line.type === "result") result = line;
    }
    await run.exited;
    return { status, result };
  }

  #publish(patch: Partial<LocalTranscriptionState>) {
    const next = { ...this.#state, ...patch };
    for (const key of ["reason", "fraction", "error"] as const) {
      if (next[key] === undefined) delete next[key];
    }
    if (next.phase !== "downloading") delete next.fraction;
    if (next.phase !== "failed") delete next.error;
    this.#state = next;
    this.#onState(next);
  }
}

async function* parsedLines(
  lines: AsyncIterable<string>,
  log: (message: string) => void
): AsyncGenerator<HelperLine> {
  for await (const text of lines) {
    if (!text.trim()) continue;
    try {
      const parsed = helperLine.safeParse(JSON.parse(text));
      if (parsed.success) yield parsed.data;
      else log(`CommaTranscriber wrote an unknown line: ${text.slice(0, 200)}`);
    } catch {
      log(`CommaTranscriber wrote a line that is not JSON: ${text.slice(0, 200)}`);
    }
  }
}

function truncate(message: string) {
  return message.slice(0, 500);
}
