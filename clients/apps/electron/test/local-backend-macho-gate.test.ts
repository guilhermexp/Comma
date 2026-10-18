import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRelocatable,
  findForeignLinks,
} from "../scripts/local-backend/macho-gate";

const dirs: string[] = [];
const darwin = process.platform === "darwin";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "comma-macho-gate-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function cc(args: string[], cwd: string) {
  execFileSync("/usr/bin/cc", args, { cwd, stdio: "pipe" });
}

/** An executable linked to a dylib whose install name is the given path. */
function linkedProgram(dir: string, installName: string, rpath?: string) {
  writeFileSync(join(dir, "foo.c"), "int foo(void) { return 1; }\n");
  writeFileSync(
    join(dir, "main.c"),
    "int foo(void); int main(void) { return foo(); }\n"
  );
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  cc(
    ["-dynamiclib", "-o", "lib/libfoo.dylib", "foo.c", "-install_name", installName],
    dir
  );
  cc(
    [
      "-o",
      "bin/program",
      "main.c",
      "lib/libfoo.dylib",
      ...(rpath ? [`-Wl,-rpath,${rpath}`] : []),
    ],
    dir
  );
  rmSync(join(dir, "foo.c"));
  rmSync(join(dir, "main.c"));
}

describe.runIf(darwin)("local backend Mach-O gate", () => {
  it("fails on a binary linked to a Homebrew library", () => {
    const dir = tempDir();
    linkedProgram(dir, "/opt/homebrew/opt/openssl@3/lib/libfoo.dylib");

    expect(findForeignLinks(dir)).toEqual([
      {
        file: join(dir, "bin/program"),
        reference: "/opt/homebrew/opt/openssl@3/lib/libfoo.dylib",
        kind: "dependency",
      },
    ]);
    expect(() => assertRelocatable(dir)).toThrow(
      /1 reference\(s\) outside the bundle and the system/
    );
  });

  it.runIf(existsSync("/opt/homebrew/bin/redis-server"))(
    "fails on a copied Homebrew redis-server",
    () => {
      const dir = tempDir();
      copyFileSync("/opt/homebrew/bin/redis-server", join(dir, "redis-server"));
      expect(findForeignLinks(dir).map((link) => link.reference)).toContainEqual(
        expect.stringMatching(/^\/opt\/homebrew\//)
      );
    }
  );

  it("fails on an absolute run path outside the system", () => {
    const dir = tempDir();
    linkedProgram(dir, "@rpath/libfoo.dylib", "/usr/local/lib");

    expect(findForeignLinks(dir)).toEqual([
      { file: join(dir, "bin/program"), reference: "/usr/local/lib", kind: "rpath" },
    ]);
  });

  it("reads binaries whose names end in parentheses, like Electron's helpers", () => {
    const dir = tempDir();
    linkedProgram(dir, "/opt/homebrew/lib/libfoo.dylib");
    copyFileSync(join(dir, "bin/program"), join(dir, "bin/Comma Helper (GPU)"));
    rmSync(join(dir, "bin/program"));

    expect(findForeignLinks(dir).map((link) => link.file)).toEqual([
      join(dir, "bin/Comma Helper (GPU)"),
    ]);
  });

  it("ignores a foreign run path that no @rpath dependency can use", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "main.c"), "int main(void) { return 0; }\n");
    cc(
      [
        "-o",
        "swift-helper",
        "main.c",
        "-Wl,-rpath,/Applications/Xcode.app/usr/lib/swift",
      ],
      dir
    );
    rmSync(join(dir, "main.c"));

    expect(findForeignLinks(dir)).toEqual([]);
  });

  it("passes binaries that resolve libraries from their own location or the system", () => {
    const dir = tempDir();
    linkedProgram(dir, "@rpath/libfoo.dylib", "@loader_path/../lib");
    copyFileSync("/bin/ls", join(dir, "bin/ls"));
    writeFileSync(
      join(dir, "lib/data.beam"),
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52])
    );

    expect(findForeignLinks(dir)).toEqual([]);
    expect(() => assertRelocatable(dir)).not.toThrow();
  });
});
