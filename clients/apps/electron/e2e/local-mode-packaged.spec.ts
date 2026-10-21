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
  rmSync,
  statSync,
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

/**
 * First launch on an empty profile, then a second launch whose Drive source
 * is a temporary folder (see isolateDriveSource). Returns the second launch.
 */
async function launchWithIsolatedDrive(
  userData: string,
  driveRoot: string,
  label: string
): Promise<{ app: LaunchedApp; main: Page }> {
  let app = await launch(userData, `${label}-first`);
  try {
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
    app = await launch(userData, `${label}-second`);
    const main = await mainWindow(app.browser);
    await waitForSignedInHome(main);
    return { app, main };
  } catch (error) {
    await quit(app).catch(() => undefined);
    throw error;
  }
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
      let main: Page;
      ({ app, main } = await launchWithIsolatedDrive(userData, driveRoot, "asr"));
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
      // Ready dismisses the install notice, and keyboard focus is not left on
      // the Remove button that replaced Install.
      await expect(
        main.locator('[data-testid="local-transcription-notice"]')
      ).toHaveCount(0);
      const focused = await main.evaluate(() => ({
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent?.trim().slice(0, 40),
      }));
      writeFileSync(
        join(evidence(), "asr-03-ready-focus.json"),
        JSON.stringify(focused)
      );
      expect(focused.text).not.toBe(text.settings_local_transcription_remove);

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
      const confirmation = main.getByRole("dialog", {
        name: text.settings_local_transcription_remove_confirm_title!,
      });
      await expect(confirmation).toBeVisible();
      await main.screenshot({
        path: join(evidence(), "asr-05-remove-confirm.png"),
        animations: "disabled",
      });
      await confirmation
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
      await main.screenshot({ path: join(evidence(), "asr-06-removed.png") });
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

interface MeetingState {
  provider: string;
  ready: boolean;
  reason?: string;
  cloud?: { kind: string; model: string; hasKey: boolean; verification: string };
  diarization: string;
}

function meetingState(page: Page) {
  return page.evaluate(() =>
    (
      globalThis as {
        commaNative?: {
          meetingTranscription: { state: { get(): Promise<MeetingState> } };
        };
      }
    ).commaNative!.meetingTranscription.state.get()
  );
}

/** Opens Settings → Meeting (from any route) and selects a transcription engine. */
async function chooseEngine(page: Page, text: Record<string, string>, label: string) {
  await clearOverlays(page);
  await page.evaluate(() => {
    window.location.hash = "/settings?category=meeting";
  });
  const dialog = await openLocalTranscriptionSection(page, text);
  await dialog
    .getByRole("button", {
      name: new RegExp(text.settings_meeting_transcription_engine!),
    })
    .click();
  await page.getByRole("option", { name: label, exact: true }).click();
  return dialog;
}

/** The key field is a password field; screenshots also cover every one. */
function shot(page: Page, name: string) {
  return page.screenshot({
    path: join(evidence(), name),
    mask: [page.locator('input[type="password"]')],
    animations: "disabled",
  });
}

/** Every file under `root` (relative path and size), for the evidence. */
function listFiles(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(path, base);
    return entry.isFile()
      ? [`${path.slice(base.length + 1)} ${statSync(path).size}`]
      : [];
  });
}

/** Regular files under the roots that contain `secret`; it is never printed. */
function filesContaining(roots: string[], secret: string) {
  const needle = Buffer.from(secret);
  let scanned = 0;
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        scanned += 1;
        try {
          if (readFileSync(path).includes(needle)) hits.push(path);
        } catch {
          // A file removed during the scan holds nothing.
        }
      }
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  return { scanned, hits };
}

/** Samples `ps -axww` until stopped and counts command lines with `secret`. */
function sampleProcesses(secret: string) {
  let samples = 0;
  let hits = 0;
  const timer = setInterval(() => {
    const lines = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).split("\n");
    samples += 1;
    hits += lines.filter((line) => line.includes(secret)).length;
  }, 1_000);
  return () => {
    clearInterval(timer);
    return { samples, hits };
  };
}

interface FakeRequest {
  at: number;
  method: string;
  path: string;
  status: number;
  bytes: number;
  seconds?: number;
  fields?: Record<string, string>;
}

/**
 * A loopback OpenAI-compatible transcription API. It cannot recognize
 * speech: each piece gets one word "w" every 0.5 s of its own duration
 * (read with afinfo), so the joined transcript shows the pieces' rebase and
 * seams. `rateLimitOnce` answers the next upload 429 with retry-after.
 */
async function startFakeProvider(key: string) {
  const requests: FakeRequest[] = [];
  const work = await mkdtemp(join(tmpdir(), "comma-fake-asr-"));
  let rateLimitOnce = 0;
  let pieces = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const record: FakeRequest = {
        at: Date.now(),
        method: request.method ?? "",
        path: request.url ?? "",
        status: 200,
        bytes: body.length,
      };
      requests.push(record);
      const send = (
        status: number,
        json: unknown,
        headers: Record<string, string> = {}
      ) => {
        record.status = status;
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(json));
      };
      if (request.headers.authorization !== `Bearer ${key}`)
        return send(401, { error: { message: "bad key" } });
      if (request.method === "GET" && request.url === "/v1/models")
        return send(200, { object: "list", data: [{ id: "fake-whisper" }] });
      if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions")
        return send(404, { error: { message: "not found" } });
      if (rateLimitOnce > 0) {
        const seconds = rateLimitOnce;
        rateLimitOnce = 0;
        return send(
          429,
          { error: { message: "rate limited" } },
          { "retry-after": String(seconds) }
        );
      }
      const parts = multipart(body, String(request.headers["content-type"]));
      const file = join(work, `piece-${(pieces += 1)}.m4a`);
      writeFileSync(file, parts.file ?? Buffer.alloc(0));
      const info = execFileSync("/usr/bin/afinfo", [file], { encoding: "utf8" });
      rmSync(file, { force: true });
      const seconds = Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 0);
      record.seconds = seconds;
      record.fields = parts.fields;
      const words = [];
      for (let start = 0.25; start < seconds - 0.1; start += 0.5)
        words.push({ word: "w", start, end: start + 0.3 });
      const segments = [];
      for (let start = 0; start < seconds; start += 10) {
        const inside = words.filter((w) => w.start >= start && w.start < start + 10);
        segments.push({
          id: segments.length,
          start,
          end: Math.min(start + 10, seconds),
          text: inside.map((w) => w.word).join(" "),
        });
      }
      send(200, {
        task: "transcribe",
        language: "english",
        duration: seconds,
        text: words.map((w) => w.word).join(" "),
        segments,
        words,
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    rateLimitNext(seconds: number) {
      rateLimitOnce = seconds;
    },
    /** Refuses every later connection: the provider is unreachable. */
    async stop() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(work, { force: true, recursive: true });
    },
  };
}

function multipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ""}`);
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let at = body.indexOf(marker);
  while (at >= 0) {
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const part = body.subarray(at + marker.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(headers)?.[1] ?? "";
    if (name === "file") file = content;
    // Repeated fields such as timestamp_granularities[] keep every value.
    else
      fields[name] = fields[name]
        ? `${fields[name]},${content.toString("utf8")}`
        : content.toString("utf8");
    at = next;
  }
  return { fields, file };
}

/** `[HH:MM:SS]` of each transcript line, in seconds. */
function lineTimes(transcript: string) {
  return [...transcript.matchAll(/^\[(\d{2}):(\d{2}):(\d{2})\]/gm)].map(
    ([, h, m, s]) => Number(h) * 3600 + Number(m) * 60 + Number(s)
  );
}

function audioDuration(file: string) {
  const info = execFileSync("/usr/bin/afinfo", [file], { encoding: "utf8" });
  return Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 0);
}

/** The Drive toast that says the transcript was saved beside the recording. */
function transcriptSaved(
  main: Page,
  text: Record<string, string>,
  name: string,
  timeout = 11 * 60_000
) {
  return expect(
    main.locator("[data-sonner-toast]").filter({
      hasText: text.recording_transcribe_done!.replace("{name}", name),
    })
  ).toBeVisible({ timeout });
}

/**
 * openspec add-cloud-meeting-asr, tasks 6.1–6.3. It uses a real Groq key
 * (COMMA_ELECTRON_CLOUD_ASR_KEY_FILE, read here and typed into Settings,
 * never logged) and COMMA_ELECTRON_LOCAL_ASR_AUDIO, a short two-voice
 * recording. A real failure needs no network cut: the OpenAI-compatible
 * provider is a loopback fake that the test stops, which the helper reports
 * as cloud_unreachable. Optional, for task 6.2:
 * COMMA_ELECTRON_CLOUD_ASR_LONG_AUDIO, a recording above Groq's 24 MB
 * piece limit whose speech says "Sentence number N" once for each N, sent
 * to Groq; and COMMA_ELECTRON_CLOUD_ASR_FAKE_AUDIO, a two-hour recording sent
 * to the fake provider, whose first upload gets 429 with retry-after.
 * The run also downloads the local model (about 632 MB) for the fallback.
 */
test.describe("packaged cloud transcription", () => {
  const keyFile = process.env.COMMA_ELECTRON_CLOUD_ASR_KEY_FILE;
  const audio = process.env.COMMA_ELECTRON_LOCAL_ASR_AUDIO;
  const longAudio = process.env.COMMA_ELECTRON_CLOUD_ASR_LONG_AUDIO;
  const fakeAudio = process.env.COMMA_ELECTRON_CLOUD_ASR_FAKE_AUDIO;
  test.skip(
    !appBundle ||
      !keyFile ||
      !audio ||
      process.platform !== "darwin" ||
      process.arch !== "arm64",
    "Set COMMA_ELECTRON_LOCAL_MODE_APP, COMMA_ELECTRON_CLOUD_ASR_KEY_FILE and COMMA_ELECTRON_LOCAL_ASR_AUDIO on an Apple silicon Mac."
  );

  test("transcribes through Groq with local speakers, reports cloud failures, falls back, and returns to Local", async () => {
    test.setTimeout(120 * 60_000);
    const key = readFileSync(keyFile!, "utf8").trim();
    const fakeKey = "fake-provider-e2e-key";
    const userData = await mkdtemp("/tmp/comma-cloud-");
    const driveRoot = join(userData, "drive-root");
    const modelsDir = join(userData, "Models");
    const folder = join(driveRoot, "recording", recordingDay());
    const report: Record<string, unknown> = {};
    const fake = await startFakeProvider(fakeKey);
    let app: LaunchedApp | undefined;
    const transcribe = async (
      main: Page,
      text: Record<string, string>,
      name: string
    ) => {
      const started = Date.now();
      await transcribeFromDrive(main, text, name);
      return started;
    };
    const transcriptOf = (name: string, ext: "txt" | "json") =>
      readFileSync(join(folder, name.replace(/\.m4a$/, `.transcript.${ext}`)), "utf8");
    try {
      let main: Page;
      ({ app, main } = await launchWithIsolatedDrive(userData, driveRoot, "cloud"));
      // A missing control fails the step instead of waiting for the test timeout.
      main.setDefaultTimeout(120_000);
      const text = await rendererMessages(main);
      mkdirSync(folder, { recursive: true });
      expect(await meetingState(main)).toMatchObject({
        provider: "local",
        ready: false,
      });

      // 6.1: Groq with the owner's key; only the speaker separator installs.
      let dialog = await chooseEngine(
        main,
        text,
        text.settings_meeting_transcription_engine_groq!
      );
      await dialog
        .getByLabel(text.settings_meeting_transcription_key!, { exact: true })
        .fill(key);
      await shot(main, "cloud-01-groq-key-entered.png");
      await dialog
        .getByRole("button", {
          name: text.settings_meeting_transcription_save!,
          exact: true,
        })
        .click();
      const separator = new Set<string>();
      await expect
        .poll(
          async () => {
            const state = await meetingState(main);
            if (!separator.has(state.diarization)) {
              separator.add(state.diarization);
              await shot(main, `cloud-02-separator-${state.diarization}.png`);
            }
            return state.provider === "groq" && state.ready;
          },
          { timeout: 10 * 60_000, intervals: [250] }
        )
        .toBe(true);
      await shot(main, "cloud-03-groq-ready.png");
      report.separatorPhases = [...separator];
      expect(await meetingState(main)).toMatchObject({
        provider: "groq",
        ready: true,
        diarization: "ready",
        cloud: {
          kind: "groq",
          model: "whisper-large-v3",
          hasKey: true,
          verification: "valid",
        },
      });
      expect((await localTranscriptionState(main)).phase).toBe("not_installed");
      const separatorOnly = listFiles(modelsDir);
      writeFileSync(
        join(evidence(), "cloud-models-separator-only.txt"),
        `${separatorOnly.join("\n")}\n`
      );
      expect(separatorOnly.length).toBeGreaterThan(0);
      // The folder is named by the manifest id; inside it only the separator
      // component and its marker exist, not the speech model's files.
      expect(
        separatorOnly.filter(
          (file) =>
            !/^[^/]+\/(speaker-diarization\/|\.installed-diarization )/.test(file)
        )
      ).toEqual([]);

      // Two voices through Groq; ps is sampled for the key meanwhile (6.3).
      const twoVoices = "cloud-two-voices.m4a";
      writeFileSync(join(folder, twoVoices), readFileSync(audio!));
      const stopSampling = sampleProcesses(key);
      let started = await transcribe(main, text, twoVoices);
      await transcriptSaved(main, text, twoVoices);
      report.twoVoicesSeconds = (Date.now() - started) / 1000;
      report.psDuringGroq = stopSampling();
      const twoText = transcriptOf(twoVoices, "txt");
      const twoJson = JSON.parse(transcriptOf(twoVoices, "json"));
      writeFileSync(join(evidence(), "cloud-04-groq.transcript.txt"), twoText);
      writeFileSync(
        join(evidence(), "cloud-04-groq.transcript.json"),
        JSON.stringify(twoJson, null, 2)
      );
      expect(twoText).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Speaker 1: \S/m);
      expect(twoText).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Speaker 2: \S/m);
      expect(twoJson).toMatchObject({
        status: "ready",
        provider: "groq",
        model: "whisper-large-v3",
      });
      expect(twoJson.fallback).toBeUndefined();
      await shot(main, "cloud-04-groq-transcribed.png");

      // 6.2 with Groq: pieces below 24 MB, seams without repeated speech.
      if (longAudio) {
        const name = "cloud-long-groq.m4a";
        writeFileSync(join(folder, name), readFileSync(longAudio));
        started = await transcribe(main, text, name);
        await transcriptSaved(main, text, name);
        const elapsed = (Date.now() - started) / 1000;
        const transcript = transcriptOf(name, "txt");
        const json = JSON.parse(transcriptOf(name, "json"));
        writeFileSync(
          join(evidence(), "cloud-05-long-groq.transcript.txt"),
          transcript
        );
        const said = [...transcript.matchAll(/sentence (?:number )?(\d+)/gi)].map(
          ([, n]) => Number(n)
        );
        const repeated = said.filter((n, index) => said.indexOf(n) !== index);
        const times = lineTimes(transcript);
        const audioSeconds = audioDuration(longAudio);
        report.longGroq = {
          audioSeconds,
          bytes: statSync(longAudio).size,
          elapsed,
          provider: json.provider,
          fallback: json.fallback,
          distinctSentences: new Set(said).size,
          maxSentence: Math.max(...said),
          repeated,
          lastLine: times.at(-1),
          largestGap: Math.max(...times.slice(1).map((t, i) => t - times[i]!)),
        };
        expect(json).toMatchObject({ status: "ready", provider: "groq" });
        expect(json.fallback).toBeUndefined();
        expect(elapsed).toBeLessThan(600);
        expect(repeated).toEqual([]);
        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(times.at(-1)!).toBeGreaterThan(audioSeconds - 120);
      }

      // The data and the logs never hold the key (6.3).
      report.keyInFilesAfterGroq = filesContaining([userData, evidence()], key);

      // An OpenAI-compatible API on loopback; its key replaces Groq's.
      dialog = await chooseEngine(
        main,
        text,
        text.settings_meeting_transcription_engine_compatible!
      );
      await dialog
        .getByLabel(text.settings_meeting_transcription_url!, { exact: true })
        .fill(fake.baseUrl);
      await dialog
        .getByLabel(text.settings_meeting_transcription_key!, { exact: true })
        .fill(fakeKey);
      await dialog
        .getByLabel(text.settings_meeting_transcription_model!, { exact: true })
        .fill("fake-whisper");
      await dialog
        .getByRole("button", {
          name: text.settings_meeting_transcription_save!,
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () => {
            const state = await meetingState(main);
            return state.provider === "openai_compatible" && state.ready;
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      await shot(main, "cloud-06-compatible-ready.png");

      // 6.2 with the fake: two hours in pieces, and a 429 with retry-after.
      if (fakeAudio) {
        const name = "cloud-long-fake.m4a";
        writeFileSync(join(folder, name), readFileSync(fakeAudio));
        fake.rateLimitNext(3);
        const before = fake.requests.length;
        started = await transcribe(main, text, name);
        await transcriptSaved(main, text, name);
        const elapsed = (Date.now() - started) / 1000;
        const uploads = fake.requests.slice(before).filter((r) => r.method === "POST");
        const transcript = transcriptOf(name, "txt");
        const json = JSON.parse(transcriptOf(name, "json"));
        const words = transcript.split("\n").flatMap((line) =>
          line
            .replace(/^\[[^\]]+\]( Speaker \d+:)? ?/, "")
            .split(" ")
            .filter(Boolean)
        );
        const audioSeconds = audioDuration(fakeAudio);
        const times = lineTimes(transcript);
        const expected = uploads
          .filter((r) => r.status === 200)
          .reduce((sum, r) => sum + Math.ceil(((r.seconds ?? 0) - 0.35) / 0.5), 0);
        report.longFake = {
          audioSeconds,
          bytes: statSync(fakeAudio).size,
          elapsed,
          provider: json.provider,
          uploads: uploads.map(({ at, status, bytes, seconds, fields }) => ({
            at,
            status,
            bytes,
            seconds,
            model: fields?.model,
            format: fields?.response_format,
            granularities: fields?.["timestamp_granularities[]"],
          })),
          retryWaitSeconds: uploads[1]
            ? (uploads[1].at - uploads[0]!.at) / 1000
            : undefined,
          words: words.length,
          wordsSentBeforeJoin: expected,
          wordsExpectedForDuration: Math.round(audioSeconds * 2),
          lastLine: times.at(-1),
          largestGap: Math.max(...times.slice(1).map((t, i) => t - times[i]!)),
        };
        expect(json).toMatchObject({
          status: "ready",
          provider: "openai_compatible",
          model: "fake-whisper",
        });
        expect(uploads[0]!.status).toBe(429);
        expect(uploads[1]!.at - uploads[0]!.at).toBeGreaterThanOrEqual(3_000);
        expect(uploads.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(
          12
        );
        for (const upload of uploads) expect(upload.bytes).toBeLessThan(24_000_000);
        expect(elapsed).toBeLessThan(600);
        // Each 2 s overlap is sent twice but joined once.
        expect(Math.abs(words.length - audioSeconds * 2)).toBeLessThanOrEqual(
          uploads.length * 2
        );
        expect(times).toEqual(times.toSorted((a, b) => a - b));
        expect(times.at(-1)!).toBeGreaterThan(audioSeconds - 60);
      }

      // The provider is unreachable and no local model takes over:
      // the provider's error with Try again, never the local install.
      await fake.stop();
      const failed = "cloud-failed.m4a";
      writeFileSync(join(folder, failed), readFileSync(audio!));
      await transcribe(main, text, failed);
      const failedToast = main.locator(
        `[data-testid="recording-transcribe-recording/${recordingDay()}/${failed}"]`
      );
      await expect(
        main
          .locator("[data-sonner-toast]")
          .filter({
            has: main.getByRole("button", {
              name: text.recording_transcription_retry!,
              exact: true,
            }),
          })
          .first()
      ).toBeVisible({ timeout: 5 * 60_000 });
      await main.screenshot({
        path: join(evidence(), "cloud-07-failed-try-again.png"),
        animations: "disabled",
      });
      expect(
        await main.locator('[data-testid="local-transcription-notice"]').count()
      ).toBe(0);
      report.failedToasts = await main.locator("[data-sonner-toast]").allInnerTexts();
      report.failedDriveToastIdFound = await failedToast.count();
      expect(JSON.parse(transcriptOf(failed, "json"))).toMatchObject({
        status: "error",
        reason: "cloud_asr_failed:cloud_unreachable",
      });
      expect(
        existsSync(join(folder, failed.replace(/\.m4a$/, ".transcript.txt")))
      ).toBe(false);

      // With the local model installed, the same failure falls back to it.
      await clearOverlays(main);
      await main.evaluate(() => {
        window.location.hash = "/settings?category=meeting";
      });
      await (
        await openLocalTranscriptionSection(main, text)
      )
        .getByRole("button", {
          name: text.settings_local_transcription_install!,
          exact: true,
        })
        .click();
      await expect
        .poll(async () => (await localTranscriptionState(main)).phase, {
          timeout: 30 * 60_000,
          intervals: [1_000],
        })
        .toBe("ready");
      const fallback = "cloud-fallback.m4a";
      writeFileSync(join(folder, fallback), readFileSync(audio!));
      await transcribe(main, text, fallback);
      await transcriptSaved(main, text, fallback);
      await expect(
        main.locator('[data-testid="transcription-fallback-notice"]')
      ).toBeVisible({
        timeout: 60_000,
      });
      await main.screenshot({
        path: join(evidence(), "cloud-08-fallback.png"),
        animations: "disabled",
      });
      report.fallbackToast = await main
        .locator('[data-testid="transcription-fallback-notice"]')
        .innerText();
      const fallbackJson = JSON.parse(transcriptOf(fallback, "json"));
      writeFileSync(
        join(evidence(), "cloud-08-fallback.transcript.json"),
        JSON.stringify(fallbackJson, null, 2)
      );
      expect(fallbackJson).toMatchObject({
        status: "ready",
        provider: "local",
        fallback: { from: "openai_compatible", reason: "cloud_unreachable" },
      });

      // Back to Local: no check needed, the cloud setup is kept.
      await chooseEngine(main, text, text.settings_meeting_transcription_engine_local!);
      await expect
        .poll(
          async () => {
            const state = await meetingState(main);
            return state.provider === "local" && state.ready;
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      await shot(main, "cloud-09-back-to-local.png");
      expect((await meetingState(main)).cloud).toMatchObject({
        kind: "openai_compatible",
        hasKey: true,
      });
      const local = "cloud-back-to-local.m4a";
      writeFileSync(join(folder, local), readFileSync(audio!));
      await transcribe(main, text, local);
      await transcriptSaved(main, text, local);
      const localJson = JSON.parse(transcriptOf(local, "json"));
      expect(localJson).toMatchObject({ status: "ready", provider: "local" });
      expect(localJson.fallback).toBeUndefined();

      report.keyInFilesAtEnd = filesContaining([userData, evidence()], key);
      expect((report.psDuringGroq as { hits: number }).hits).toBe(0);
      expect((report.keyInFilesAfterGroq as { hits: string[] }).hits).toEqual([]);
      expect((report.keyInFilesAtEnd as { hits: string[] }).hits).toEqual([]);

      await quit(app);
      app = undefined;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      expect(bundledProcesses()).toEqual([]);
    } finally {
      writeFileSync(
        join(evidence(), "cloud-report.json"),
        JSON.stringify(report, null, 2)
      );
      if (app) await quit(app).catch(() => undefined);
      await fake.stop().catch(() => undefined);
      if (!process.env.COMMA_E2E_KEEP_DATA)
        await rm(userData, { force: true, recursive: true });
    }
  });
});

function bundledPids() {
  return bundledProcesses().map((line) => Number(line.trim().split(/\s+/)[0]));
}
