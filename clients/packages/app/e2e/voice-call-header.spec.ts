import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import localGroupSelectors from "../../../vite/comma-tailwind";
import {
  createBuiltFixtureServer,
  type BuiltFixtureServer,
} from "../../../e2e/helpers/built-fixture";

const clientsRoot = resolve(import.meta.dirname, "../../..");
let server: BuiltFixtureServer;
let url: string;

test.beforeAll(async () => {
  server = await createBuiltFixtureServer({
    configFile: false,
    root: resolve(import.meta.dirname, "fixtures/voice-call-header"),
    cacheDir: resolve(clientsRoot, "node_modules/.vite/voice-call-header-e2e"),
    define: { "process.env.NODE_ENV": JSON.stringify("test") },
    plugins: [react(), tailwindcss({ optimize: false }), localGroupSelectors()],
    resolve: {
      alias: {
        "@comma/ui/styles.css": resolve(clientsRoot, "packages/ui/src/styles.css"),
        "@comma/ui": resolve(clientsRoot, "packages/ui/src/index.ts"),
      },
    },
    server: { hmr: false, host: "127.0.0.1", port: 0 },
  });
  url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
});
test.afterAll(async () => {
  await server?.close();
});

for (const theme of ["Light mode", "Dark mode"] as const) {
  test(`the floating call reserves only its own height in ${theme}`, async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(
      (appearance) => window.voiceHeaderFixture.theme(appearance),
      theme
    );
    const viewport = page.getByRole("log");
    const first = page.locator('[data-message-id="message-0"]');
    await page.evaluate(() => document.fonts.ready);
    const goToTop = async () => {
      await viewport.focus();
      // Initial history positioning can settle during the first measured frame.
      // Read the result after paint, and repeat the reader's Home command if needed.
      await expect
        .poll(async () => {
          await viewport.press("Home");
          return viewport.evaluate(async (element) => {
            await new Promise<void>((finish) =>
              requestAnimationFrame(() => requestAnimationFrame(() => finish()))
            );
            return element.scrollTop;
          });
        })
        .toBe(0);
    };
    await goToTop();
    const before = (await first.boundingBox())!.y;
    await page.getByRole("button", { name: "Ligar para Comma" }).click();
    const bar = page.getByTestId("voice-call");
    await expect(bar.locator("output")).toHaveText(/\d\d:\d\d/);
    await goToTop();
    await expect
      .poll(async () => (await first.boundingBox())!.y - before)
      .toBeCloseTo(52, 0);
    const pill = (await bar.boundingBox())!;
    expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual(pill.y + pill.height);
    await viewport.evaluate((element) => {
      element.scrollTop = 180;
    });
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBe(180);
    await expect.poll(async () => (await bar.boundingBox())!.y).toBeCloseTo(pill.y, 0);
    await page.getByRole("button", { name: "Encerrar" }).click();
    await expect(bar).toHaveCount(0);
    await goToTop();
    await expect
      .poll(async () => (await first.boundingBox())!.y)
      .toBeCloseTo(before, 0);
  });
}

test("call spacing does not create a scrollbar in an empty conversation", async ({
  page,
}) => {
  await page.goto(url);
  await page.evaluate(() => window.voiceHeaderFixture.empty());
  await page.getByRole("button", { name: "Ligar para Comma" }).click();
  await expect(page.getByTestId("voice-call").locator("output")).toHaveText(
    /\d\d:\d\d/
  );
  await expect(page.getByText("Pode me ajudar a organizar a semana?")).toHaveCount(0);
  const viewport = page.getByRole("log");
  await expect
    .poll(() =>
      viewport.evaluate((element) => element.scrollHeight - element.clientHeight)
    )
    .toBeLessThanOrEqual(1);
});
