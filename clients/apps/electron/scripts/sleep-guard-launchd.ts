import type { HookFunction } from "@electron/packager";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepGuardPlistName, sleepGuardServiceName } from "../native/macos/SleepGuard";
import { sleepGuardAddonName, sleepGuardBinaryName } from "./native-paths";

/**
 * The root daemon accepts a client by its signing team. Ad hoc code has no
 * team, and its identifier alone is something any local process can claim, so
 * a packaged release ships the daemon only when it is Developer ID signed.
 * Dev builds keep the identifier check for local work on the feature.
 */
export function shipsSleepGuard({
  flavor,
  developerId,
}: {
  flavor: string;
  developerId: boolean;
}) {
  return flavor === "dev" || developerId;
}

/**
 * Writes the LaunchDaemon plist `SMAppService.daemon(plistName:)` looks for in
 * `Contents/Library/LaunchDaemons`. It must exist before signing so the code
 * seal covers it. Without `ship`, it removes the daemon and its addon instead,
 * and the app reports lid-closed keep-awake unavailable.
 */
export function sleepGuardLaunchdHook(
  productName: string,
  appBundleId: string,
  ship = true
): HookFunction {
  return (buildPath, _electronVersion, platform, _arch, callback) => {
    if (platform !== "darwin") {
      callback();
      return;
    }
    try {
      if (!ship) {
        const native = join(
          buildPath,
          `${productName}.app`,
          "Contents",
          "Resources",
          "native",
          "macos"
        );
        rmSync(join(native, sleepGuardBinaryName), { force: true });
        rmSync(join(native, sleepGuardAddonName), { force: true });
        callback();
        return;
      }
      const directory = join(
        buildPath,
        `${productName}.app`,
        "Contents",
        "Library",
        "LaunchDaemons"
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, sleepGuardPlistName(appBundleId)),
        sleepGuardLaunchdPlist(appBundleId)
      );
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

export function sleepGuardLaunchdPlist(appBundleId: string) {
  const label = sleepGuardServiceName(appBundleId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>BundleProgram</key>
  <string>Contents/Resources/native/macos/${sleepGuardBinaryName}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>MachServices</key>
  <dict>
    <key>${label}</key>
    <true/>
  </dict>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${appBundleId}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COMMA_SLEEP_GUARD_SERVICE</key>
    <string>${label}</string>
    <key>COMMA_SLEEP_GUARD_CLIENT</key>
    <string>${appBundleId}</string>
  </dict>
</dict>
</plist>
`;
}
