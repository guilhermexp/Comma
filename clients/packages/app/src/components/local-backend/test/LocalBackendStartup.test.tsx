import userEvent from "@testing-library/user-event";
import { initializeCommaI18n } from "@comma/i18n";
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

function renderScreen(node: ReactNode) {
  initializeCommaI18n(["en"]);
  return render(<CommaI18nProvider locale="en">{node}</CommaI18nProvider>);
}

const paths = {
  logsDir: "/data/Comma/local/logs",
  backupsDir: "/data/Comma/local/backups",
};

function stepStates() {
  return screen.getAllByRole("listitem").map((item) => item.getAttribute("data-state"));
}

afterEach(() => {
  delete (globalThis as { commaNative?: unknown }).commaNative;
});

describe("local backend startup screen", () => {
  it("marks the services step as running while the backend starts", () => {
    renderScreen(
      <LocalBackendStartupScreen
        status={{ mode: "local", phase: "starting", ...paths }}
      />
    );

    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(stepStates()).toEqual(["current", "pending", "pending"]);
    expect(screen.getAllByRole("listitem")[0]!.getAttribute("aria-current")).toBe(
      "step"
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  });

  it("moves to the database step and then the account step", () => {
    const view = renderScreen(
      <LocalBackendStartupScreen
        status={{ mode: "local", phase: "preparing", ...paths }}
      />
    );
    expect(stepStates()).toEqual(["done", "current", "pending"]);

    view.rerender(
      <CommaI18nProvider locale="en">
        <LocalBackendStartupScreen
          status={{ mode: "local", phase: "signing_in", ...paths }}
        />
      </CommaI18nProvider>
    );
    expect(stepStates()).toEqual(["done", "done", "current"]);
  });

  it("shows a failed migration with its detail, the backup, the logs, and both actions", async () => {
    const onRetry = vi.fn();
    const onShowLogs = vi.fn();
    const backup = `${paths.backupsDir}/comma-20261017T120000Z-0.0.2-to-0.0.3.dump`;
    renderScreen(
      <LocalBackendStartupScreen
        status={{
          mode: "local",
          phase: "failed",
          failure: { code: "migration_failed", message: "comma exited with status 1" },
          ...paths,
          lastBackupPath: backup,
        }}
        onRetry={onRetry}
        onShowLogs={onShowLogs}
      />
    );

    expect(screen.getByRole("main").getAttribute("data-phase")).toBe("failed");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
    expect(stepStates()).toEqual(["done", "failed", "pending"]);
    expect(screen.getByRole("alert").textContent).toContain(
      "comma exited with status 1"
    );
    expect(screen.getByText(backup)).toBeTruthy();
    expect(screen.getByText(paths.logsDir)).toBeTruthy();

    const [retry, showLogs] = screen.getAllByRole("button");
    await userEvent.click(retry!);
    await userEvent.click(showLogs!);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onShowLogs).toHaveBeenCalledOnce();
  });

  it("points to the backups folder when no backup was made", () => {
    renderScreen(
      <LocalBackendStartupScreen
        status={{
          mode: "local",
          phase: "failed",
          failure: { code: "start_failed", message: "backend did not become ready" },
          ...paths,
        }}
      />
    );
    expect(stepStates()).toEqual(["failed", "pending", "pending"]);
    expect(screen.getByText(paths.backupsDir)).toBeTruthy();
  });
});

describe("local backend gate", () => {
  function gate(status: LocalBackendStatus, platform: "electron" | "web" = "electron") {
    installNativeBridgeMock({
      platform,
      localBackend: { state: createNativeStateBridgeMock(() => status) },
    } as Parameters<typeof installNativeBridgeMock>[0]);
    return renderScreen(
      <LocalBackendGate>
        {(local) => <p data-testid="app" data-local={String(local)} />}
      </LocalBackendGate>
    );
  }

  it("renders the app at once for a remote backend", async () => {
    gate({ mode: "remote", phase: "ready" });
    expect((await screen.findByTestId("app")).getAttribute("data-local")).toBe("false");
  });

  it("keeps the startup screen until the local backend is ready and the owner is in", async () => {
    const view = gate({ mode: "local", phase: "signing_in", ...paths });
    await screen.findByRole("main");
    expect(view.container.querySelector('main[data-phase="signing_in"]')).toBeTruthy();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("renders the app in local mode once ready", async () => {
    gate({ mode: "local", phase: "ready", ...paths });
    expect((await screen.findByTestId("app")).getAttribute("data-local")).toBe("true");
  });

  it("does not wait for a native snapshot in the web build", () => {
    gate({ mode: "local", phase: "starting" }, "web");
    expect(screen.getByTestId("app").getAttribute("data-local")).toBe("false");
  });
});
