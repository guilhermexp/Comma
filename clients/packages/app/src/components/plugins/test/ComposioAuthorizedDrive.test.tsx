import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { cleanup, render, screen } from "@comma/test-utils/render";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { ComposioConnectorDetail } from "../ComposioConnectorDetail";
import { GoogleDriveBrowser } from "../../drive/GoogleDriveBrowser";

vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: vi.fn(async () => true),
}));
beforeEach(() => initializeCommaI18n(["en"]));
afterEach(cleanup);

function fixture() {
  const selected = {
    id: "googledrive_frisky-devout",
    toolkit: "googledrive",
    mode: "connect",
    status: "ACTIVE",
    enabled: true,
    name: "Member",
    email: "member@example.test",
  };
  let adopted = false;
  const status = () => ({
    mode: "connect",
    status: "connected",
    user_id: "member",
    accounts: adopted ? [selected] : [],
    next_cursor: null,
    expires_at: null,
    capabilities: { catalog: true, search: true, account_management: true },
  });
  const consent = {
    id: "expired-drive",
    toolkit: "googledrive",
    status: "expired",
    expires_at: 1,
    baseline_account_ids: ["googledrive_sandix-pudge", "googledrive_frisky-devout"],
  };
  const command = vi.fn(async (_workspace, action, params) => {
    if (action === "consent" && params.operation === "get") return { consent };
    if (action === "reconcile_accounts") {
      adopted = true;
      return { ...status(), consent, remote_accounts: [] };
    }
    if (action === "google_drive" && adopted && params.account_id === selected.id)
      return {
        files: [
          {
            id: "budget",
            name: "Authorized Drive budget",
            mime_type: "application/pdf",
            modified_at: null,
            viewed_at: null,
            url: "https://drive.google.com/file/d/budget/view",
            shortcut: null,
          },
        ],
        next_cursor: null,
        incomplete: false,
      };
    throw new Error(`Unexpected action ${action}`);
  });
  return {
    api: {
      getComposio: async () => status(),
      composioCommand: command,
    } as unknown as CommaApiClient,
    command,
  };
}

it("adopts a baseline ACTIVE Drive account after expired consent and shows Connected and files without a click", async () => {
  const f = fixture();
  const detail = render(
    <CommaI18nProvider locale="en">
      <ComposioConnectorDetail
        api={f.api}
        workspaceId="workspace"
        toolkit="googledrive"
        plugin={{ id: "drive", name: "Google Drive", summary: "Files" }}
        onBack={() => {}}
      />
    </CommaI18nProvider>
  );
  expect(await screen.findByText("Connected", { selector: "span" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Use this account" })).toBeNull();
  detail.unmount();
  render(
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={f.api}
        workspaceId="workspace"
        active
        onPlugins={() => {}}
      />
    </CommaI18nProvider>
  );
  expect(
    await screen.findByRole("button", { name: /Authorized Drive budget/ })
  ).toBeVisible();
});

it("opening Google Drive with no local account adopts an authorized account and lists files without opening Plugins", async () => {
  const f = fixture();
  const plugins = vi.fn();
  render(
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={f.api}
        workspaceId="workspace"
        active
        onPlugins={plugins}
      />
    </CommaI18nProvider>
  );
  expect(
    await screen.findByRole("button", { name: /Authorized Drive budget/ })
  ).toBeVisible();
  expect(plugins).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Open Plugins" })).toBeNull();
});
