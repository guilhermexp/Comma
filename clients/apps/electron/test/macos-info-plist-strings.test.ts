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

it("asks for the Mac Calendar on every macOS version, saying Comma reads and edits it", async () => {
  const resources = await runHook("darwin");
  const portuguese = (
    await readFile(join(resources, "pt_BR.lproj", "InfoPlist.strings"))
  ).toString("utf16le");
  // macOS 14+ reads the full-access key; macOS 13 and earlier only the other.
  for (const key of [
    "NSCalendarsFullAccessUsageDescription",
    "NSCalendarsUsageDescription",
  ]) {
    expect(portuguese).toContain(`"${key}" = "`);
  }
  const english = macosUsageDescriptions("en");
  expect(english.NSCalendarsFullAccessUsageDescription).toMatch(/reads and edits/);
  expect(english.NSCalendarsUsageDescription).toBe(
    english.NSCalendarsFullAccessUsageDescription
  );
  expect(macosUsageDescriptions("pt-BR").NSCalendarsFullAccessUsageDescription).toMatch(
    /lê e edita/
  );
});

it("leaves other platforms' packages untouched", async () => {
  const resources = await runHook("linux");
  expect(existsSync(resources)).toBe(false);
});

it("tells macOS users Screen Recording covers both meeting audio and the screenshot sent to the agent", () => {
  const prompts = {
    en: [/audio/i, /screenshot/i, /agent/i],
    "pt-BR": [/áudio/i, /print/i, /agente/i],
    "zh-CN": [/音频/, /截图/, /Agent/],
  } as const;
  for (const [locale, patterns] of Object.entries(prompts)) {
    const text = macosUsageDescriptions(
      locale as keyof typeof prompts
    ).NSScreenCaptureUsageDescription;
    for (const pattern of patterns) expect(text).toMatch(pattern);
  }
});
