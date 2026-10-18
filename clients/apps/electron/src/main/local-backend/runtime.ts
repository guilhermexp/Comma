import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname } from "node:path";
import type { LocalBackendRuntime, RunOptions } from "./service";
import type { ChildExit, ChildHandle, ChildSpec } from "./supervisor";

function openLog(path: string, header: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  writeSync(fd, `\n=== ${new Date().toISOString()} ${header}\n`);
  return fd;
}

function spawnLogged(
  command: string,
  args: string[],
  spec: { env: NodeJS.ProcessEnv; cwd: string; logFile: string }
) {
  const fd = openLog(spec.logFile, basename(command));
  try {
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", fd, fd],
    });
    const exited = new Promise<ChildExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });
    return { child, exited };
  } finally {
    closeSync(fd);
  }
}

/** The real operating-system side of LocalBackendService. */
export const nodeLocalBackendRuntime: LocalBackendRuntime = {
  spawn(spec: ChildSpec): ChildHandle {
    const { child, exited } = spawnLogged(spec.command, spec.args, spec);
    return {
      pid: child.pid,
      exited,
      kill: (signal) => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    };
  },

  async run(command: string, args: string[], options: RunOptions) {
    const { child, exited } = spawnLogged(command, args, options);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const exit = await exited.finally(() => clearTimeout(timer));
    if (exit.code !== 0) {
      throw new Error(
        `${basename(command)} ${exit.signal ? `was stopped by ${exit.signal}` : `exited with status ${exit.code}`}. Log: ${options.logFile}`
      );
    }
  },

  /** 200 from the URL; a /health endpoint must also answer {"status":"ok"}. */
  async httpOk(url: string) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status !== 200) return false;
      if (!url.endsWith("/health")) return true;
      const body = (await response.json()) as { status?: unknown };
      return body.status === "ok";
    } catch {
      return false;
    }
  },

  redisPing(port: number, password: string) {
    return new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      let reply = "";
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(2_000, () => done(false));
      socket.once("error", () => done(false));
      socket.once("connect", () => {
        const auth = `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n`;
        socket.write(`${auth}*1\r\n$4\r\nPING\r\n`);
      });
      socket.on("data", (chunk) => {
        reply += chunk.toString("utf8");
        if (reply.includes("+PONG")) done(true);
        else if (reply.includes("-")) done(false);
      });
    });
  },

  /** The executable a PID runs, read from its text mapping (title changes do not affect it). */
  executableOf(pid: number) {
    try {
      const output = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        }
      );
      return output
        .split("\n")
        .find((line) => line.startsWith("n/"))
        ?.slice(1);
    } catch {
      return undefined;
    }
  },

  processesUnder(dir: string) {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    try {
      const output = execFileSync(
        "/bin/ps",
        ["-U", String(process.getuid?.() ?? ""), "-o", "pid=,comm="],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        }
      );
      return output
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray =>
          Boolean(match?.[2]?.startsWith(prefix))
        )
        .map((match) => Number(match[1]))
        .filter((pid) => pid !== process.pid);
    } catch {
      return [];
    }
  },

  isAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },

  kill(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
};
