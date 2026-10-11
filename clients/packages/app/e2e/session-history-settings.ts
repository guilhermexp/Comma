import type { BrowserContext } from "@playwright/test";
import { defaultCommaClientSettings } from "@comma/native-bridge";
import { e2eLocale } from "../../../e2e/helpers/english-locale";

/** Session scenarios explicitly opt in; reloads preserve later user changes. */
export async function enableSessionHistory(context: BrowserContext) {
  await context.addInitScript(
    (settings) => {
      if (localStorage.getItem("comma.client-settings") === null)
        localStorage.setItem("comma.client-settings", JSON.stringify(settings));
    },
    {
      ...defaultCommaClientSettings,
      localePreference: e2eLocale,
      sessionHistoryEnabled: true,
    }
  );
}
