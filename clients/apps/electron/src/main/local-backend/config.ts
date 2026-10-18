import { join } from "node:path";
import type { LocalBackendSecrets } from "./files";
import type { LocalBackendPorts } from "./ports";

export const localBackendDatabase = "comma";
export const localBackendBucket = "comma-local";
export const loopbackHost = "127.0.0.1";

/**
 * The backend's SALIX_CONFIG_PATH file, in the format of the native
 * development stack's `.local/native/config.json`. Main regenerates it from
 * secrets.json and state.json on every launch; the admin token reaches the
 * backend only through this 0600 file.
 */
export function buildBackendConfig({
  secrets,
  ports,
  logsDir,
}: {
  secrets: LocalBackendSecrets;
  ports: LocalBackendPorts;
  logsDir: string;
}) {
  const databaseUrl = `ecto://postgres:${secrets.postgresPassword}@${loopbackHost}:${ports.postgres}/${localBackendDatabase}`;
  return {
    storage: {
      endpoint: `http://${loopbackHost}:${ports.minio}`,
      region: "us-east-1",
      bucket: localBackendBucket,
      access_key_id: secrets.storageAccessKey,
      secret_access_key: secrets.storageSecretKey,
      atomic_operations: "s3",
      conditional_delete: "emulate",
    },
    log: { file: join(logsDir, "backend.jsonl") },
    web: {
      port: ports.salix,
      api_token: secrets.adminToken,
      api_base_url: `http://${loopbackHost}:${ports.salix}`,
      sites_domain: "salix.localhost",
      sites_port: ports.salix,
    },
    transfer: { port: ports.transfer, advertise_host: loopbackHost },
    salix_dashboard: { secret_key_base: secrets.dashboardSecretKeyBase },
    salix: { database: { url: databaseUrl, pool_size: 4 } },
    billing: { database: { url: databaseUrl, pool_size: 4 } },
    comma: {
      database: { url: databaseUrl, pool_size: 8 },
      auth: {
        secret: secrets.authSecret,
        rate_limit_secret: secrets.rateLimitSecret,
        redis_url: redisUrl(secrets, ports),
      },
    },
    subscription_proxy: { storage_key: secrets.subscriptionStorageKey },
  };
}

export type BackendConfig = ReturnType<typeof buildBackendConfig>;

export function redisUrl(secrets: LocalBackendSecrets, ports: LocalBackendPorts) {
  return `redis://:${secrets.redisPassword}@${loopbackHost}:${ports.redis}/0`;
}

/** A copy safe for logs: every secret value, alone or inside a URL, becomes [redacted]. */
export function redactSecrets<T>(value: T, secrets: LocalBackendSecrets): T {
  const values = Object.entries(secrets)
    .filter(
      ([name, secret]) => name !== "version" && typeof secret === "string" && secret
    )
    .map(([, secret]) => secret as string)
    .toSorted((left, right) => right.length - left.length);
  const redact = (input: unknown): unknown => {
    if (typeof input === "string") {
      if (values.includes(input)) return "[redacted]";
      return values.reduce(
        (text, secret) => text.split(secret).join("[redacted]"),
        input
      );
    }
    if (Array.isArray(input)) return input.map(redact);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, redact(item)])
      );
    }
    return input;
  };
  return redact(value) as T;
}
