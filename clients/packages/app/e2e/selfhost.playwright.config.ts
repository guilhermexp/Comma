import { defineConfig } from "@playwright/test";
import { englishWebStorageState } from "../../../e2e/helpers/english-locale";

const selfhostURL = process.env.COMMA_SELFHOST_URL || "http://localhost:8080";

export default defineConfig({
  testDir: ".",
  testMatch:
    process.env.COMMA_SELFHOST_RESTART === "true"
      ? "selfhost.restart.ts"
      : "selfhost.smoke.ts",
  outputDir: "../test-results/selfhost",
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: selfhostURL,
    storageState: englishWebStorageState(selfhostURL),
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
