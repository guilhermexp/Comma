import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";
import { getPackableReleaseConfig } from "../src/release-config";
import { resolveMacosSigning } from "./macos-signing";

interface PackageJson {
  version?: string;
}

const appDir = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(appDir, "package.json"), "utf-8")
) as PackageJson;

const releaseConfig = getPackableReleaseConfig();
const appName = releaseConfig.productName;
const packId = process.env.COMMA_PACK_ID ?? releaseConfig.packId;
const packTitle = process.env.COMMA_PACK_TITLE ?? releaseConfig.productName;
const packVersion = process.env.COMMA_PACK_VERSION ?? packageJson.version ?? "0.0.0";
const outputDir = resolve(
  appDir,
  process.env.COMMA_RELEASES_DIR ?? "Releases",
  releaseConfig.releaseChannel
);
const forgePlatform = process.env.COMMA_FORGE_PLATFORM ?? platform;
const forgeArch = process.env.COMMA_FORGE_ARCH ?? arch;
const forgePackageDir = resolve(
  appDir,
  "out",
  `${appName}-${forgePlatform}-${forgeArch}`
);
const mainExe =
  process.env.COMMA_MAIN_EXE ??
  (forgePlatform === "win32"
    ? `${releaseConfig.executableName}.exe`
    : forgePlatform === "darwin"
      ? releaseConfig.executableName
      : undefined);

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

function listOutEntries() {
  const outDir = resolve(appDir, "out");
  if (!existsSync(outDir)) {
    return "out directory does not exist";
  }

  return readdirSync(outDir).join(", ");
}

function resolvePackDir() {
  if (process.env.COMMA_PACK_DIR) {
    return resolve(appDir, process.env.COMMA_PACK_DIR);
  }

  if (forgePlatform !== "darwin") {
    return forgePackageDir;
  }

  const bundleName = `${appName}.app`;
  const candidates = [
    resolve(forgePackageDir, bundleName),
    resolve(
      appDir,
      "out",
      `${releaseConfig.packageName}-${forgePlatform}-${forgeArch}`,
      bundleName
    ),
    resolve(
      appDir,
      "out",
      `${releaseConfig.executableName}-${forgePlatform}-${forgeArch}`,
      bundleName
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const searchRoots = [resolve(appDir, "out"), resolve(appDir, "..", "..")];
  for (const root of searchRoots) {
    const discovered = findAppBundle(root, bundleName);
    if (discovered) {
      return discovered;
    }
  }

  throw new Error(
    `Velopack packDir does not exist. Tried ${candidates.join(", ")}. ` +
      `Current out entries: ${listOutEntries()}`
  );
}

const packDir = resolvePackDir();

const args = [
  "pack",
  "--packId",
  packId,
  "--packTitle",
  packTitle,
  "--packVersion",
  packVersion,
  "--channel",
  releaseConfig.releaseChannel,
  "--packDir",
  packDir,
  "--outputDir",
  outputDir,
];

if (mainExe) {
  args.push("--mainExe", mainExe);
}

if (forgePlatform === "darwin") {
  // Comma distributes macOS first installs as DMGs, not Velopack PKGs.
  args.push("--noInst", "true");

  const signing = resolveMacosSigning(process.env);
  // Velopack adds its updater to the bundle, so it must sign the bundle again.
  // It signs with the hardened runtime; the ad hoc entitlements disable the
  // library validation that ad hoc code cannot pass.
  args.push(
    "--signAppIdentity",
    signing.identity,
    "--signEntitlements",
    resolve(
      appDir,
      signing.developerId
        ? "build/entitlements.mac.entitlements"
        : "build/entitlements.mac.adhoc.entitlements"
    ),
    "--signDisableDeep",
    "true"
  );
  if (signing.keychain) {
    args.push("--keychain", signing.keychain);
  }
  if (signing.notaryProfile) {
    args.push("--notaryProfile", signing.notaryProfile);
  }
}

console.log(`Packing ${packId} ${packVersion} (${releaseConfig.releaseChannel})`);
console.log(`packDir: ${packDir}`);
console.log(`outputDir: ${outputDir}`);

const result = spawnSync("vpk", [...args, "--skip-updates", "true"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(`vpk exited with status ${result.status ?? "unknown"}`);
}
