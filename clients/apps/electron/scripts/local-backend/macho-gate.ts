import { isAbsolute, resolve, dirname } from "node:path";
import { listMachOFiles, listSymbolicLinks, readLoadCommands } from "./macho";

export interface ForeignLink {
  file: string;
  reference: string;
  kind: "dependency" | "rpath" | "symlink";
}

const relocatablePrefixes = ["@rpath/", "@loader_path/", "@executable_path/"];
const systemPrefixes = ["/usr/lib/", "/System/"];

function staysInside(reference: string) {
  return (
    relocatablePrefixes.some((prefix) => reference.startsWith(prefix)) ||
    systemPrefixes.some((prefix) => reference.startsWith(prefix))
  );
}

/**
 * Lists every library reference, and every run path an @rpath reference
 * would search, that would load code from outside the bundle and the
 * operating system. A Mac without Homebrew has
 * none of those paths, so any finding means the app works only on the Mac
 * that built it. A dylib's own install name is not a load and is ignored.
 */
export function findForeignLinks(root: string): ForeignLink[] {
  const links: ForeignLink[] = [];
  for (const file of listMachOFiles(root)) {
    const commands = readLoadCommands(file);
    for (const dependency of commands.dependencies) {
      if (dependency === commands.id || staysInside(dependency)) continue;
      links.push({ file, reference: dependency, kind: "dependency" });
    }
    // A run path is searched only for @rpath dependencies; without one, a
    // foreign entry (such as the Xcode Swift path SwiftPM records) is inert.
    if (!commands.dependencies.some((dependency) => dependency.startsWith("@rpath/"))) {
      continue;
    }
    for (const rpath of commands.rpaths) {
      if (staysInside(rpath.endsWith("/") ? rpath : `${rpath}/`)) continue;
      links.push({ file, reference: rpath, kind: "rpath" });
    }
  }
  // A link out of the tree loads whatever that path holds on the user's Mac.
  const inside = `${resolve(root)}/`;
  for (const link of listSymbolicLinks(root)) {
    const target = isAbsolute(link.target)
      ? link.target
      : resolve(dirname(resolve(link.path)), link.target);
    if (!target.startsWith(inside)) {
      links.push({ file: link.path, reference: link.target, kind: "symlink" });
    }
  }
  return links;
}

export function assertRelocatable(root: string) {
  const links = findForeignLinks(root);
  if (links.length === 0) {
    console.log(`Mach-O gate: ${root} references only the bundle and the system.`);
    return;
  }
  const lines = links.map((link) => `  ${link.file}: ${link.kind} ${link.reference}`);
  throw new Error(
    `Mach-O gate: ${links.length} reference(s) outside the bundle and the system:\n${lines.join("\n")}`
  );
}
