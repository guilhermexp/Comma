import { cleanup, fireEvent, render, screen, waitFor } from "@comma/test-utils/render";
import { initializeCommaI18n } from "@comma/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { DriveRoute } from "../DriveRoute";

const client = vi.hoisted(() => ({
  listWorkspaces: vi.fn(async () => [{ id: "workspace", status: "ready" }]),
  getComposio: vi.fn(async () => ({
    mode: "connect",
    accounts: [
      {
        id: "exact",
        name: "Member",
        email: "member@example.test",
        mode: "connect",
        toolkit: "googledrive",
        enabled: true,
        status: "ACTIVE",
      },
    ],
    next_cursor: null,
  })),
  composioCommand: vi.fn(async () => ({
    files: [
      {
        id: "remote",
        name: "Online report",
        mime_type: "application/pdf",
        modified_at: null,
        viewed_at: null,
        url: null,
        shortcut: null,
      },
    ],
    next_cursor: null,
    incomplete: false,
  })),
}));
vi.mock("../../auth-context", () => ({ useCommaAuth: () => ({ api: client }) }));
vi.mock("../../chat/ChatProvider", () => ({
  useChatRegistry: () => ({}),
  isStaleChatSessionError: () => false,
}));
vi.mock("../../chat-sidebar/ChatSidebarContext", () => ({
  driveSidebarHost: {},
  useRegisterChatSidebarHost: () => {},
  useChatSidebar: () => ({ closeDrivePreview: () => {}, openDrivePreview: () => {} }),
}));
vi.mock("../../application-menu/useApplicationMenu", () => ({
  useApplicationMenu: () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useSearch: () => ({}),
}));
vi.mock("../driveBackend", async (original) => ({
  ...(await original<typeof import("../driveBackend")>()),
  getDriveBackend: () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("switches to real online rows and back to the same local pane; re-entry refreshes only the online source", async () => {
  initializeCommaI18n(["en"]);
  render(<DriveRoute />);
  const local = screen.getByTestId("drive-file-pane");
  expect(local).toBeVisible();
  expect(client.getComposio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
  await screen.findByRole("button", { name: "Online report" });
  expect(local).not.toBeVisible();
  expect(client.composioCommand).toHaveBeenLastCalledWith(
    "workspace",
    "google_drive",
    expect.objectContaining({ account_id: "exact", tab: "recent" }),
    expect.anything()
  );
  fireEvent.click(screen.getByRole("button", { name: "Local Drive" }));
  expect(screen.getByTestId("drive-file-pane")).toBe(local);
  expect(local).toBeVisible();
  expect(screen.queryByRole("button", { name: "Online report" })).toBeNull();
  const reads = client.composioCommand.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
  await waitFor(() =>
    expect(client.composioCommand.mock.calls.length).toBeGreaterThan(reads)
  );
  await screen.findByRole("button", { name: "Online report" });
});
