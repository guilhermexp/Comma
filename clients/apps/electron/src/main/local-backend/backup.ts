import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const keptBackups = 3;
const backupPattern = /^comma-\d{8}T\d{6}Z-.+\.dump$/;

function stamp(now: Date) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Dumps the database before a new app version migrates it. A first launch
 * (no previous version) and a relaunch of the same version have nothing to
 * protect. The dump is written beside its final name and renamed only when
 * complete, so a failed dump never counts as a backup or evicts an older one.
 */
export async function backupBeforeUpgrade({
  backupsDir,
  previousVersion,
  currentVersion,
  dump,
  now = new Date(),
}: {
  backupsDir: string;
  previousVersion?: string | undefined;
  currentVersion: string;
  dump: (target: string) => Promise<void>;
  now?: Date;
}): Promise<string | undefined> {
  if (!previousVersion || previousVersion === currentVersion) return undefined;
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const target = join(
    backupsDir,
    `comma-${stamp(now)}-${previousVersion}-to-${currentVersion}.dump`
  );
  const partial = `${target}.partial`;
  try {
    await dump(partial);
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw new Error(
      `Backup before updating ${previousVersion} to ${currentVersion} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  const backups = readdirSync(backupsDir)
    .filter((name) => backupPattern.test(name))
    .toSorted();
  for (const name of backups.slice(0, Math.max(0, backups.length - keptBackups))) {
    const path = join(backupsDir, name);
    if (existsSync(path)) rmSync(path);
  }
  return target;
}
