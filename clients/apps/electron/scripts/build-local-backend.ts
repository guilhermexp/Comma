/**
 * Builds the self-contained macOS arm64 local backend that the release app
 * ships in Contents/Resources/local-backend (clients/apps/electron/RELEASE.md).
 *
 *   build-local-backend.ts [deps|release|assemble|smoke|gate|all|release-tree] [--only=a,b]
 *
 * `deps` builds the pinned sources of scripts/local-backend/manifest.json into
 * a prefix named by the hash of the manifest and its build scripts; `release` builds `mix release comma`
 * with that toolchain; `assemble` lays out the bundle tree, signs it ad hoc,
 * runs the Mach-O gate, and smoke-tests the tree with PATH=/usr/bin:/bin;
 * `gate <dir>` runs the gate on any directory; `release-tree` runs `all` when
 * the build's backend mode is local (release:velopack) and nothing otherwise.
 */
import { buildLocalBackendDeps } from "./local-backend/build-deps";
import { assembleLocalBackend, smokeTestLocalBackend } from "./local-backend/assemble";
import { buildBackendRelease } from "./local-backend/build-release";
import { assertRelocatable } from "./local-backend/macho-gate";
import type { localBackendManifest } from "./local-backend/sources";
import { getCommaReleaseConfig } from "../src/release-config";

type SourceName = keyof typeof localBackendManifest.sources;

async function main() {
  const [step = "all", ...rest] = process.argv.slice(2);
  const only = rest
    .find((arg) => arg.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",") as SourceName[] | undefined;
  switch (step) {
    case "deps":
      await buildLocalBackendDeps(only);
      return;
    case "release":
      buildBackendRelease();
      return;
    case "assemble":
      assembleLocalBackend();
      await smokeTestLocalBackend();
      return;
    case "smoke":
      await smokeTestLocalBackend();
      return;
    case "gate": {
      const dir = rest.find((arg) => !arg.startsWith("--"));
      if (!dir) throw new Error("usage: build-local-backend.ts gate <dir>");
      assertRelocatable(dir);
      return;
    }
    case "release-tree":
      if (getCommaReleaseConfig().backendMode !== "local") {
        console.log("Remote backend mode: the release ships no local backend.");
        return;
      }
      await buildLocalBackendDeps();
      buildBackendRelease();
      assembleLocalBackend();
      await smokeTestLocalBackend();
      return;
    case "all":
      await buildLocalBackendDeps();
      buildBackendRelease();
      assembleLocalBackend();
      await smokeTestLocalBackend();
      return;
    default:
      throw new Error(`unknown step ${step}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
