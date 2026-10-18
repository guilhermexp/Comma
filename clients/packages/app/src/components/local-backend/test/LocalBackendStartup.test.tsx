import userEvent from "@testing-library/user-event";
import { initializeCommaI18n, type CommaLocale } from "@comma/i18n";
import { CommaI18nProvider } from "@comma/i18n/react";
import type { LocalBackendStatus } from "@comma/native-bridge";
import {
  createNativeStateBridgeMock,
  installNativeBridgeMock,
} from "@comma/test-utils/native-bridge";
import { render, screen } from "@comma/test-utils/render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackendGate, LocalBackendStartupScreen } from "../LocalBackendStartup";

function renderIn(locale: CommaLocale, node: ReactNode) {
  initializeCommaI18n([locale]);
  return render(<CommaI18nProvider locale={locale}>{node}</CommaI18nProvider>);
}

const paths = {
  logsDir: "/Users/test/Library/Application Support/Comma/local/logs",
  backupsDir: "/Users/test/Library/Application Support/Comma/local/backups",
};

afterEach(() => {
  delete (globalThis as { commaNative?: unknown }).commaNative;
});

describe("local backend startup screen", () => {
  it("shows which step is running while the backend starts", () => {
    renderIn(
      "en",
      <LocalBackendStartupScreen
        status={{ mode: "local", phase: "starting", ...paths }}
      />
    );

    expect(screen.getByRole("heading", { name: "Starting Comma" })).toBeTruthy();
    const current = screen.getByRole("listitem", { current: "step" });
    expect(current.textContent).toContain("Local services");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  });

  it("moves to the database step while the data is prepared", () => {
    renderIn(
      "pt-BR",
      <LocalBackendStartupScreen
        status={{ mode: "local", phase: "preparing", ...paths }}
      />
    );

    expect(screen.getByRole("heading", { name: "Preparando seus dados" })).toBeTruthy();
    expect(screen.getByRole("listitem", { current: "step" }).textContent).toContain(
      "Banco de dados"
    );
  });

  it("explains a failed migration, where the backup is, and offers both actions", async () => {
    const onRetry = vi.fn();
    const onShowLogs = vi.fn();
    renderIn(
      "en",
      <LocalBackendStartupScreen
        status={{
          mode: "local",
          phase: "failed",
          failure: {
            code: "migration_failed",
            message: "comma exited with status 1. Log: /data/logs/prepare.log",
          },
          ...paths,
          lastBackupPath: `${paths.backupsDir}/comma-20261017T120000Z-0.0.2-to-0.0.3.dump`,
        }}
        onRetry={onRetry}
        onShowLogs={onShowLogs}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Your data could not be updated" })
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("prepare.log");
    expect(screen.getByText(/0\.0\.2-to-0\.0\.3\.dump$/)).toBeTruthy();
    expect(screen.getByText(paths.logsDir)).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Show logs" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onShowLogs).toHaveBeenCalledOnce();
  });

  it("names the error in Simplified Chinese", () => {
    renderIn(
      "zh-CN",
      <LocalBackendStartupScreen
        status={{
          mode: "local",
          phase: "failed",
          failure: { code: "start_failed", message: "backend did not become ready" },
          ...paths,
        }}
      />
    );
    expect(screen.getByRole("heading", { name: "Comma 无法启动" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByText(paths.backupsDir)).toBeTruthy();
  });
});

describe("local backend gate", () => {
  function gate(status: LocalBackendStatus, platform: "electron" | "web" = "electron") {
    installNativeBridgeMock({
      platform,
      localBackend: { state: createNativeStateBridgeMock(() => status) },
    } as Parameters<typeof installNativeBridgeMock>[0]);
    return renderIn(
      "en",
      <LocalBackendGate>
        {(local) => <p>app {local ? "local" : "remote"}</p>}
      </LocalBackendGate>
    );
  }

  it("renders the app at once for a remote backend", async () => {
    gate({ mode: "remote", phase: "ready" });
    expect(await screen.findByText("app remote")).toBeTruthy();
  });

  it("keeps the startup screen until the local backend is ready and the owner is in", async () => {
    gate({ mode: "local", phase: "signing_in", ...paths });
    expect(
      await screen.findByRole("heading", { name: "Opening your account" })
    ).toBeTruthy();
    expect(screen.queryByText(/^app /)).toBeNull();
  });

  it("renders the app in local mode once ready", async () => {
    gate({ mode: "local", phase: "ready", ...paths });
    expect(await screen.findByText("app local")).toBeTruthy();
  });

  it("does not wait for a native snapshot in the web build", () => {
    gate({ mode: "local", phase: "starting" }, "web");
    expect(screen.getByText("app remote")).toBeTruthy();
  });
});
