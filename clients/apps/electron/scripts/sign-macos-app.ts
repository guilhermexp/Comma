import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { arch, platform } from "node:process";
import { basename, resolve } from "node:path";
import { sign } from "@electron/osx-sign";
import { getPackableReleaseConfig } from "../src/release-config";
import {
  packagedComputerUseAppPath,
  packagedNotchHostPath,
  packagedSideChatHostAppPath,
  packagedSleepGuardPath,
} from "./native-paths";
import { resolveMacosSigning, type MacosSigning } from "./macos-signing";

const appDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appDir, "../../..");
const releaseConfig = getPackableReleaseConfig();
const forgePlatform = process.env.COMMA_FORGE_PLATFORM ?? platform;
const forgeArch = process.env.COMMA_FORGE_ARCH ?? arch;
const outDir = process.env.COMMA_FORGE_OUT_DIR ?? resolve(appDir, "out");
const entitlements = resolve(appDir, "build/entitlements.mac.entitlements");
const computerUsePackageScript = resolve(
  repoRoot,
  "systems/connector/salix-connect/scripts/package-computer-use-helper.sh"
);

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
    const path = resolve(root, entry);
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

function resolveAppBundle() {
  const bundleName = `${releaseConfig.productName}.app`;
  const exact = resolve(
    outDir,
    `${releaseConfig.productName}-${forgePlatform}-${forgeArch}`,
    bundleName
  );

  if (existsSync(exact)) {
    return exact;
  }

  const discovered = findAppBundle(outDir, bundleName);
  if (discovered) {
    return discovered;
  }

  throw new Error(`Cannot find ${bundleName} under ${outDir}`);
}

function signNestedHelperApp(helperApp: string, signing: MacosSigning) {
  if (!existsSync(helperApp)) {
    throw new Error(`Cannot find helper app at ${helperApp}`);
  }

  console.log(`Signing helper app: ${basename(helperApp)}`);
  run("bash", [
    computerUsePackageScript,
    "--sign-only",
    "--app-path",
    helperApp,
    "--sign-identity",
    signing.identity,
    ...(signing.keychain ? ["--keychain", signing.keychain] : []),
    ...(signing.developerId ? ["--hardened-runtime", "--timestamp"] : []),
    "--entitlements",
    entitlements,
  ]);
}

async function main() {
  if (forgePlatform !== "darwin") {
    return;
  }

  const signing = resolveMacosSigning(process.env);
  const app = resolveAppBundle();
  const notchHost = packagedNotchHostPath(app);
  const computerUseHelper = packagedComputerUseAppPath(app, forgePlatform, forgeArch);
  const sideChatHelper = packagedSideChatHostAppPath(app);
  const binaries = [notchHost, packagedSleepGuardPath(app)].filter((path) =>
    existsSync(path)
  );

  signNestedHelperApp(computerUseHelper, signing);
  signNestedHelperApp(sideChatHelper, signing);

  console.log(`Signing ${app} ${signing.developerId ? "with Developer ID" : "ad hoc"}`);
  for (const binary of binaries) {
    console.log(`Signing extra binary: ${basename(binary)}`);
  }

  await sign({
    app,
    identity: signing.identity,
    // An ad hoc identity is not a keychain certificate to look up.
    identityValidation: signing.developerId,
    ...(signing.keychain ? { keychain: signing.keychain } : {}),
    platform: "darwin",
    // Hardened runtime matters only for notarization. Ad hoc code has no team
    // ID, so library validation would refuse Electron's own frameworks.
    optionsForFile: () => ({
      hardenedRuntime: signing.developerId,
      entitlements,
      ...(signing.developerId ? {} : { timestamp: "none" }),
    }),
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    binaries,
    // The local backend's binaries are signed ad hoc when the tree is
    // assembled (scripts/local-backend/assemble.ts); the app seal covers them.
    ignore: (filePath) =>
      /\.(pak|bin|dat)$/u.test(filePath) ||
      filePath.includes("/Contents/Resources/local-backend/"),
  });

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  console.log(`Signed and verified ${app}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
