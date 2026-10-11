import { legacyCommaLocaleStorageKey, messages, type CommaLocale } from "@comma/i18n";
import { defaultCommaClientSettings } from "@comma/native-bridge";
import { expect, test, type Page } from "@playwright/test";
import { installBrowserTestSession } from "../../../e2e/helpers/browser-auth";
import { webBaseURL } from "../../../e2e/p0/smoke-env";

const session = {
  apiBaseUrl: "http://127.0.0.1:65535",
  email: "i18n-e2e@example.com",
  token: "comma_sess_i18n_e2e",
};

/** This device's browser storage for the app, holding only `entries`. */
function device(entries: Record<string, string> = {}) {
  return {
    cookies: [],
    origins: [
      {
        localStorage: Object.entries(entries).map(([name, value]) => ({ name, value })),
        origin: new URL(webBaseURL).origin,
      },
    ],
  };
}

async function expectShellIn(page: Page, locale: CommaLocale) {
  const options = { locale };
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(
    page.getByRole("link", { exact: true, name: messages.nav_home({}, options) })
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("link", { exact: true, name: messages.nav_inbox({}, options) })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: messages.nav_settings({}, options) })
  ).toBeVisible();
  const [before, after] = messages
    .shell_search_hint({ shortcut: "\u0000" }, options)
    .split("\u0000")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await expect(page.getByTestId("comma-window-bar-search")).toHaveText(
    new RegExp(`^${before}.+${after}$`)
  );
  const home = page.getByTestId("home-responsive-layout");
  await expect(home).toBeVisible();
  await expect(home.getByTestId("home-greet-rail")).toHaveAttribute(
    "aria-label",
    messages.home_greet_panel({}, options)
  );
  await expect(home.getByTestId("chat-empty")).toBeVisible();
  // Home has no route header: its identity lives on the region.
  await expect(
    page.getByRole("region", { name: messages.home_region({}, options) })
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: messages.shell_ai_input({}, options) })
  ).toBeVisible();
  await expect(home.getByTestId("home-tasks-rail")).toHaveAttribute(
    "aria-label",
    messages.tasks_title({}, options)
  );
  await expect(
    home.getByRole("heading", { level: 2, name: messages.tasks_title({}, options) })
  ).toBeVisible();
}

test.describe("app language", () => {
  // Wide enough for every Home rail to stay inline (Tasks folds below a
  // 1037px-wide Home route).
  test.use({ viewport: { width: 1440, height: 900 } });
  // These scenarios are about which language a device gets, so each starts
  // without the suite's English choice (see e2e/helpers/english-locale.ts).
  test.use({ storageState: device() });

  test.describe("on a device that never chose one, with an English browser", () => {
    test.use({ locale: "en-US" });

    test("shows Brazilian Portuguese without localizing hash routes", async ({
      page,
    }) => {
      await installBrowserTestSession(page, session);
      await page.goto("/");

      await expectShellIn(page, "pt-BR");
      await page
        .getByRole("link", {
          exact: true,
          name: messages.nav_inbox({}, { locale: "pt-BR" }),
        })
        .click();
      await expect(page).toHaveURL(/#\/inbox$/);
    });
  });

  test.describe("on a device that never chose one, with a Chinese browser", () => {
    test.use({ locale: "zh-CN" });

    test("still shows Brazilian Portuguese", async ({ page }) => {
      await installBrowserTestSession(page, session);
      await page.goto("/");

      await expectShellIn(page, "pt-BR");
    });
  });

  // Each choice is read with a browser in another language, which it outranks.
  for (const [choice, browser] of [
    ["en", "zh-CN"],
    ["zh-CN", "en-US"],
  ] as const) {
    test.describe(`on a device an older build saved ${choice} on`, () => {
      test.use({
        locale: browser,
        storageState: device({ [legacyCommaLocaleStorageKey]: choice }),
      });

      test(`keeps ${choice}`, async ({ page }) => {
        await installBrowserTestSession(page, session);
        await page.goto("/");

        await expectShellIn(page, choice);
      });
    });
  }

  for (const [browser, shown] of [
    ["zh-CN", "zh-CN"],
    ["en-US", "en"],
  ] as const) {
    test.describe(`on a device that chose System, with a ${browser} browser`, () => {
      test.use({
        locale: browser,
        storageState: device({
          "comma.client-settings": JSON.stringify({
            ...defaultCommaClientSettings,
            localePreference: "system",
          }),
          // Saved since System stopped being the default: the user's choice.
          "comma.client-settings.defaults-revision": "1",
        }),
      });

      test("follows the browser language", async ({ page }) => {
        await installBrowserTestSession(page, session);
        await page.goto("/");

        await expectShellIn(page, shown);
      });
    });
  }

  test.describe("on a device an older build saved System on by default", () => {
    test.use({
      locale: "en-US",
      storageState: device({
        // No defaults revision: System was the default then, not a choice.
        "comma.client-settings": JSON.stringify({
          ...defaultCommaClientSettings,
          localePreference: "system",
        }),
      }),
    });

    test("moves to Brazilian Portuguese", async ({ page }) => {
      await installBrowserTestSession(page, session);
      await page.goto("/");

      await expectShellIn(page, "pt-BR");
    });
  });

  test.describe("switching in Settings", () => {
    test.use({ locale: "en-US" });

    test("moves the whole app to each language and keeps it after reload", async ({
      page,
    }) => {
      await installBrowserTestSession(page, session);
      await page.goto("/#/settings");
      const languageControl = page.locator(
        '[data-setting-id="app.language"] [data-slot="settings-control"] button'
      );
      const expectSettingsIn = async (locale: CommaLocale) => {
        const options = { locale };
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(
          page.getByRole("heading", {
            level: 1,
            name: messages.settings_general({}, options),
          })
        ).toBeVisible();
        // Settings renders inside the shell, so the rail relabels with it.
        await expect(
          page.getByRole("button", {
            exact: true,
            name: messages.nav_settings({}, options),
          })
        ).toHaveAttribute("aria-current", "page");
        await expect(
          page.getByRole("link", { exact: true, name: messages.nav_home({}, options) })
        ).toBeVisible();
      };

      await expectSettingsIn("pt-BR");
      for (const [from, to, option] of [
        ["pt-BR", "en", messages.settings_language_english],
        ["en", "zh-CN", messages.settings_language_simplified_chinese],
        ["zh-CN", "pt-BR", messages.settings_language_portuguese_brazil],
      ] as const) {
        await languageControl.click();
        await page
          .getByRole("option", { exact: true, name: option({}, { locale: from }) })
          .click();
        await expectSettingsIn(to);

        await page.reload();
        await expectSettingsIn(to);
        await expect(languageControl).toContainText(option({}, { locale: to }));
      }
    });
  });
});
