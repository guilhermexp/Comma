/**
 * The packaged local-mode app on a Mac with nothing installed: launched with
 * only /usr/bin:/bin on PATH and an empty data directory, it reaches Home
 * already signed in, the Router answers, quitting leaves no bundled process,
 * and reopening keeps the conversation.
 *
 *   COMMA_ELECTRON_LOCAL_MODE_APP=/path/to/Comma.app \
 *     pnpm --dir clients exec playwright test apps/electron/e2e/local-mode-packaged.spec.ts
 *
 * The release fuses disable Node inspection, so the test drives the renderer
 * over the Chromium DevTools protocol on 127.0.0.1. `--use-mock-keychain`
 * keeps the run away from the Keychain item of any installed Comma. The
 * Router uses the repository's deterministic mock model
 * (systems/scripts/local-llm-mock.mjs), configured the way Settings does.
 */
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const appBundle = process.env.COMMA_ELECTRON_LOCAL_MODE_APP;
const evidenceDir = process.env.COMMA_E2E_EVIDENCE_DIR;
const routerReply = "LOCAL_CHAT_OK";
const message = "Hello Router, this is the local backend test";

interface LaunchedApp {
  process: ChildProcess;
  browser: Browser;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function startMockModel(): Promise<{ url: string; server: Server }> {
  const mock = (await import(
    pathToFileURL(resolve(process.cwd(), "../systems/scripts/local-llm-mock.mjs")).href
  )) as { createMockServer: (options: { logPath: string }) => Server };
  const handler = mock
    .createMockServer({ logPath: join(evidence(), "model-requests.jsonl") })
    .listeners("request")[0] as (
    request: IncomingMessage,
    response: ServerResponse
  ) => void;
  // Model templates address an OpenAI-compatible base URL ending in /v1; the
  // mock serves /chat/completions at its root.
  const server = createHttpServer((request, response) => {
    if (request.url?.startsWith("/v1/")) request.url = request.url.slice(3);
    handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

async function launch(userData: string, label: string): Promise<LaunchedApp> {
  const port = await freePort();
  const log = createWriteStream(join(evidence(), `app-${label}.log`), { flags: "a" });
  // The same environment a fresh Mac gives a Finder launch: no Homebrew, no
  // developer tools on PATH.
  const child = spawn(
    join(appBundle!, "Contents/MacOS/comma"),
    [
      `--user-data-dir=${userData}`,
      "--use-mock-keychain",
      `--remote-debugging-port=${port}`,
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      return {
        process: child,
        browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`),
      };
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error("The packaged app did not open its DevTools endpoint.");
}

async function windowWithRole(
  browser: Browser,
  role: string
): Promise<Page | undefined> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const pageRole = await page
        .evaluate(
          () =>
            (globalThis as { commaNative?: { self?: { role?: string } } }).commaNative
              ?.self?.role
        )
        .catch(() => undefined);
      if (pageRole === role) return page;
    }
  }
  return undefined;
}

async function mainWindow(browser: Browser): Promise<Page> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const page = await windowWithRole(browser, "main-window");
    if (page) return page;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("The main window did not open.");
}

/** Waits for Home; reports whether a login form was ever on screen meanwhile. */
async function waitForSignedInHome(page: Page) {
  let sawLogin = false;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        login: Boolean(
          document.querySelector('input[type="email"], input[autocomplete="email"]')
        ),
        home: Boolean(document.querySelector(".comma-app-shell")),
        startup: Boolean(document.querySelector(".local-backend-startup")),
      }))
      .catch(() => ({ login: false, home: false, startup: false }));
    sawLogin ||= state.login;
    if (state.home && !state.startup) return { sawLogin };
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Home did not appear within 10 minutes.");
}

function evidence() {
  const dir = evidenceDir ?? join(tmpdir(), "comma-local-mode-e2e-evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function bundledProcesses() {
  const prefix = `${resolve(appBundle!)}/Contents/`;
  return execFileSync(
    "/bin/ps",
    ["-U", String(process.getuid?.()), "-o", "pid=,comm="],
    {
      encoding: "utf8",
    }
  )
    .split("\n")
    .filter((line) =>
      line
        .trim()
        .replace(/^\d+\s+/, "")
        .startsWith(prefix)
    );
}

async function quit(app: LaunchedApp) {
  await app.browser.close().catch(() => undefined);
  const exited = new Promise((done) => app.process.once("exit", done));
  app.process.kill("SIGTERM");
  await Promise.race([exited, new Promise((done) => setTimeout(done, 120_000))]);
  expect(app.process.exitCode !== null || app.process.signalCode !== null).toBe(true);
}

interface Backend {
  apiBaseUrl: string;
  adminToken: string;
  ownerUserId: string;
}

function readBackend(userData: string): Backend {
  const dir = join(userData, "local-backend");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const secrets = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"));
  return {
    apiBaseUrl: `http://127.0.0.1:${state.ports.comma}`,
    adminToken: secrets.adminToken,
    ownerUserId: state.ownerUserId,
  };
}

async function api<T>(
  backend: Backend,
  token: string,
  method: string,
  path: string,
  body?: unknown
) {
  const response = await fetch(`${backend.apiBaseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-comma-session-transport": "bearer",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** What Settings → Models does: a private model template, chosen for the Router. */
async function useMockModelForRouter(backend: Backend, modelUrl: string) {
  const { token } = await api<{ token: string }>(
    backend,
    backend.adminToken,
    "POST",
    `/v1/comma/admin/users/${backend.ownerUserId}/sessions`,
    { local_dev: true, ttl_seconds: 3_600 }
  );
  let workspace: { id: string; status: string } | undefined;
  for (let attempt = 0; attempt < 120 && workspace?.status !== "ready"; attempt += 1) {
    const result = await api<{
      status: string;
      workspace: { id: string; status: string };
    }>(backend, token, "POST", "/v1/comma/me/bootstrap", {});
    workspace = result.workspace;
    if (workspace.status !== "ready")
      await new Promise((done) => setTimeout(done, 1_000));
  }
  expect(workspace?.status).toBe("ready");
  const template = await api<{ template_id: string }>(
    backend,
    token,
    "POST",
    `/v1/comma/workspaces/${workspace!.id}/model-templates`,
    {
      name: "Local mock",
      model: "gpt-local-dev",
      provider: "openai",
      protocol: "chat_completions",
      base_url: modelUrl,
      api_key: "local-e2e-only",
      max_tokens: 2_048,
      context_tokens: 32_768,
    }
  );
  // The workspace's own convergence may still write its default models right
  // after it becomes ready; the selection counts once it stays pinned.
  let stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 3; attempt += 1) {
    const models = await api<{ agents: { router: { template_id: string } } }>(
      backend,
      token,
      "GET",
      `/v1/comma/workspaces/${workspace!.id}/agent-models`
    );
    if (models.agents.router.template_id === template.template_id) {
      stable += 1;
    } else {
      stable = 0;
      await api(
        backend,
        token,
        "PUT",
        `/v1/comma/workspaces/${workspace!.id}/agent-models/router`,
        { template_id: template.template_id }
      );
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  expect(stable).toBe(3);
}

test.describe("packaged local mode", () => {
  test.skip(
    !appBundle || process.platform !== "darwin",
    "Set COMMA_ELECTRON_LOCAL_MODE_APP to a packaged local-mode Comma.app on macOS."
  );

  test("signs the owner in, answers in the Router, and keeps the conversation across quit", async () => {
    test.setTimeout(30 * 60_000);
    const userData = await mkdtemp(join(tmpdir(), "comma-local-mode-e2e-"));
    const model = await startMockModel();
    let app: LaunchedApp | undefined;
    try {
      app = await launch(userData, "first");
      let main = await mainWindow(app.browser);
      const first = await waitForSignedInHome(main);
      expect(first.sawLogin).toBe(false);
      await main.screenshot({ path: join(evidence(), "01-home-signed-in.png") });

      // Closing the first-launch onboarding by hand records it as done.
      const onboarding = await windowWithRole(app.browser, "onboarding-window");
      await onboarding?.evaluate(() => window.close()).catch(() => undefined);

      const backend = readBackend(userData);
      await useMockModelForRouter(backend, model.url);
      const listeners = execFileSync(
        "/usr/sbin/lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN"],
        {
          encoding: "utf8",
        }
      )
        .split("\n")
        .filter((line) => bundledPids().includes(Number(line.trim().split(/\s+/)[1])));
      writeFileSync(
        join(evidence(), "listeners-first.txt"),
        `${listeners.join("\n")}\n`
      );
      for (const line of listeners)
        expect(line).toMatch(/TCP (127\.0\.0\.1|\[::1\]):\d+ \(LISTEN\)/);

      const composer = main.locator('[contenteditable="true"]').last();
      await expect(composer).toBeEditable({ timeout: 120_000 });
      await composer.click();
      await composer.pressSequentially(message);
      await composer.press("Enter");
      await expect(main.getByText(routerReply).first()).toBeVisible({
        timeout: 180_000,
      });
      await main.screenshot({ path: join(evidence(), "02-router-answered.png") });

      await quit(app);
      app = undefined;
      await new Promise((done) => setTimeout(done, 2_000));
      expect(bundledProcesses()).toEqual([]);

      app = await launch(userData, "second");
      main = await mainWindow(app.browser);
      const second = await waitForSignedInHome(main);
      expect(second.sawLogin).toBe(false);
      await expect(main.getByText(message).first()).toBeVisible({ timeout: 120_000 });
      await expect(main.getByText(routerReply).first()).toBeVisible();
      await main.screenshot({ path: join(evidence(), "03-reopened-conversation.png") });

      await quit(app);
      app = undefined;
      await new Promise((done) => setTimeout(done, 2_000));
      expect(bundledProcesses()).toEqual([]);
    } finally {
      if (app) await quit(app).catch(() => undefined);
      model.server.close();
      if (!process.env.COMMA_E2E_KEEP_DATA)
        await rm(userData, { force: true, recursive: true });
    }
  });
});

/** The renderer's own strings, in the locale the packaged app chose. */
async function rendererMessages(page: Page) {
  const lang = await page.evaluate(() => document.documentElement.lang || "en");
  const file = resolve(process.cwd(), `packages/i18n/messages/${lang}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

function localTranscriptionState(page: Page) {
  return page.evaluate(() =>
    (
      globalThis as {
        commaNative?: {
          localTranscription: {
            state: { get(): Promise<{ phase: string; supported: boolean }> };
          };
        };
      }
    ).commaNative!.localTranscription.state.get()
  );
}

/**
 * Drive publishes `~/Comma Drive` whatever the Electron profile is, and the
 * owner's own Comma can publish the same folder. The test moves this
 * profile's Drive source to a temporary folder before it writes a file there.
 * Drive must be ready: the commands go through its daemon.
 */
function isolateDriveSource(userData: string, root: string) {
  const synch = join(appBundle!, "Contents/Resources/native/darwin/arm64/synch");
  const env = { ...process.env, SYNCH_DATA_DIR: join(userData, "synchronicity") };
  mkdirSync(root, { recursive: true });
  execFileSync(synch, ["source", "rm", "comma-drive"], { env });
  execFileSync(synch, ["source", "add", "comma-drive", root], { env });
}

/** Closes Settings and the toasts; a click outside Settings would close it and route Home. */
async function clearOverlays(page: Page) {
  for (
    let attempt = 0;
    attempt < 5 && (await page.getByRole("dialog").count());
    attempt += 1
  )
    await page.keyboard.press("Escape");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const close = page.locator("[data-sonner-toast] button[aria-label]").first();
    if (!(await close.count())) return;
    await close.click({ timeout: 5_000 }).catch(() => undefined);
  }
}

async function transcribeFromDrive(
  page: Page,
  text: Record<string, string>,
  name: string
) {
  await clearOverlays(page);
  await page.evaluate(() => {
    window.location.hash = "/drive";
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/drive");
  const file = page.getByText(name, { exact: true }).first();
  const step = { timeout: 60_000 };
  await expect(
    page.getByText("recording", { exact: true }).or(file).first()
  ).toBeVisible(step);
  if (!(await file.isVisible())) {
    await page.getByText("recording", { exact: true }).first().dblclick(step);
    await page.getByText(recordingDay(), { exact: true }).first().dblclick(step);
  }
  await file.click({ button: "right", ...step });
  await page.getByRole("menuitem", { name: text.recording_transcribe! }).click(step);
}

/** The local day folder Drive files a recording under (recording/<day>/). */
function recordingDay() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

async function openLocalTranscriptionSection(page: Page, text: Record<string, string>) {
  const dialog = page
    .getByRole("dialog")
    .filter({ hasText: text.settings_local_transcription_model! });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog
    .getByText(text.settings_local_transcription_model!)
    .scrollIntoViewIfNeeded();
  return dialog;
}

/**
 * openspec add-local-meeting-asr, task 5.1. It downloads the real speech
 * model (about 654 MB), so it runs only when COMMA_ELECTRON_LOCAL_ASR_AUDIO
 * names a short recording with two voices. The recording comes from a
 * live capture of system audio while `afplay` plays that file, so the
 * launching terminal needs the Screen and System Audio Recording and the
 * Microphone permissions. The same file is also put in Drive as a saved
 * recording, a clean source for the speaker check.
 */
test.describe("packaged local transcription", () => {
  const audio = process.env.COMMA_ELECTRON_LOCAL_ASR_AUDIO;
  test.skip(
    !appBundle || !audio || process.platform !== "darwin" || process.arch !== "arm64",
    "Set COMMA_ELECTRON_LOCAL_MODE_APP and COMMA_ELECTRON_LOCAL_ASR_AUDIO on an Apple silicon Mac."
  );

  test("offers the install, installs the model, transcribes a saved recording by speaker, and removes the model", async () => {
    test.setTimeout(40 * 60_000);
    // Drive's control socket path must stay under the 104-byte macOS limit,
    // which the per-user temporary folder leaves too little room for.
    const userData = await mkdtemp("/tmp/comma-asr-");
    const driveRoot = join(userData, "drive-root");
    const modelsDir = join(userData, "Models");
    const name = "e2e-two-voices.m4a";
    let app: LaunchedApp | undefined;
    try {
      app = await launch(userData, "asr-first");
      const first = await mainWindow(app.browser);
      await waitForSignedInHome(first);
      // Closing the first-launch onboarding records it as done, so it does
      // not take over the main window's route on the next launch.
      const onboarding = await windowWithRole(app.browser, "onboarding-window");
      await onboarding?.evaluate(() => window.close()).catch(() => undefined);
      await expect
        .poll(
          () =>
            first.evaluate(
              async () =>
                (
                  await (
                    globalThis as {
                      commaNative?: {
                        synchronicity: { state(): Promise<{ status: string }> };
                      };
                    }
                  ).commaNative!.synchronicity.state()
                ).status
            ),
          { timeout: 120_000 }
        )
        .toBe("ready");
      // Main reads the published Drive folder again on the next launch.
      isolateDriveSource(userData, driveRoot);
      await quit(app);
      app = undefined;

      app = await launch(userData, "asr-second");
      const main = await mainWindow(app.browser);
      await waitForSignedInHome(main);
      const text = await rendererMessages(main);
      expect(await localTranscriptionState(main)).toMatchObject({
        supported: true,
        phase: "not_installed",
      });
      const folder = join(driveRoot, "recording", recordingDay());

      // Without the model the recording is saved and the server's
      // local_asr_model_not_installed becomes the install notice.
      await main.getByRole("button", { name: text.ui_ai_voice_input! }).click();
      execFileSync("/usr/bin/afplay", [audio!]);
      await main
        .getByRole("button", { name: text.ui_ai_confirm_voice_recording! })
        .click();
      const notice = main.locator('[data-testid="local-transcription-notice"]');
      await expect(notice).toBeVisible({ timeout: 120_000 });
      await main.screenshot({ path: join(evidence(), "asr-01-install-notice.png") });
      const recorded = readdirSync(folder).find((file) => file.endsWith(".m4a"))!;
      expect(
        JSON.parse(
          readFileSync(
            join(folder, recorded.replace(/\.m4a$/, ".transcript.json")),
            "utf8"
          )
        )
      ).toMatchObject({ status: "error", reason: "local_asr_model_not_installed" });
      await notice
        .getByRole("button", { name: text.recording_local_transcription_install! })
        .click();

      const section = await openLocalTranscriptionSection(main, text);
      await main.screenshot({ path: join(evidence(), "asr-02-not-installed.png") });
      await section
        .getByRole("button", {
          name: text.settings_local_transcription_install!,
          exact: true,
        })
        .click();
      const phases = new Set<string>();
      await expect
        .poll(
          async () => {
            const state = await localTranscriptionState(main);
            if (!phases.has(state.phase)) {
              phases.add(state.phase);
              await main.screenshot({
                path: join(evidence(), `asr-03-${state.phase}.png`),
              });
            }
            return state.phase;
          },
          { timeout: 20 * 60_000, intervals: [250] }
        )
        .toBe("ready");
      expect([...phases]).toEqual(
        expect.arrayContaining(["downloading", "preparing", "ready"])
      );

      // The captured recording can also hold whatever else the Mac played,
      // so only the clean file is checked for both speakers.
      writeFileSync(join(folder, name), readFileSync(audio!));
      for (const file of [recorded, name]) {
        await transcribeFromDrive(main, text, file);
        await expect(
          main.locator("[data-sonner-toast]").filter({
            hasText: text.recording_transcribe_done!.replace("{name}", file),
          })
        ).toBeVisible({ timeout: 10 * 60_000 });
      }
      const transcript = (file: string) =>
        readFileSync(join(folder, file.replace(/\.m4a$/, ".transcript.txt")), "utf8");
      writeFileSync(
        join(evidence(), "asr-04-recorded.transcript.txt"),
        transcript(recorded)
      );
      writeFileSync(join(evidence(), "asr-04-file.transcript.txt"), transcript(name));
      expect(transcript(recorded)).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Speaker \d+: \S/m);
      expect(transcript(name)).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Speaker 1: \S/m);
      expect(transcript(name)).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Speaker 2: \S/m);

      await main.evaluate(() => {
        window.location.hash = "/settings?category=meeting";
      });
      await (
        await openLocalTranscriptionSection(main, text)
      )
        .getByRole("button", {
          name: text.settings_local_transcription_remove!,
          exact: true,
        })
        .click();
      await expect
        .poll(async () => (await localTranscriptionState(main)).phase, {
          timeout: 120_000,
        })
        .toBe("not_installed");
      await main.screenshot({ path: join(evidence(), "asr-05-removed.png") });
      expect(existsSync(modelsDir)).toBe(false);

      await quit(app);
      app = undefined;
      await new Promise((done) => setTimeout(done, 2_000));
      expect(bundledProcesses()).toEqual([]);
    } finally {
      if (app) await quit(app).catch(() => undefined);
      if (!process.env.COMMA_E2E_KEEP_DATA)
        await rm(userData, { force: true, recursive: true });
    }
  });
});

function bundledPids() {
  return bundledProcesses().map((line) => Number(line.trim().split(/\s+/)[0]));
}
