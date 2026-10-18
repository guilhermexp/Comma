import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { relocateMachOTree } from "./relocate";
import { fetchPinnedSource, localBackendManifest } from "./sources";
import {
  cleanBuildEnv,
  downloadsDir,
  freshDir,
  jobs,
  localBackendBuildRoot,
  markStepDone,
  prefixDir,
  run,
  sourceInputs,
  stepDone,
  toolDir,
} from "./toolchain";

type SourceName = keyof typeof localBackendManifest.sources;

const postgresExtensions = ["citext", "pgcrypto", "btree_gin", "pg_trgm"];

interface Step {
  name: SourceName;
  build: (input: { prefix: string; src: string; log: string }) => void;
}

/**
 * OpenSSL, libsodium, libopus and libuv are static archives only. Erlang's crypto
 * NIF, Postgres, and the Salix NIFs therefore carry the code they need and
 * reference no third-party dylib that would have to be relocated.
 */
const steps: Step[] = [
  {
    name: "openssl",
    build: ({ prefix, src, log }) => {
      run(
        log,
        "./Configure",
        [
          "darwin64-arm64-cc",
          `--prefix=${prefix}`,
          `--openssldir=${prefix}/ssl`,
          "--libdir=lib",
          "no-shared",
          "no-tests",
          "no-docs",
        ],
        { cwd: src }
      );
      run(log, "make", [`-j${jobs}`], { cwd: src });
      run(log, "make", ["install_sw"], { cwd: src });
    },
  },
  {
    name: "libsodium",
    build: ({ prefix, src, log }) => autotools(log, src, prefix),
  },
  {
    name: "opus",
    build: ({ prefix, src, log }) =>
      autotools(log, src, prefix, ["--disable-doc", "--disable-extra-programs"]),
  },
  {
    name: "libuv",
    build: ({ prefix, src, log }) => autotools(log, src, prefix),
  },
  {
    name: "otp",
    build: ({ prefix, src, log }) => {
      run(
        log,
        "./configure",
        [
          `--prefix=${prefix}/otp`,
          `--with-ssl=${prefix}`,
          // Link libcrypto.a into crypto.so instead of a dylib path.
          "--disable-dynamic-ssl-lib",
          "--without-javac",
          "--without-wx",
          "--without-odbc",
          "--without-debugger",
          "--without-observer",
          "--without-et",
        ],
        { cwd: src }
      );
      run(log, "make", [`-j${jobs}`], { cwd: src });
      run(log, "make", ["install"], { cwd: src });
    },
  },
  {
    name: "elixir",
    build: ({ prefix, src, log }) => {
      const target = freshDir(join(prefix, "elixir"));
      run(log, "/usr/bin/ditto", [src, target]);
    },
  },
  {
    name: "postgres",
    build: ({ prefix, src, log }) => {
      const target = join(prefix, "pgsql");
      // libpq refuses any `exit` symbol. The static OpenSSL brings atexit
      // and pthread_exit (cleanup registration and thread exit), neither of
      // which ends the client process, so they join the existing exclusion.
      const libpqMakefile = join(src, "src", "interfaces", "libpq", "Makefile");
      writeFileSync(
        libpqMakefile,
        readFileSync(libpqMakefile, "utf8").replace(
          "grep -v __cxa_atexit | grep exit",
          "grep -v -e __cxa_atexit -e _atexit -e _pthread_exit | grep exit"
        )
      );
      run(
        log,
        "./configure",
        [
          `--prefix=${target}`,
          "--with-openssl",
          `--with-includes=${prefix}/include`,
          `--with-libraries=${prefix}/lib`,
          "--without-icu",
          "--without-readline",
          "--disable-rpath",
        ],
        { cwd: src }
      );
      run(log, "make", [`-j${jobs}`], { cwd: src });
      run(log, "make", ["install"], { cwd: src });
      for (const extension of postgresExtensions) {
        run(log, "make", ["-C", `contrib/${extension}`, "install"], { cwd: src });
      }
      relocateMachOTree(target, { libDir: join(target, "lib") });
    },
  },
  {
    name: "redis",
    build: ({ prefix, src, log }) => {
      const make = ["BUILD_TLS=no", "USE_SYSTEMD=no", "MALLOC=libc"];
      run(log, "make", [`-j${jobs}`, ...make], { cwd: src });
      run(log, "make", [...make, `PREFIX=${prefix}/redis`, "install"], { cwd: src });
    },
  },
  {
    name: "minio",
    build: ({ prefix, src, log }) => {
      const version = localBackendManifest.sources.minio.version;
      const root = localBackendBuildRoot();
      const env = {
        ...cleanBuildEnv([toolDir("go")]),
        CGO_ENABLED: "0",
        GOCACHE: join(root, "go", "build-cache"),
        GOMODCACHE: join(root, "go", "mod"),
        GOPATH: join(root, "go", "path"),
        GOFLAGS: "-mod=readonly",
      };
      mkdirSync(join(prefix, "minio"), { recursive: true });
      const releaseTag = version.replace(/^RELEASE\./, "");
      const releaseTime = releaseTag.replace(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/,
        "$1T$2:$3:$4Z"
      );
      run(
        log,
        "go",
        [
          "build",
          "-trimpath",
          "-tags",
          "kqueue",
          "-ldflags",
          [
            "-s",
            "-w",
            `-X github.com/minio/minio/cmd.Version=${releaseTime}`,
            `-X github.com/minio/minio/cmd.ReleaseTag=${version}`,
            "-X github.com/minio/minio/cmd.CopyrightYear=2025",
          ].join(" "),
          "-o",
          join(prefix, "minio", "minio"),
          ".",
        ],
        { cwd: src, env }
      );
    },
  },
];

function autotools(log: string, src: string, prefix: string, extra: string[] = []) {
  run(
    log,
    "./configure",
    [
      `--prefix=${prefix}`,
      "--disable-shared",
      "--enable-static",
      "--with-pic",
      ...extra,
    ],
    { cwd: src }
  );
  run(log, "make", [`-j${jobs}`], { cwd: src });
  run(log, "make", ["install"], { cwd: src });
}

async function extract(name: SourceName, log: string): Promise<string> {
  const archive = await fetchPinnedSource(localBackendManifest.sources[name], {
    cacheDir: downloadsDir(),
  });
  const work = freshDir(join(localBackendBuildRoot(), "src", name));
  if (archive.endsWith(".zip")) {
    run(log, "/usr/bin/ditto", ["-x", "-k", archive, work]);
    return work;
  }
  run(log, "/usr/bin/tar", ["-xf", archive, "-C", work]);
  const [top] = readdirSync(work);
  if (!top) throw new Error(`${archive} is empty.`);
  return join(work, top);
}

/** Builds every pinned source into the prefix; finished steps are kept. */
export async function buildLocalBackendDeps(only?: SourceName[]) {
  const prefix = prefixDir();
  mkdirSync(prefix, { recursive: true });
  for (const step of steps) {
    if (only && !only.includes(step.name)) continue;
    const stamp = join(prefix, ".stamps", step.name);
    const inputs = sourceInputs(step.name);
    if (stepDone(stamp, inputs)) {
      console.log(`local backend: ${step.name} is up to date`);
      continue;
    }
    const log = join(localBackendBuildRoot(), "logs", `${step.name}.log`);
    console.log(`local backend: building ${step.name} (log: ${log})`);
    const src = await extract(step.name, log);
    step.build({ prefix, src, log });
    markStepDone(stamp, inputs);
  }
  return prefix;
}

export function prefixTool(prefix: string, ...path: string[]) {
  const tool = join(prefix, ...path);
  if (!existsSync(tool)) throw new Error(`Missing ${tool}; run the deps step first.`);
  return tool;
}
