import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { arch as hostArch, platform as hostPlatform } from "node:process";
import { tmpdir } from "node:os";
import { notarize } from "@electron/notarize";
import { getPackableReleaseConfig } from "../src/release-config";
import { resolveMacosSigning } from "./macos-signing";
import {
  getDmgArtifactName,
  getReleaseArtifactBaseName,
  normalizeReleaseArtifactNames,
  stageGithubReleaseAssets,
  validateReleaseArtifacts,
} from "./release-artifacts";

interface PackageJson {
  version?: string;
}

const appDir = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(appDir, "package.json"), "utf-8")
) as PackageJson;
const releaseConfig = getPackableReleaseConfig();
const forgePlatform = process.env.COMMA_FORGE_PLATFORM ?? hostPlatform;
const forgeArch = process.env.COMMA_FORGE_ARCH ?? hostArch;
const outDir = process.env.COMMA_FORGE_OUT_DIR ?? resolve(appDir, "out");
const packVersion = process.env.COMMA_PACK_VERSION ?? packageJson.version ?? "0.0.0";
const releasesDir = resolve(appDir, process.env.COMMA_RELEASES_DIR ?? "Releases");
const releaseOutputDir = resolve(releasesDir, releaseConfig.releaseChannel);
/** Exactly the files one GitHub release publishes; see stageGithubReleaseAssets. */
const githubAssetsDir = resolve(releasesDir, "github");

function listDirectory(path: string) {
  if (!existsSync(path)) {
    return "<missing>";
  }

  return readdirSync(path).join(", ") || "<empty>";
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function findAppBundle(root: string, bundleName: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".git" || entry === "Releases") {
      continue;
    }

    const path = join(root, entry);
    const stats = statSync(path);

    if (stats.isDirectory() && entry === bundleName) {
      return path;
    }

    if (stats.isDirectory()) {
      const nested = findAppBundle(path, bundleName);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function resolvePackDir() {
  if (forgePlatform !== "darwin") {
    return resolve(
      outDir,
      `${releaseConfig.productName}-${forgePlatform}-${forgeArch}`
    );
  }

  const bundleName = `${releaseConfig.productName}.app`;
  const searchRoots = [outDir, appDir, resolve(appDir, "..", "..", "..")];

  for (const root of searchRoots) {
    const discovered = findAppBundle(root, bundleName);
    if (discovered) {
      return discovered;
    }
  }

  throw new Error(
    `Electron Forge package output does not contain ${bundleName}. ` +
      `out entries: ${listDirectory(outDir)}`
  );
}

function findPortableZip() {
  const portableZip = resolve(
    releaseOutputDir,
    `${getReleaseArtifactBaseName(packVersion)}.zip`
  );

  if (!existsSync(portableZip)) {
    throw new Error(`Velopack portable zip not found: ${portableZip}`);
  }

  return portableZip;
}

function findExtractedApp(root: string) {
  const appBundle = readdirSync(root).find(
    (entry) => entry.endsWith(".app") && statSync(resolve(root, entry)).isDirectory()
  );

  if (!appBundle) {
    throw new Error(`Portable zip did not contain an app bundle: ${root}`);
  }

  return resolve(root, appBundle);
}

/**
 * Builds the first-install DMG from the Velopack portable app, so the app a
 * user drags to Applications already carries Velopack's updater. Developer ID
 * releases also sign the DMG, and notarize and staple it when a notarytool
 * profile is configured; ad hoc releases ship the DMG unsigned.
 */
async function createDmg() {
  if (forgePlatform !== "darwin") {
    return undefined;
  }

  const signing = resolveMacosSigning(process.env);
  const tempDir = mkdtempSync(join(tmpdir(), "comma-dmg-"));
  const stagingDir = resolve(tempDir, "staging");
  const portableDir = resolve(tempDir, "portable");
  const tempDmgPath = resolve(tempDir, `${releaseConfig.productName}.dmg`);

  try {
    const portableZip = findPortableZip();

    run("mkdir", ["-p", portableDir, stagingDir]);
    run("ditto", ["-x", "-k", portableZip, portableDir]);

    const portableApp = findExtractedApp(portableDir);
    if (signing.notaryProfile) {
      run("xcrun", ["stapler", "validate", portableApp]);
    }
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", portableApp]);

    const appCopyPath = resolve(stagingDir, basename(portableApp));
    run("ditto", [portableApp, appCopyPath]);
    symlinkSync("/Applications", resolve(stagingDir, "Applications"));

    console.log(`Creating DMG ${tempDmgPath}`);
    run("hdiutil", [
      "create",
      "-volname",
      releaseConfig.productName,
      "-srcfolder",
      stagingDir,
      "-ov",
      "-format",
      "UDZO",
      tempDmgPath,
    ]);

    if (signing.developerId) {
      console.log(`Signing DMG ${tempDmgPath}`);
      run("codesign", [
        "--sign",
        signing.identity,
        ...(signing.keychain ? ["--keychain", signing.keychain] : []),
        "--timestamp",
        tempDmgPath,
      ]);
    }

    if (signing.notaryProfile) {
      console.log(`Notarizing DMG ${tempDmgPath}`);
      await notarize({
        appPath: tempDmgPath,
        keychainProfile: signing.notaryProfile,
        ...(signing.keychain ? { keychain: signing.keychain } : {}),
      });

      console.log(`Stapling DMG ${tempDmgPath}`);
      run("xcrun", ["stapler", "staple", tempDmgPath]);
      run("xcrun", ["stapler", "validate", tempDmgPath]);
    }

    run("mkdir", ["-p", releaseOutputDir]);

    const dmgName = getDmgArtifactName({ arch: forgeArch });
    const dmgPath = resolve(releaseOutputDir, dmgName);
    renameSync(tempDmgPath, dmgPath);
    console.log(`DMG created: ${dmgPath}`);
    return dmgName;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`Forge appDir: ${appDir}`);
  console.log(`Forge outDir: ${outDir}`);
  console.log(`Forge out entries: ${listDirectory(outDir)}`);

  const packDir = resolvePackDir();

  if (!existsSync(packDir)) {
    throw new Error(`Resolved Velopack packDir does not exist: ${packDir}`);
  }

  const packResult = spawnSync("pnpm", ["pack:velopack"], {
    cwd: appDir,
    env: {
      ...process.env,
      COMMA_PACK_DIR: packDir,
    },
    stdio: "inherit",
  });

  if (packResult.error) {
    throw packResult.error;
  }

  if (packResult.status !== 0) {
    throw new Error(`pnpm pack:velopack exited with status ${packResult.status}`);
  }

  normalizeReleaseArtifactNames({
    releaseOutputDir,
    packVersion,
    releaseChannel: releaseConfig.releaseChannel,
  });
  await validateReleaseArtifacts({
    releaseOutputDir,
    releaseChannel: releaseConfig.releaseChannel,
    packVersion,
  });
  const dmgName = await createDmg();
  if (!dmgName) {
    return;
  }
  const files = stageGithubReleaseAssets({
    releaseOutputDir,
    releaseChannel: releaseConfig.releaseChannel,
    packVersion,
    dmgName,
    stageDir: githubAssetsDir,
  });
  console.log(`GitHub release assets in ${githubAssetsDir}:`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
