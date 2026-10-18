import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupBeforeUpgrade } from "../local-backend/backup";

const dirs: string[] = [];

function backupsDir() {
  const dir = mkdtempSync(join(tmpdir(), "comma-local-backend-backups-"));
  dirs.push(dir);
  return join(dir, "backups");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const dumpWriting =
  (contents = "dump") =>
  async (target: string) => {
    writeFileSync(target, contents);
  };

describe("database backup before an app update", () => {
  it("does not back up a first launch or a launch of the same version", async () => {
    const dir = backupsDir();
    const dumps: string[] = [];
    const dump = async (target: string) => {
      dumps.push(target);
    };

    expect(
      await backupBeforeUpgrade({ backupsDir: dir, currentVersion: "0.0.3", dump })
    ).toBeUndefined();
    expect(
      await backupBeforeUpgrade({
        backupsDir: dir,
        previousVersion: "0.0.3",
        currentVersion: "0.0.3",
        dump,
      })
    ).toBeUndefined();
    expect(dumps).toEqual([]);
  });

  it("writes a dump named for both versions when the version changes", async () => {
    const dir = backupsDir();
    const path = await backupBeforeUpgrade({
      backupsDir: dir,
      previousVersion: "0.0.2",
      currentVersion: "0.0.3",
      dump: dumpWriting(),
      now: new Date("2026-10-17T12:00:00.000Z"),
    });

    expect(path).toBe(join(dir, "comma-20261017T120000Z-0.0.2-to-0.0.3.dump"));
    expect(readdirSync(dir)).toEqual(["comma-20261017T120000Z-0.0.2-to-0.0.3.dump"]);
  });

  it("keeps the three most recent backups", async () => {
    const dir = backupsDir();
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "comma-20260101T000000Z-0.0.1-to-0.0.2.dump",
      "comma-20260201T000000Z-0.0.2-to-0.0.3.dump",
      "comma-20260301T000000Z-0.0.3-to-0.0.4.dump",
      "notes.txt",
    ]) {
      writeFileSync(join(dir, name), "old");
    }

    await backupBeforeUpgrade({
      backupsDir: dir,
      previousVersion: "0.0.4",
      currentVersion: "0.0.5",
      dump: dumpWriting(),
      now: new Date("2026-10-17T12:00:00.000Z"),
    });

    expect(readdirSync(dir).toSorted()).toEqual([
      "comma-20260201T000000Z-0.0.2-to-0.0.3.dump",
      "comma-20260301T000000Z-0.0.3-to-0.0.4.dump",
      "comma-20261017T120000Z-0.0.4-to-0.0.5.dump",
      "notes.txt",
    ]);
  });

  it("fails clearly and keeps older backups when the dump fails", async () => {
    const dir = backupsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "comma-20260301T000000Z-0.0.3-to-0.0.4.dump"), "old");

    await expect(
      backupBeforeUpgrade({
        backupsDir: dir,
        previousVersion: "0.0.4",
        currentVersion: "0.0.5",
        dump: async (target) => {
          writeFileSync(target, "partial");
          throw new Error("pg_dump exited with status 1");
        },
        now: new Date("2026-10-17T12:00:00.000Z"),
      })
    ).rejects.toThrow(
      "Backup before updating 0.0.4 to 0.0.5 failed: pg_dump exited with status 1"
    );
    expect(readdirSync(dir)).toEqual(["comma-20260301T000000Z-0.0.3-to-0.0.4.dump"]);
    expect(existsSync(join(dir, "comma-20261017T120000Z-0.0.4-to-0.0.5.dump"))).toBe(
      false
    );
  });
});
