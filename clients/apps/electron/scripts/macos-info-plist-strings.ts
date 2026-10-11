import type { HookFunction } from "@electron/packager";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const catalogDirectory = join(import.meta.dirname, "../../../packages/i18n/messages");

/** Info.plist privacy prompts and the catalog messages that word them. */
const usageDescriptionKeys = {
  NSCameraUsageDescription: "electron_macos_camera_usage",
  NSMicrophoneUsageDescription: "electron_macos_microphone_usage",
  NSAudioCaptureUsageDescription: "electron_macos_audio_capture_usage",
  NSScreenCaptureUsageDescription: "electron_macos_screen_capture_usage",
} as const;

/**
 * App languages other than the Info.plist's own English, by the `.lproj` name
 * Electron already ships for them in `Contents/Resources`.
 */
const localizedBundleLanguages = { "pt-BR": "pt_BR", "zh-CN": "zh_CN" } as const;

/** The privacy prompt texts for one catalog locale, keyed by Info.plist key. */
export function macosUsageDescriptions(
  locale: "en" | keyof typeof localizedBundleLanguages
): Record<keyof typeof usageDescriptionKeys, string> {
  const catalog = JSON.parse(
    readFileSync(join(catalogDirectory, `${locale}.json`), "utf8")
  ) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(usageDescriptionKeys).map(([plistKey, messageKey]) => {
      const text = catalog[messageKey];
      if (typeof text !== "string" || !text)
        throw new Error(`${locale}.json has no plain-text message ${messageKey}.`);
      return [plistKey, text];
    })
  ) as Record<keyof typeof usageDescriptionKeys, string>;
}

/**
 * macOS words a privacy prompt from `<language>.lproj/InfoPlist.strings` when
 * the user's language matches one, and falls back to the Info.plist English.
 * The files must exist before signing so the code seal covers them.
 */
export function macosInfoPlistStringsHook(productName: string): HookFunction {
  return (buildPath, _electronVersion, platform, _arch, callback) => {
    if (platform !== "darwin" && platform !== "mas") {
      callback();
      return;
    }
    try {
      for (const [locale, lproj] of Object.entries(localizedBundleLanguages)) {
        const directory = join(
          buildPath,
          `${productName}.app`,
          "Contents",
          "Resources",
          `${lproj}.lproj`
        );
        mkdirSync(directory, { recursive: true });
        const entries = Object.entries(
          macosUsageDescriptions(locale as keyof typeof localizedBundleLanguages)
        ).map(
          ([plistKey, text]) =>
            `"${plistKey}" = "${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}";\n`
        );
        // UTF-16 with a byte-order mark is the encoding Apple documents for
        // strings files.
        writeFileSync(
          join(directory, "InfoPlist.strings"),
          `\uFEFF${entries.join("")}`,
          "utf16le"
        );
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
