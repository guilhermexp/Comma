export const supportedLocales = ["pt-BR", "en", "zh-CN"] as const;
export type CommaLocale = (typeof supportedLocales)[number];
export type CommaLocalePreference = CommaLocale | "system";

/**
 * The product's interface language: what a device without an explicit choice
 * shows, and where an unsupported system language lands. English stays the
 * catalog's source locale (project.inlang `baseLocale`), not the default.
 */
export const defaultLocale: CommaLocale = "pt-BR";
export const defaultLocalePreference: CommaLocalePreference = defaultLocale;
export const legacyCommaLocaleStorageKey = "comma.locale";

export function resolveLocale(languages: readonly string[]): CommaLocale {
  for (const language of languages) {
    const normalized = language.trim().toLowerCase().replaceAll("_", "-");
    if (
      normalized === "zh-cn" ||
      normalized.startsWith("zh-cn-") ||
      normalized === "zh-sg" ||
      normalized.startsWith("zh-sg-") ||
      normalized === "zh-hans" ||
      normalized.startsWith("zh-hans-")
    ) {
      return "zh-CN";
    }
    if (normalized === "zh" || normalized.startsWith("zh-")) {
      continue;
    }
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
    // Every Portuguese variant reads the Brazilian catalog.
    if (normalized === "pt" || normalized.startsWith("pt-")) {
      return "pt-BR";
    }
  }
  return defaultLocale;
}

export function detectLocale(): CommaLocale {
  if (typeof navigator === "undefined") {
    return defaultLocale;
  }
  return resolveLocale(
    [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  );
}

export function resolveLocalePreference(
  preference: CommaLocalePreference
): CommaLocale {
  return preference === "system" ? detectLocale() : preference;
}

/**
 * Before pt-BR became the default, every saved client-settings snapshot held
 * "system" unless the user chose a language, so a stored "system" from that
 * time is the old default rather than a choice: it takes the current default.
 * Stores apply this once, guarded by their own defaults revision.
 */
export function withCurrentDefaultLocalePreference(
  preference: CommaLocalePreference
): CommaLocalePreference {
  return preference === "system" ? defaultLocalePreference : preference;
}

export function readLegacyCommaLocalePreference(): CommaLocalePreference {
  try {
    const stored = globalThis.localStorage?.getItem(legacyCommaLocaleStorageKey);
    return supportedLocales.includes(stored as CommaLocale)
      ? (stored as CommaLocale)
      : defaultLocalePreference;
  } catch {
    return defaultLocalePreference;
  }
}

export function setDocumentLocale(locale: CommaLocale) {
  if (typeof document === "undefined") return;
  // Writing the same value still invalidates every :lang() style on the page.
  if (document.documentElement.lang !== locale) {
    document.documentElement.lang = locale;
  }
}
