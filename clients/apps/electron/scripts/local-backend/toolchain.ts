import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { localBackendManifest } from "./sources";

export const electronAppDir = resolve(import.meta.dirname, "../..");
export const repoRoot = resolve(electronAppDir, "../../..");

/**
 * Build products of the local backend. The prefix holds the toolchain and the
 * third-party programs; it depends only on the manifest, so CI caches it by the
 * manifest hash. The default keeps every build product under the gitignored
 * repository `.tmp/`.
 */
export function localBackendBuildRoot() {
  return resolve(
    process.env.COMMA_LOCAL_BACKEND_BUILD_DIR ?? join(repoRoot, ".tmp", "local-backend")
  );
}

/**
 * Names the prefix by the pinned sources and the scripts that build them, so a
 * changed version, flag, or relocation step never reuses an older prefix.
 */
export function manifestKey() {
  const hash = createHash("sha256");
  for (const file of [
    "manifest.json",
    "build-deps.ts",
    "relocate.ts",
    "toolchain.ts",
  ]) {
    hash.update(readFileSync(join(import.meta.dirname, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

export function prefixDir() {
  return join(localBackendBuildRoot(), `prefix-${manifestKey()}`);
}

export function downloadsDir() {
  return join(localBackendBuildRoot(), "downloads");
}

/** The assembled `local-backend/` tree that Forge copies into Contents/Resources. */
export function assembledLocalBackendDir() {
  return resolve(
    process.env.COMMA_LOCAL_BACKEND_DIR ?? join(electronAppDir, "dist", "local-backend")
  );
}

export const jobs = String(Math.max(2, availableParallelism()));

/**
 * The build environment never sees Homebrew or other host prefixes, so a
 * configure script cannot pick up a library that a clean Mac lacks. Tools the
 * build needs from elsewhere (Go, Lean, Node) are added by directory.
 */
export function cleanBuildEnv(extraPath: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR,
    PATH: [...extraPath, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    MACOSX_DEPLOYMENT_TARGET: "14.0",
  };
  if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
  return env;
}

/** Directory of a host tool found on the caller's PATH, for cleanBuildEnv. */
export function toolDir(tool: string): string {
  const result = spawnSync("/usr/bin/which", [tool], { encoding: "utf8" });
  const path = result.stdout.trim();
  if (result.status !== 0 || !path) {
    throw new Error(
      `${tool} is required to build the local backend but is not on PATH.`
    );
  }
  return dirname(path);
}

/** Runs a build command with its output in a log file; prints the tail on failure. */
export function run(
  logFile: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  writeFileSync(fd, `\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? cleanBuildEnv(),
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const tail = readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}. Log: ${logFile}\n${tail}`
    );
  }
}

export function freshDir(path: string) {
  rmSync(path, { force: true, recursive: true });
  mkdirSync(path, { recursive: true });
  return path;
}

/** Stamp files record a finished step for the inputs it was built from. */
export function stepDone(stamp: string, inputs: string) {
  return existsSync(stamp) && readFileSync(stamp, "utf8") === inputs;
}

export function markStepDone(stamp: string, inputs: string) {
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, inputs);
}

export function sourceInputs(name: keyof typeof localBackendManifest.sources) {
  const source = localBackendManifest.sources[name];
  return `${name}@${source.version}#${source.sha256}`;
}
