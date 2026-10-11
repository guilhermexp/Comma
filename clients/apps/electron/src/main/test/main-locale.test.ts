import { initializeCommaI18n, messages } from "@comma/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { initializeElectronMainI18n } from "../main-locale";

afterEach(() => {
  initializeCommaI18n(["en"]);
});

describe("initializeElectronMainI18n", () => {
  it.each(
    [
      { appLocale: "en-US", preferredSystemLanguages: ["en-US"] },
      { appLocale: "zh-CN", preferredSystemLanguages: ["zh-CN"] },
      { appLocale: "fr-FR", preferredSystemLanguages: [] },
    ].map((row) => [row.appLocale, row] as [string, typeof row])
  )(
    "starts a device without a stored language in Brazilian Portuguese on a %s system",
    (_name, { appLocale, preferredSystemLanguages }) => {
      expect(initializeElectronMainI18n({ appLocale, preferredSystemLanguages })).toBe(
        "pt-BR"
      );
      expect(messages.nav_inbox()).toBe("Entrada");
    }
  );

  it.each(
    [
      {
        name: "prefers the Electron app locale selected by --lang over OS preferences",
        appLocale: "zh-CN",
        preferredSystemLanguages: ["en-US"],
        expected: "zh-CN",
        inbox: "收件箱",
      },
      {
        name: "keeps an English app locale ahead of a Simplified Chinese OS preference",
        appLocale: "en-US",
        preferredSystemLanguages: ["zh-CN"],
        expected: "en",
        inbox: "Inbox",
      },
      {
        name: "falls through an unsupported app locale to a supported OS preference",
        appLocale: "fr-FR",
        preferredSystemLanguages: ["zh-SG", "en-US"],
        expected: "zh-CN",
        inbox: "收件箱",
      },
      {
        name: "follows a Brazilian Portuguese system",
        appLocale: "pt-BR",
        preferredSystemLanguages: ["en-US"],
        expected: "pt-BR",
        inbox: "Entrada",
      },
      {
        name: "uses the product default for an unsupported system language",
        appLocale: "ja-JP",
        preferredSystemLanguages: ["fr-FR"],
        expected: "pt-BR",
        inbox: "Entrada",
      },
    ].map((row) => [row.name, row] as [string, typeof row])
  )(
    "with the System preference %s",
    (_name, { appLocale, preferredSystemLanguages, expected, inbox }) => {
      expect(
        initializeElectronMainI18n({
          appLocale,
          localePreference: "system",
          preferredSystemLanguages,
        })
      ).toBe(expected);
      expect(messages.nav_inbox()).toBe(inbox);
    }
  );

  it.each(["en", "zh-CN", "pt-BR"] as const)(
    "follows a stored %s before the operating system",
    (localePreference) => {
      expect(
        initializeElectronMainI18n({
          appLocale: localePreference === "zh-CN" ? "en-US" : "zh-CN",
          localePreference,
          preferredSystemLanguages: ["fr-FR"],
        })
      ).toBe(localePreference);
    }
  );

  it("localizes the shutdown-safety dialog in Electron Main", () => {
    expect(
      messages.electron_shutdown_blocked_title(
        { productName: "Comma" },
        { locale: "zh-CN" }
      )
    ).toBe("Comma 无法安全退出");
    expect(
      messages.electron_shutdown_blocked_detail(
        { productName: "Comma" },
        { locale: "zh-CN" }
      )
    ).toContain("应用将保持打开");
  });
});
