import { legacyCommaLocaleStorageKey, type CommaLocale } from "@comma/i18n";

/**
 * The language every E2E scenario runs in. Specs name controls by their
 * English accessible names, while a device that has not chosen a language
 * shows the product default, Brazilian Portuguese. So each test device starts
 * with English chosen, stored where the app itself keeps that choice. Specs
 * about the app language (packages/app/e2e/i18n.spec.ts, the language test in
 * apps/electron/e2e/app-preferences-lifecycle.spec.ts) start without it.
 */
export const e2eLocale: CommaLocale = "en";

/**
 * Browser storage holding that choice for the app served at `url`, for
 * Playwright's `storageState`. It is the legacy `comma.locale` store, which
 * the app carries into its client settings, so a spec still starts from a
 * device without client settings, as specs of the other legacy stores need.
 */
export function englishWebStorageState(url: string) {
  return {
    cookies: [],
    origins: [
      {
        localStorage: [{ name: legacyCommaLocaleStorageKey, value: e2eLocale }],
        origin: new URL(url).origin,
      },
    ],
  };
}
