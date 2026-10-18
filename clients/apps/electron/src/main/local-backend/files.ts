import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Per-installation secrets of the local backend, generated on the first
 * launch. The file is the only copy, so a value is never regenerated once it
 * exists: the subscription storage key seals account data in the database.
 */
export interface LocalBackendSecrets {
  version: 1;
  postgresPassword: string;
  redisPassword: string;
  storageAccessKey: string;
  storageSecretKey: string;
  releaseCookie: string;
  secretKeyBase: string;
  authSecret: string;
  rateLimitSecret: string;
  dashboardSecretKeyBase: string;
  adminToken: string;
  subscriptionStorageKey: string;
}

type SecretName = Exclude<keyof LocalBackendSecrets, "version">;

const hex = (bytes: number) => () => randomBytes(bytes).toString("hex");
const secretGenerators: Record<SecretName, () => string> = {
  postgresPassword: hex(32),
  redisPassword: hex(32),
  storageAccessKey: hex(16),
  storageSecretKey: hex(32),
  releaseCookie: hex(32),
  secretKeyBase: hex(32),
  authSecret: hex(32),
  rateLimitSecret: hex(32),
  dashboardSecretKeyBase: hex(32),
  adminToken: hex(32),
  // SALIX_SUBSCRIPTION_STORAGE_KEY is a base64 32-byte key.
  subscriptionStorageKey: () => randomBytes(32).toString("base64"),
};

export interface LocalBackendProcessRecord {
  pid: number;
  executable: string;
}

/** Rebuildable facts of the installation: chosen ports, running children, last version. */
export interface LocalBackendState {
  version: 1;
  appVersion?: string | undefined;
  ownerUserId?: string | undefined;
  ports: Partial<Record<string, number>>;
  processes: Partial<Record<string, LocalBackendProcessRecord>>;
}

/** Writes a private file atomically: no reader ever sees a partial or wider-mode file. */
export function writePrivateFile(path: string, contents: string) {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, contents, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

export function ensureLocalBackendSecrets(dataDir: string): LocalBackendSecrets {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const path = join(dataDir, "secrets.json");
  let existing: Partial<Record<SecretName, unknown>> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      existing = parsed as Partial<Record<SecretName, unknown>>;
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON. It holds this installation's only copy of its keys, so Comma does not replace it.`,
        { cause: error }
      );
    }
  }

  let changed = !existsSync(path);
  const secrets = { version: 1 } as LocalBackendSecrets;
  for (const name of Object.keys(secretGenerators) as SecretName[]) {
    const value = existing[name];
    if (typeof value === "string" && value.length > 0) {
      secrets[name] = value;
    } else {
      secrets[name] = secretGenerators[name]();
      changed = true;
    }
  }
  if (changed) writePrivateFile(path, `${JSON.stringify(secrets, null, 2)}\n`);
  else chmodSync(path, 0o600);
  return secrets;
}

const emptyState = (): LocalBackendState => ({ version: 1, ports: {}, processes: {} });

export function readLocalBackendState(dataDir: string): LocalBackendState {
  const path = join(dataDir, "state.json");
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LocalBackendState>;
    if (!parsed || parsed.version !== 1) return emptyState();
    return {
      version: 1,
      ...(typeof parsed.appVersion === "string"
        ? { appVersion: parsed.appVersion }
        : {}),
      ...(typeof parsed.ownerUserId === "string"
        ? { ownerUserId: parsed.ownerUserId }
        : {}),
      ports: isRecord(parsed.ports) ? parsed.ports : {},
      processes: isRecord(parsed.processes) ? parsed.processes : {},
    };
  } catch {
    return emptyState();
  }
}

export function writeLocalBackendState(dataDir: string, state: LocalBackendState) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(dataDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function isRecord<T>(value: unknown): value is Record<string, T> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
