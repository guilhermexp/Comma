import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackendConfig } from "../../src/main/local-backend/config";
import { backendReleaseDir } from "./build-release";
import { listMachOFiles } from "./macho";
import { assertRelocatable } from "./macho-gate";
import { localBackendManifest } from "./sources";
import { assembledLocalBackendDir, prefixDir } from "./toolchain";

/** Postgres programs the app runs: the server, first-run setup, and backups. */
const postgresPrograms = [
  "postgres",
  "initdb",
  "createdb",
  "pg_dump",
  "pg_restore",
  "psql",
];
export const requiredPostgresExtensions = [
  "citext",
  "pgcrypto",
  "btree_gin",
  "pg_trgm",
];

/**
 * Lays out Contents/Resources/local-backend:
 *
 *   comma/     the `comma` OTP release with its ERTS
 *   postgres/  bin/, lib/, share/ (relative paths the server resolves itself)
 *   redis/     redis-server
 *   minio/     minio
 *
 * Every Mach-O is signed ad hoc and the gate rejects any library reference
 * outside the tree and the system.
 */
export function assembleLocalBackend() {
  const prefix = prefixDir();
  const out = assembledLocalBackendDir();
  rmSync(out, { force: true, recursive: true });
  mkdirSync(out, { recursive: true });

  const release = backendReleaseDir();
  if (!existsSync(join(release, "bin", "comma"))) {
    throw new Error(
      `Missing backend release at ${release}; run the release step first.`
    );
  }
  cpSync(release, join(out, "comma"), { recursive: true, verbatimSymlinks: true });
  // The build writes a fixed distribution cookie. Each installation passes its
  // own RELEASE_COOKIE, and nothing secret ships inside the app.
  rmSync(join(out, "comma", "releases", "COOKIE"), { force: true });
  rmSync(join(out, "comma", "tmp"), { force: true, recursive: true });

  const pgsql = join(prefix, "pgsql");
  for (const program of postgresPrograms) {
    cpSync(join(pgsql, "bin", program), join(out, "postgres", "bin", program));
  }
  cpSync(join(pgsql, "lib"), join(out, "postgres", "lib"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !source.endsWith(".a") && !source.includes("/pgxs"),
  });
  cpSync(join(pgsql, "share"), join(out, "postgres", "share"), { recursive: true });

  cpSync(
    join(prefix, "redis", "bin", "redis-server"),
    join(out, "redis", "redis-server")
  );
  cpSync(join(prefix, "minio", "minio"), join(out, "minio", "minio"));

  writeFileSync(
    join(out, "versions.json"),
    `${JSON.stringify(
      Object.fromEntries(
        Object.entries(localBackendManifest.sources).map(([name, source]) => [
          name,
          source.version,
        ])
      ),
      null,
      2
    )}\n`
  );

  signAdHoc(out);
  assertRelocatable(out);
  return out;
}

export function signAdHoc(root: string) {
  const files = listMachOFiles(root);
  for (const file of files) {
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--timestamp=none", file],
      {
        stdio: "pipe",
      }
    );
  }
  console.log(`Signed ${files.length} local backend binaries ad hoc.`);
}

const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin",
  HOME: process.env.HOME,
  LANG: "en_US.UTF-8",
  ...extra,
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Proves the assembled tree runs on its own: the release evaluates code and
 * Postgres creates every extension the migrations use, both with only
 * /usr/bin:/bin on PATH and no DYLD_* variables.
 */
export async function smokeTestLocalBackend(root = assembledLocalBackendDir()) {
  const tmp = mkdtempSync(join(tmpdir(), "comma-local-backend-smoke-"));
  try {
    const placeholder = "smoke-test-placeholder-value";
    const config = buildBackendConfig({
      secrets: {
        version: 1,
        postgresPassword: placeholder,
        redisPassword: placeholder,
        storageAccessKey: placeholder,
        storageSecretKey: placeholder,
        releaseCookie: placeholder,
        secretKeyBase: placeholder,
        authSecret: placeholder,
        rateLimitSecret: placeholder,
        dashboardSecretKeyBase: placeholder,
        adminToken: placeholder,
        subscriptionStorageKey: Buffer.alloc(32).toString("base64"),
      },
      ports: {
        postgres: 9,
        redis: 9,
        minio: 9,
        minioConsole: 9,
        salix: 9,
        comma: 9,
        transfer: 9,
        metrics: 9,
      },
      logsDir: tmp,
    });
    writeFileSync(join(tmp, "config.json"), JSON.stringify(config));
    const evaluated = spawnSync(
      join(root, "comma", "bin", "comma"),
      ["eval", "IO.puts(:ok)"],
      {
        env: cleanEnv({
          // The runtime configuration of the local mode, without any service:
          // eval loads it and evaluates one expression.
          COMMA_ENVIRONMENT: "local",
          COMMA_SUBSYSTEMS: "salix,comma_product",
          COMMA_REDIS_URL: "redis://127.0.0.1:9/0",
          SALIX_SNOWFLAKE_WORKER_ID: "0",
          SALIX_CONFIG_PATH: join(tmp, "config.json"),
          RELEASE_COOKIE: "smoke-test",
          RELEASE_DISTRIBUTION: "none",
          RELEASE_TMP: tmp,
          ERL_CRASH_DUMP: join(tmp, "erl_crash.dump"),
        }),
        cwd: tmp,
        encoding: "utf8",
      }
    );
    if (evaluated.status !== 0 || evaluated.stdout.trim() !== "ok") {
      throw new Error(
        `bin/comma eval failed (${evaluated.status}): ${evaluated.stdout}${evaluated.stderr}`
      );
    }
    console.log("Smoke test: bin/comma eval 'IO.puts(:ok)' printed ok.");

    const bin = join(root, "postgres", "bin");
    const data = join(tmp, "pg");
    const run = (program: string, args: string[]) =>
      execFileSync(join(bin, program), args, { env: cleanEnv(), stdio: "pipe" });
    run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--encoding=UTF8"]);
    const port = await freePort();
    const server = spawn(
      join(bin, "postgres"),
      ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-k", ""],
      { env: cleanEnv(), stdio: "ignore" }
    );
    try {
      const psql = (sql: string) =>
        run("psql", [
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-U",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-Atc",
          sql,
        ]);
      for (let attempt = 0; ; attempt += 1) {
        try {
          psql("SELECT 1");
          break;
        } catch (error) {
          if (attempt > 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      for (const extension of requiredPostgresExtensions) {
        psql(`CREATE EXTENSION ${extension}`);
      }
      const installed = psql(
        "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension"
      )
        .toString()
        .trim();
      console.log(`Smoke test: Postgres created extensions ${installed}.`);
    } finally {
      server.kill("SIGINT");
      await new Promise((resolve) => server.once("exit", resolve));
    }
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
}
