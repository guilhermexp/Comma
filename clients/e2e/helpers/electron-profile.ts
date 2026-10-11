import type { CommaLocale } from "@comma/i18n";
import {
  appPreferencesSchema,
  commaClientSettingsSchema,
  defaultAppPreferences,
  defaultCommaClientSettings,
  type CommaClientSettings,
} from "@comma/native-bridge";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e2eLocale } from "./english-locale";

/**
 * Records first-launch onboarding as finished for `userIds` in the Electron
 * profile at `userDataDir`, as the app does when they finish or close it.
 * A signed-in account meets the onboarding until its profile holds this
 * record, and every spec launches from a fresh `--user-data-dir`, so a spec
 * that signs in records it before launch to land on the shell. Onboarding
 * specs leave it out.
 *
 * It writes Main's own preferences file and keeps what the profile already
 * holds; a profile without client settings starts from the defaults with the
 * suite's language, English, chosen (see english-locale.ts). Synchronous, so
 * a launch-environment helper can call it.
 */
export function recordElectronOnboardingCompleted(
  userDataDir: string,
  userIds: readonly string[]
) {
  updateStoredClientSettings(userDataDir, (settings) => ({
    ...settings,
    onboardingCompletedUserIds: [
      ...new Set([...settings.onboardingCompletedUserIds, ...userIds]),
    ],
  }));
}

/**
 * Records `locale` as the app language chosen in the Electron profile at
 * `userDataDir`, as Settings does. Main and every window start in it. Specs
 * that launch without `recordElectronOnboardingCompleted` and read English
 * text pin `e2eLocale` with it: a profile without a choice shows the product
 * default, Brazilian Portuguese.
 */
export function recordElectronLocalePreference(
  userDataDir: string,
  locale: CommaLocale
) {
  updateStoredClientSettings(userDataDir, (settings) => ({
    ...settings,
    localePreference: locale,
  }));
}

function updateStoredClientSettings(
  userDataDir: string,
  update: (settings: CommaClientSettings) => CommaClientSettings
) {
  const filePath = join(userDataDir, "app-preferences.json");
  // Main's own bookkeeping beside the preferences, kept as it is.
  const { defaultsRevision, ...stored } = readStoredPreferences(filePath);
  const preferences = {
    ...stored,
    clientSettings: update(
      commaClientSettingsSchema.parse(
        stored.clientSettings ?? {
          ...defaultCommaClientSettings,
          localePreference: e2eLocale,
        }
      )
    ),
  };
  // Main reads a file it cannot parse as all defaults, which would drop the
  // record without a trace. Refuse to write one.
  appPreferencesSchema.parse(preferences);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      defaultsRevision === undefined
        ? preferences
        : { ...preferences, defaultsRevision },
      null,
      2
    )}\n`
  );
}

/** The file as Main keeps it: stored choices only, no revision or readbacks. */
function readStoredPreferences(
  filePath: string
): Record<string, unknown> & { clientSettings?: unknown } {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { revision: _revision, ...stored } = defaultAppPreferences;
    return stored;
  }
}
