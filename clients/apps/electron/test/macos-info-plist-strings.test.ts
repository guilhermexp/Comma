import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  macosInfoPlistStringsHook,
  macosUsageDescriptions,
} from "../scripts/macos-info-plist-strings";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function runHook(platform: string) {
  const root = await mkdtemp(join(tmpdir(), "comma-info-plist-strings-"));
  roots.push(root);
  await new Promise<void>((resolve, reject) =>
    macosInfoPlistStringsHook("Comma")(root, "0.0.0", platform, "arm64", (error) =>
      error ? reject(error) : resolve()
    )
  );
  return join(root, "Comma.app", "Contents", "Resources");
}

it("words the macOS privacy prompts in each app language the bundle ships", async () => {
  const resources = await runHook("darwin");
  const portuguese = await readFile(
    join(resources, "pt_BR.lproj", "InfoPlist.strings")
  );
  // UTF-16LE with a byte-order mark.
  expect([...portuguese.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const text = portuguese.toString("utf16le");
  expect(text).toContain(
    `"NSMicrophoneUsageDescription" = "${macosUsageDescriptions("pt-BR").NSMicrophoneUsageDescription}";`
  );
  expect(text).toContain("NSAudioCaptureUsageDescription");
  const chinese = (
    await readFile(join(resources, "zh_CN.lproj", "InfoPlist.strings"))
  ).toString("utf16le");
  expect(chinese).toContain(macosUsageDescriptions("zh-CN").NSCameraUsageDescription);
  expect(macosUsageDescriptions("en").NSCameraUsageDescription).toBe(
    "Websites you allow can use your camera for video meetings."
  );
});

it("leaves other platforms' packages untouched", async () => {
  const resources = await runHook("linux");
  expect(existsSync(resources)).toBe(false);
});
