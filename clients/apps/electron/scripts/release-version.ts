import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersionPattern = /^\d+\.\d+\.\d+$/u;

/**
 * A desktop release tag is `v<version>` of clients/apps/electron/package.json.
 * Velopack orders updates by that version, so a tag that disagrees with the
 * packaged version would publish a release the feed misorders.
 */
export function resolveReleaseVersion({
  packageVersion,
  tag,
}: {
  packageVersion: string;
  tag?: string | undefined;
}) {
  if (!stableVersionPattern.test(packageVersion)) {
    throw new Error(
      `clients/apps/electron/package.json version must be X.Y.Z, got ${packageVersion}.`
    );
  }
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    throw new Error(
      `Tag ${tag} does not match the app version: expected v${packageVersion}.`
    );
  }
  return { version: packageVersion, tag: `v${packageVersion}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")
    ) as { version: string };
    const tag = process.argv[2]?.trim() || undefined;
    const release = resolveReleaseVersion({
      packageVersion: packageJson.version,
      tag,
    });
    console.log(`Release ${release.tag} (version ${release.version})`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${release.version}\ntag=${release.tag}\n`
      );
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
