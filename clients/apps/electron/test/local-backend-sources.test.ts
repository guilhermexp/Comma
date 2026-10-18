import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchPinnedSource,
  localBackendManifest,
  type PinnedSource,
} from "../scripts/local-backend/sources";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "comma-local-backend-sources-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const body = Buffer.from("pinned archive bytes");
const source: PinnedSource = {
  version: "1.0.0",
  url: "https://example.test/archive-1.0.0.tar.gz",
  sha256: createHash("sha256").update(body).digest("hex"),
};

function serving(bytes: Buffer) {
  const requests: string[] = [];
  const fetch = (async (url: string) => {
    requests.push(url);
    return new Response(new Uint8Array(bytes));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("pinned local backend sources", () => {
  it("pins every source to an HTTPS URL and a SHA-256", () => {
    const names = Object.keys(localBackendManifest.sources).toSorted();
    expect(names).toEqual([
      "elixir",
      "libsodium",
      "libuv",
      "minio",
      "openssl",
      "opus",
      "otp",
      "postgres",
      "redis",
    ]);
    for (const pinned of Object.values(localBackendManifest.sources)) {
      expect(pinned.url).toMatch(/^https:\/\//);
      expect(pinned.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("keeps an archive whose SHA-256 matches and reuses it without downloading again", async () => {
    const cacheDir = tempDir();
    const server = serving(body);

    const path = await fetchPinnedSource(source, { cacheDir, fetch: server.fetch });
    expect(readFileSync(path)).toEqual(body);

    const again = await fetchPinnedSource(source, { cacheDir, fetch: server.fetch });
    expect(again).toBe(path);
    expect(server.requests).toEqual([source.url]);
  });

  it("rejects a download whose SHA-256 differs and leaves nothing in the cache", async () => {
    const cacheDir = tempDir();
    const server = serving(Buffer.from("tampered archive bytes"));

    await expect(
      fetchPinnedSource(source, { cacheDir, fetch: server.fetch })
    ).rejects.toThrow(/SHA-256 mismatch for archive-1\.0\.0\.tar\.gz/);
    expect(existsSync(join(cacheDir, "archive-1.0.0.tar.gz"))).toBe(false);
  });

  it("downloads again when the cached archive was altered", async () => {
    const cacheDir = tempDir();
    writeFileSync(join(cacheDir, "archive-1.0.0.tar.gz"), "corrupted");
    const server = serving(body);

    const path = await fetchPinnedSource(source, { cacheDir, fetch: server.fetch });
    expect(readFileSync(path)).toEqual(body);
    expect(server.requests).toHaveLength(1);
  });
});
