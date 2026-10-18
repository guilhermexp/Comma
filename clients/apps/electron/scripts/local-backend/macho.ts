import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const thinMagics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const fatMagics = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** True for a Mach-O image or universal binary; reads only the header. */
export function isMachO(path: string): boolean {
  const header = Buffer.alloc(8);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (readSync(fd, header, 0, 8, 0) < 8) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const magic = header.readUInt32BE(0);
  if (thinMagics.has(magic)) return true;
  // Java class files share 0xcafebabe; their next word is a class version,
  // never a small architecture count.
  return (
    fatMagics.has(magic) && header.readUInt32BE(4) > 0 && header.readUInt32BE(4) < 16
  );
}

/** Every regular Mach-O file below root. Symbolic links are not followed. */
export function listMachOFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile() && isMachO(path)) found.push(path);
    }
  };
  walk(root);
  return found.toSorted();
}

export interface MachOLinks {
  /** LC_ID_DYLIB of a dylib; absent for executables and bundles. */
  id?: string | undefined;
  dependencies: string[];
  rpaths: string[];
}

/** Parses `otool -l` output into the load commands the gate and relocation need. */
export function parseLoadCommands(output: string): MachOLinks {
  const dependencies = new Set<string>();
  const rpaths = new Set<string>();
  let id: string | undefined;
  let command: string | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const cmd = /^cmd (\S+)$/.exec(line);
    if (cmd) {
      command = cmd[1];
      continue;
    }
    const name = /^name (.+) \(offset \d+\)$/.exec(line);
    if (name && command) {
      if (command === "LC_ID_DYLIB") id = name[1];
      else if (
        command === "LC_LOAD_DYLIB" ||
        command === "LC_LOAD_WEAK_DYLIB" ||
        command === "LC_REEXPORT_DYLIB" ||
        command === "LC_LOAD_UPWARD_DYLIB" ||
        command === "LC_LAZY_LOAD_DYLIB"
      )
        dependencies.add(name[1]!);
      continue;
    }
    const path = /^path (.+) \(offset \d+\)$/.exec(line);
    if (path && command === "LC_RPATH") rpaths.add(path[1]!);
  }
  return { id, dependencies: [...dependencies], rpaths: [...rpaths] };
}

/** Load commands of every architecture slice of one file. */
export function readLoadCommands(path: string): MachOLinks {
  // otool reads "file (member)" as an archive member, so a name such as
  // "Comma Helper (GPU)" goes through a link without the parentheses.
  if (!path.endsWith(")")) return parseLoadCommands(otool(path));
  const dir = mkdtempSync(join(tmpdir(), "comma-macho-"));
  try {
    const link = join(dir, "binary");
    symlinkSync(path, link);
    return parseLoadCommands(otool(link));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function otool(path: string) {
  return execFileSync("/usr/bin/otool", ["-l", "-arch", "all", path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
