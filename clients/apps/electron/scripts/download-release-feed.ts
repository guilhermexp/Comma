import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackableReleaseConfig } from "../src/release-config";

/**
 * Fetches the latest published release's feed and full package into the
 * Velopack output directory, so `vpk pack` can build a delta against it. The
 * first release finds nothing and packs a full package only.
 *
 * `COMMA_RELEASE_FEED_URL` reads an HTTP feed laid out like GitHub's
 * `releases/latest/download` instead, for local update rehearsals.
 */
export function releaseFeedDownloadArgs({
  channel,
  outputDir,
  repository,
  feedUrl,
}: {
  channel: string;
  outputDir: string;
  repository: string;
  feedUrl?: string | undefined;
}) {
  const common = ["--channel", channel, "--outputDir", outputDir];
  if (feedUrl) {
    return ["download", "http", "--url", feedUrl, ...common];
  }
  // vpk reads the token from its argument only; the public repository also
  // answers without one, at a lower API rate limit.
  return [
    "download",
    "github",
    "--repoUrl",
    `https://github.com/${repository}`,
    ...common,
  ];
}

export async function downloadExistingReleaseFeed() {
  const releaseConfig = getPackableReleaseConfig();
  const appDir = resolve(import.meta.dirname, "..");
  const outputDir = resolve(
    appDir,
    process.env.COMMA_RELEASES_DIR ?? "Releases",
    releaseConfig.releaseChannel
  );
  mkdirSync(outputDir, { recursive: true });

  const feedUrl = process.env.COMMA_RELEASE_FEED_URL?.trim() || undefined;
  if (feedUrl) {
    // `vpk download github` treats a repository without releases as a first
    // release; `vpk download http` fails on the 404 instead.
    const feed = `${feedUrl.replace(/\/+$/u, "")}/releases.${releaseConfig.releaseChannel}.json`;
    const response = await fetch(feed, { method: "HEAD" });
    if (response.status === 404) {
      console.log(`No previous release at ${feed}; packing a full package only.`);
      return;
    }
  }

  const args = releaseFeedDownloadArgs({
    channel: releaseConfig.releaseChannel,
    outputDir,
    repository: releaseConfig.releaseRepository,
    feedUrl,
  });
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token && args[1] === "github") {
    args.push("--token", token);
  }

  const result = spawnSync("vpk", [...args, "--skip-updates", "true"], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`vpk download exited with status ${result.status ?? "unknown"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  downloadExistingReleaseFeed().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
