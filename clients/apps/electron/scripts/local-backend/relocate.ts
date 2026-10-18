import { execFileSync } from "node:child_process";
import { basename, dirname, relative } from "node:path";
import { listMachOFiles, readLoadCommands } from "./macho";

/**
 * Rewrites the absolute install names that a `./configure --prefix` build
 * records under `root` into `@rpath` names resolved from the binary's own
 * location. The tree can then move into the app bundle unchanged.
 */
export function relocateMachOTree(root: string, { libDir }: { libDir: string }) {
  for (const file of listMachOFiles(root)) {
    const links = readLoadCommands(file);
    const args: string[] = [];
    if (links.id?.startsWith(`${root}/`)) {
      args.push("-id", `@rpath/${basename(links.id)}`);
    }
    let usesRpath = false;
    for (const dependency of links.dependencies) {
      if (!dependency.startsWith(`${root}/`)) continue;
      args.push("-change", dependency, `@rpath/${basename(dependency)}`);
      usesRpath = true;
    }
    for (const rpath of links.rpaths) {
      if (rpath.startsWith("/") && !rpath.startsWith("/usr/lib")) {
        args.push("-delete_rpath", rpath);
      }
    }
    const loaderRpath = `@loader_path/${relative(dirname(file), libDir) || "."}`;
    if (usesRpath && !links.rpaths.includes(loaderRpath)) {
      args.push("-add_rpath", loaderRpath);
    }
    if (args.length === 0) continue;
    execFileSync("/usr/bin/install_name_tool", [...args, file], { stdio: "pipe" });
    // install_name_tool invalidates the linker's ad hoc signature, and arm64
    // refuses to run unsigned code.
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", file], {
      stdio: "pipe",
    });
  }
}
