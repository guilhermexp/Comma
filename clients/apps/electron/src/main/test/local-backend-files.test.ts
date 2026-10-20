import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureLocalBackendSecrets,
  readLocalBackendState,
  writeLocalBackendState,
} from "../local-backend/files";

const dirs: string[] = [];

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "comma-local-backend-files-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("local backend secrets", () => {
  it("generates distinct random secrets on the first launch, readable only by the user", () => {
    const dir = dataDir();
    const secrets = ensureLocalBackendSecrets(dir);

    const values = Object.entries(secrets)
      .filter(([key]) => key !== "version")
      .map(([, value]) => value as string);
    expect(values.length).toBeGreaterThanOrEqual(10);
    for (const value of values) expect(value.length).toBeGreaterThanOrEqual(32);
    expect(new Set(values).size).toBe(values.length);
    expect(Buffer.from(secrets.subscriptionStorageKey, "base64")).toHaveLength(32);
    expect(mode(join(dir, "secrets.json"))).toBe(0o600);

    const otherInstall = ensureLocalBackendSecrets(dataDir());
    expect(otherInstall.adminToken).not.toBe(secrets.adminToken);
  });

  it("reuses the existing secrets and restores 0600 on the file", () => {
    const dir = dataDir();
    const first = ensureLocalBackendSecrets(dir);
    chmodSync(join(dir, "secrets.json"), 0o644);

    expect(ensureLocalBackendSecrets(dir)).toEqual(first);
    expect(mode(join(dir, "secrets.json"))).toBe(0o600);
  });

  it("generates the transcription token once and keeps it across launches", () => {
    const dir = dataDir();
    const first = ensureLocalBackendSecrets(dir);
    expect(first.asrToken).toMatch(/^[0-9a-f]{64}$/);

    expect(ensureLocalBackendSecrets(dir).asrToken).toBe(first.asrToken);
    expect(mode(join(dir, "secrets.json"))).toBe(0o600);

    // An installation from before local transcription gains only the new token.
    const { asrToken: _missing, ...older } = first;
    writeFileSync(join(dir, "secrets.json"), JSON.stringify(older), { mode: 0o600 });
    const upgraded = ensureLocalBackendSecrets(dir);
    expect(upgraded.asrToken).toMatch(/^[0-9a-f]{64}$/);
    expect({ ...upgraded, asrToken: first.asrToken }).toEqual(first);
    expect(mode(join(dir, "secrets.json"))).toBe(0o600);
  });

  it("adds only missing secrets and never regenerates the subscription storage key", () => {
    const dir = dataDir();
    const first = ensureLocalBackendSecrets(dir);
    const { adminToken: _dropped, ...partial } = first;
    writeFileSync(join(dir, "secrets.json"), JSON.stringify(partial), { mode: 0o600 });

    const second = ensureLocalBackendSecrets(dir);
    expect(second.subscriptionStorageKey).toBe(first.subscriptionStorageKey);
    expect(second.postgresPassword).toBe(first.postgresPassword);
    expect(second.adminToken).toMatch(/.{32,}/);
    expect(second.adminToken).not.toBe(first.adminToken);
  });

  it("refuses an unreadable secrets file instead of replacing the sealed-data key", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "secrets.json"), "{not json", { mode: 0o600 });

    expect(() => ensureLocalBackendSecrets(dir)).toThrow(/secrets\.json is not valid/);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toBe("{not json");
  });
});

describe("local backend state", () => {
  it("starts empty and round-trips ports, processes, the app version, and the owner", () => {
    const dir = dataDir();
    expect(readLocalBackendState(dir)).toEqual({
      version: 1,
      ports: {},
      processes: {},
    });

    const state = {
      version: 1 as const,
      appVersion: "0.0.3",
      ownerUserId: "user-1",
      ports: { postgres: 50001, comma: 50002 },
      processes: { postgres: { pid: 123, executable: "/App/postgres" } },
    };
    writeLocalBackendState(dir, state);

    expect(readLocalBackendState(dir)).toEqual(state);
    expect(mode(join(dir, "state.json"))).toBe(0o600);
  });

  it("treats a damaged state file as empty because it holds only rebuildable facts", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "state.json"), "garbage");
    expect(readLocalBackendState(dir)).toEqual({
      version: 1,
      ports: {},
      processes: {},
    });
  });
});
