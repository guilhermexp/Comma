import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prefixTool } from "./build-deps";
import {
  cleanBuildEnv,
  localBackendBuildRoot,
  prefixDir,
  repoRoot,
  run,
} from "./toolchain";

/** Host build tools the release needs; each is exposed alone, never its whole bin directory. */
const hostTools = ["pkg-config", "cmake", "go", "lean", "lake"];

function hostToolsDir() {
  const dir = join(localBackendBuildRoot(), "host-tools");
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const tool of hostTools) {
    const path = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).trim();
    if (!path) throw new Error(`${tool} is required to build the backend release.`);
    symlinkSync(path, join(dir, tool));
  }
  return dir;
}

export function backendReleaseDir() {
  return join(localBackendBuildRoot(), "release", "comma");
}

/**
 * Builds `MIX_ENV=prod mix release comma` with the prefix's Erlang/OTP and
 * Elixir, mirroring the native steps of systems/Dockerfile: the verified
 * kernel (Lean + CMake), the libsodium and libopus NIFs, precompiled mdex,
 * the pinned spinfoam, the Go workers, and `mix assets.deploy`. The release
 * includes this ERTS, so it runs without any Erlang on the user's Mac.
 */
export function buildBackendRelease() {
  const prefix = prefixDir();
  const otpBin = join(prefix, "otp", "bin");
  const elixirBin = join(prefix, "elixir", "bin");
  prefixTool(prefix, "otp", "bin", "erl");
  prefixTool(prefix, "elixir", "bin", "mix");
  const root = localBackendBuildRoot();
  const systems = join(repoRoot, "systems");
  const log = join(root, "logs", "release.log");
  const env: NodeJS.ProcessEnv = {
    ...cleanBuildEnv([otpBin, elixirBin, hostToolsDir()]),
    MIX_ENV: "prod",
    MIX_HOME: join(root, "mix-home"),
    HEX_HOME: join(root, "hex-home"),
    // Only the prefix's static libsodium and libopus are visible to the NIF builds.
    PKG_CONFIG_LIBDIR: join(prefix, "lib", "pkgconfig"),
    PKG_CONFIG_PATH: "",
    // The verified kernel's CMake build links this static OpenSSL.
    OPENSSL_ROOT_DIR: prefix,
    GOCACHE: join(root, "go", "build-cache"),
    GOMODCACHE: join(root, "go", "mod"),
    GOPATH: join(root, "go", "path"),
    CGO_ENABLED: "0",
    COMMA_LOCAL_RECOMMENDATION_MOCK: "false",
    ELAN_HOME: process.env.ELAN_HOME ?? join(homedir(), ".elan"),
  };
  const mix = (...args: string[]) => run(log, "mix", args, { cwd: systems, env });

  // The BridgeForTeams dashboard is part of the release's priv/ like in the image.
  run(log, "pnpm", ["--filter", "@comma/i18n", "compile"], {
    cwd: repoRoot,
    env: process.env,
  });
  run(log, "pnpm", ["--filter", "@comma/bft", "build"], {
    cwd: repoRoot,
    env: process.env,
  });

  mix("local.hex", "--force", "--if-missing");
  mix("local.rebar", "--force", "--if-missing");
  mix("deps.get", "--only", "prod");
  // A CMake cache configured against other libraries (a Homebrew build of
  // the same checkout) would keep their paths; one for this prefix is reused,
  // with the Lean sources it already downloaded.
  const kernelBuild = join(systems, "native", "verified_kernel", ".native");
  const cache = join(kernelBuild, "CMakeCache.txt");
  if (existsSync(cache)) {
    const contents = readFileSync(cache, "utf8");
    if (contents.includes("/opt/homebrew") || !contents.includes(prefix)) {
      rmSync(kernelBuild, { force: true, recursive: true });
    }
  }
  mix("deps.compile", "salix_verified_kernel", "--force");
  mix("deps.compile");
  mix("assets.setup");
  mix("assets.deploy");
  mix("compile");
  const out = backendReleaseDir();
  rmSync(out, { force: true, recursive: true });
  mix("release", "comma", "--overwrite", "--path", out);
  return out;
}
