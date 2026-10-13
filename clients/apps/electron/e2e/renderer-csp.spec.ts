import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("renderer loads Composio catalog logos while blocking unrelated image hosts", async ({
  page,
}) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="red"/></svg>';
  await page.route("https://logos.composio.dev/api/todoist", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg })
  );
  await page.route("https://untrusted-images.test/logo.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg })
  );
  await page.route("http://renderer-csp.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        path: resolve(__dirname, "../src/renderer/index.html"),
      });
    } else if (pathname === "/src/main.tsx") {
      await route.fulfill({
        contentType: "text/javascript",
        body: `
          const load = (url) => new Promise((resolve) => {
            const image = new Image();
            image.referrerPolicy = "no-referrer";
            image.onload = () => resolve(image.naturalWidth);
            image.onerror = () => resolve(0);
            image.src = url;
            document.querySelector("#root").append(image);
          });
          const logo = await load("https://logos.composio.dev/api/todoist");
          const unrelated = await load("https://untrusted-images.test/logo.svg");
          document.querySelector("#root").dataset.result = JSON.stringify({ logo, unrelated });
        `,
      });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });
  await page.goto("http://renderer-csp.test/");
  await expect(page.locator("#root")).toHaveAttribute(
    "data-result",
    JSON.stringify({ logo: 24, unrelated: 0 })
  );
});

// Run a same-origin script under the real renderer document's policy. DevTools
// evaluation bypasses CSP, so the probe must execute as a page script.
test("renderer permits WebAssembly compilation and rejects JavaScript eval", async ({
  page,
}) => {
  await page.route("http://renderer-csp.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        path: resolve(__dirname, "../src/renderer/index.html"),
      });
    } else if (pathname === "/src/main.tsx") {
      await route.fulfill({
        contentType: "text/javascript",
        body: `
          const result = { wasm: false, evalBlocked: false };
          try {
            await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
            result.wasm = true;
          } catch {}
          try { eval("1 + 1"); } catch (error) {
            result.evalBlocked = error instanceof EvalError;
          }
          document.querySelector("#root").textContent = JSON.stringify(result);
        `,
      });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });
  await page.goto("http://renderer-csp.test/");
  await expect(page.locator("#root")).toHaveText(
    JSON.stringify({ wasm: true, evalBlocked: true })
  );
});
