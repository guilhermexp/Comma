import { describe, expect, it } from "vitest";
import { buildBackendConfig, redactSecrets } from "../local-backend/config";
import type { LocalBackendSecrets } from "../local-backend/files";
import type { LocalBackendPorts } from "../local-backend/ports";

const secrets: LocalBackendSecrets = {
  version: 1,
  postgresPassword: "pg-secret-value-0001",
  redisPassword: "redis-secret-value-0002",
  storageAccessKey: "storage-access-0003",
  storageSecretKey: "storage-secret-0004",
  releaseCookie: "cookie-secret-0005",
  secretKeyBase: "key-base-secret-0006",
  authSecret: "auth-secret-0007",
  rateLimitSecret: "rate-limit-secret-0008",
  dashboardSecretKeyBase: "dashboard-secret-0009",
  adminToken: "admin-token-secret-0010",
  subscriptionStorageKey: "c3Vic2NyaXB0aW9uLXN0b3JhZ2Uta2V5LTAwMTEhIQ==",
  asrToken: "asr-token-secret-0012",
};

const ports: LocalBackendPorts = {
  postgres: 51001,
  redis: 51002,
  minio: 51003,
  minioConsole: 51004,
  salix: 51005,
  comma: 51006,
  transfer: 51007,
  metrics: 51008,
  asr: 51009,
};

describe("local backend configuration", () => {
  const config = buildBackendConfig({ secrets, ports, logsDir: "/data/logs" });

  it("points every service at the installation's own loopback ports and secrets", () => {
    expect(config.comma.database.url).toBe(
      "ecto://postgres:pg-secret-value-0001@127.0.0.1:51001/comma"
    );
    expect(config.salix.database.url).toBe(config.comma.database.url);
    expect(config.billing.database.url).toBe(config.comma.database.url);
    expect(config.comma.auth.redis_url).toBe(
      "redis://:redis-secret-value-0002@127.0.0.1:51002/0"
    );
    expect(config.storage).toMatchObject({
      endpoint: "http://127.0.0.1:51003",
      access_key_id: "storage-access-0003",
      secret_access_key: "storage-secret-0004",
    });
    expect(config.web).toMatchObject({
      port: 51005,
      api_token: "admin-token-secret-0010",
    });
    expect(config.transfer).toEqual({ port: 51007, advertise_host: "127.0.0.1" });
    expect(config.subscription_proxy.storage_key).toBe(secrets.subscriptionStorageKey);
  });

  it("points meeting transcription at the local helper only when it is bundled", () => {
    const withHelper = buildBackendConfig({
      secrets,
      ports,
      logsDir: "/data/logs",
      localTranscription: true,
    });
    expect(withHelper.meetings).toEqual({
      asr_template: "local-meeting-asr",
      local_asr: {
        base_url: "http://127.0.0.1:51009/v1",
        api_key: "asr-token-secret-0012",
      },
    });
    expect(config).not.toHaveProperty("meetings");
  });

  it("logs the configuration without any secret", () => {
    const withHelper = buildBackendConfig({
      secrets,
      ports,
      logsDir: "/data/logs",
      localTranscription: true,
    });
    const logged = JSON.stringify(redactSecrets(withHelper, secrets));
    for (const [name, value] of Object.entries(secrets)) {
      if (name !== "version") expect(logged).not.toContain(value);
    }
    expect(redactSecrets(withHelper.comma, secrets)).toMatchInlineSnapshot(`
      {
        "auth": {
          "rate_limit_secret": "[redacted]",
          "redis_url": "redis://:[redacted]@127.0.0.1:51002/0",
          "secret": "[redacted]",
        },
        "database": {
          "pool_size": 8,
          "url": "ecto://postgres:[redacted]@127.0.0.1:51001/comma",
        },
      }
    `);
    expect(redactSecrets(withHelper.meetings, secrets)).toEqual({
      asr_template: "local-meeting-asr",
      local_asr: { base_url: "http://127.0.0.1:51009/v1", api_key: "[redacted]" },
    });
  });
});
