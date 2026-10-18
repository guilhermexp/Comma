import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import manifest from "./manifest.json";

export interface PinnedSource {
  version: string;
  url: string;
  sha256: string;
}

export type LocalBackendSourceName = keyof typeof manifest.sources;

export const localBackendManifest: {
  version: number;
  sources: Record<LocalBackendSourceName, PinnedSource>;
} = manifest;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export function sourceArchiveName(source: PinnedSource) {
  return basename(new URL(source.url).pathname);
}

/**
 * Returns the cached archive of a pinned source, downloading it first when the
 * cache has none or holds different bytes. A download is written beside the
 * cache entry and only renamed into place after its SHA-256 matches the pin, so
 * a tampered or truncated archive never reaches a build step.
 */
export async function fetchPinnedSource(
  source: PinnedSource,
  {
    cacheDir,
    fetch: request = fetch,
  }: { cacheDir: string; fetch?: typeof fetch | undefined }
): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const name = sourceArchiveName(source);
  const target = join(cacheDir, name);
  if (existsSync(target) && (await sha256File(target)) === source.sha256) {
    return target;
  }
  rmSync(target, { force: true });

  console.log(`Fetching ${source.url}`);
  const response = await request(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Fetching ${source.url} failed: HTTP ${response.status}`);
  }
  const partial = `${target}.partial`;
  await writeFile(partial, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256File(partial);
  if (actual !== source.sha256) {
    rmSync(partial, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${name}: expected ${source.sha256}, got ${actual}.`
    );
  }
  renameSync(partial, target);
  return target;
}
