import { cleanup, render, screen } from "@comma/test-utils/render";
import { initializeCommaI18n } from "@comma/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { DriveRoute } from "../DriveRoute";

vi.mock("../../auth-context", () => ({ useCommaAuth: () => ({ api: { listWorkspaces: async () => [], getComposio: async () => ({ accounts: [], next_cursor: null }) } }) }));
vi.mock("../../chat/ChatProvider", () => ({ useChatRegistry: () => ({}), isStaleChatSessionError: () => false }));
vi.mock("../../chat-sidebar/ChatSidebarContext", () => ({ driveSidebarHost: {}, useRegisterChatSidebarHost: () => {}, useChatSidebar: () => ({ closeDrivePreview: () => {}, openDrivePreview: () => {} }) }));
vi.mock("../../application-menu/useApplicationMenu", () => ({ useApplicationMenu: () => {} }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {}, useSearch: () => ({}) }));
vi.mock("../driveBackend", async (original) => ({ ...await original<typeof import("../driveBackend")>(), getDriveBackend: () => undefined }));
afterEach(cleanup);
it("offers Google Drive alongside the existing local Drive", () => {
  initializeCommaI18n(["en"]);
  render(<DriveRoute />);
  expect(screen.getByRole("button", { name: "Google Drive" })).toBeVisible();
  expect(screen.getByTestId("drive-file-pane")).toBeVisible();
});
