import { CommaI18nProvider } from "@comma/i18n/react";
import { cleanup, fireEvent, render, screen, within } from "@comma/test-utils/render";
import { afterEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { GoogleDriveBrowser } from "../GoogleDriveBrowser";

afterEach(cleanup);
it("starts in a card grid and separates folders from items in My Drive", async () => {
  const api = {
    getComposio: async () => ({
      mode: "connect",
      accounts: [
        {
          id: "one",
          name: "Member",
          email: "member@example.test",
          toolkit: "googledrive",
          status: "ACTIVE",
          enabled: true,
          mode: "connect",
        },
      ],
      next_cursor: null,
    }),
    composioCommand: vi.fn(async () => ({
      files: [
        {
          id: "folder",
          name: "Team resources",
          mime_type: "application/vnd.google-apps.folder",
          modified_at: null,
          viewed_at: null,
          url: null,
          shortcut: null,
        },
        {
          id: "document",
          name: "Project outline",
          mime_type: "application/pdf",
          modified_at: "2026-10-13T10:00:00Z",
          viewed_at: null,
          url: "https://drive.google.com/file/d/document/view",
          shortcut: null,
        },
      ],
      next_cursor: null,
      incomplete: false,
    })),
  } as unknown as CommaApiClient;
  render(
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={api}
        workspaceId="workspace"
        active
        onPlugins={() => {}}
      />
    </CommaI18nProvider>
  );
  await screen.findByRole("button", { name: "Project outline" });
  expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "My Drive" }));
  const folders = await screen.findByRole("region", { name: "Folders" });
  const items = screen.getByRole("region", { name: "Items" });
  expect(within(folders).getByRole("button", { name: "Team resources" })).toBeVisible();
  expect(within(items).getByRole("button", { name: "Project outline" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Google account" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  const table = screen.getByRole("table");
  expect(within(table).getByRole("button", { name: "Project outline" })).toBeVisible();
  expect(
    within(table).getByRole("columnheader", { name: "Last viewed by you" })
  ).toBeVisible();
});
