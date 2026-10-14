import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@comma/test-utils/render";
import { CommaI18nProvider } from "@comma/i18n/react";
import { afterEach, expect, it, type Mock, vi } from "vitest";
import { CommaApiError, type CommaApiClient } from "../../../api";
import { GoogleDriveBrowser } from "../GoogleDriveBrowser";

const open = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: open,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const file = (name: string, id = name) => ({
  id,
  name,
  mime_type: "application/pdf",
  modified_at: "2026-10-13T10:00:00Z",
  viewed_at: null,
  url: "https://drive.google.com/file/d/file-1/view",
  shortcut: null,
});
const page = (name: string) => ({
  files: [file(name)],
  next_cursor: null,
  incomplete: false,
});
const account = (id: string) => ({
  id,
  name: "Member",
  email: "member@example.test",
  mode: "connect",
  toolkit: "googledrive",
  enabled: true,
  status: "ACTIVE",
});
function api(read: Mock = vi.fn(async () => page("Budget"))) {
  return {
    getComposio: vi.fn(async () => ({
      mode: "connect",
      accounts: [account("a"), account("b")],
      next_cursor: null,
    })),
    composioCommand: read,
  } as unknown as CommaApiClient;
}
function view(client: CommaApiClient, workspaceId = "workspace", active = true) {
  return (
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={client}
        workspaceId={workspaceId}
        active={active}
        onPlugins={() => {}}
      />
    </CommaI18nProvider>
  );
}
it("navigates folders, searches the current scope, pages opaque tokens, switches view without reads, refreshes and opens a safe provider file", async () => {
  const folder = {
    ...file("Reports", "folder"),
    mime_type: "application/vnd.google-apps.folder",
    url: null,
  };
  const read = vi.fn(async (_w, _a, request) =>
    request.folder_id
      ? {
          ...page(request.search ? "Match" : "Inside"),
          next_cursor: request.cursor ? null : "opaque/+== token",
        }
      : { ...page("Budget"), files: [folder, file("Budget")] }
  );
  const client = api(read);
  render(view(client));
  await screen.findByRole("button", { name: /Budget/ });
  const count = read.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
  expect(read.mock.calls.length).toBe(count);
  expect(screen.getByRole("button", { name: /Budget/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Reports/ }));
  await screen.findByRole("button", { name: /Inside/ });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(read.mock.calls.at(-1)?.[2].cursor).toBe("opaque/+== token")
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search names" }), {
    target: { value: "Q'\\x" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: /Match/ });
  expect(read.mock.calls.at(-1)?.[2]).toMatchObject({
    search: "Q'\\x",
    folder_id: "folder",
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(client.getComposio).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: /Match/ });
  fireEvent.click(screen.getByRole("button", { name: /Match/ }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith("https://drive.google.com/file/d/file-1/view")
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: /Reports/ });
  fireEvent.click(screen.getByRole("tab", { name: "Shared with me" }));
  await waitFor(() => expect(read.mock.calls.at(-1)?.[2].tab).toBe("shared"));
});
it("clears old rows and fences late account, tab, workspace and source responses", async () => {
  const pending: Array<(value: Record<string, unknown>) => void> = [];
  const read = vi.fn(
    () => new Promise<Record<string, unknown>>((resolve) => pending.push(resolve))
  );
  const client = api(read as never);
  const mounted = render(view(client));
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.change(screen.getByRole("combobox", { name: "Google account" }), {
    target: { value: "b" },
  });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[0]!(page("Old account")));
  expect(screen.queryByText("Old account")).toBeNull();
  await act(async () => pending[1]!(page("Current")));
  await screen.findByRole("button", { name: /Current/ });
  fireEvent.click(screen.getByRole("tab", { name: "My Drive" }));
  expect(screen.queryByText("Current")).toBeNull();
  await waitFor(() => expect(pending).toHaveLength(3));
  mounted.rerender(view(client, "other"));
  await waitFor(() => expect(pending).toHaveLength(4));
  await act(async () => pending[2]!(page("Old workspace")));
  expect(screen.queryByText("Old workspace")).toBeNull();
  mounted.rerender(view(client, "other", false));
  await act(async () => pending[3]!(page("Inactive")));
  expect(screen.queryByText("Inactive")).toBeNull();
});
it("distinguishes incomplete, failed, reconnect, no account and empty states without automatic OAuth", async () => {
  const read = vi.fn(async () => ({ ...page("Budget"), incomplete: true }));
  const client = api(read);
  const mounted = render(view(client));
  await screen.findByText(
    "Google returned an incomplete search. Try a narrower search or refresh."
  );
  read.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Budget")).toBeNull();
  read.mockResolvedValueOnce({ files: [], next_cursor: null, incomplete: false });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No files in this view.");
  mounted.unmount();
  const emptyClient = {
    ...client,
    getComposio: async () => ({ accounts: [], next_cursor: null }),
  } as unknown as CommaApiClient;
  render(view(emptyClient));
  await screen.findByText("Connect Google Drive in Plugins to browse online files.");
  expect(
    read.mock.calls.every((call) => (call as unknown[])[1] === "google_drive")
  ).toBe(true);
});
it("refuses renderer-side unsafe opening URLs", async () => {
  const client = api(
    vi.fn(async () => ({
      ...page("Unsafe"),
      files: [
        {
          ...file("Unsafe"),
          url: "https://drive.google.com.evil.test/file/d/file-1/view",
        },
      ],
    }))
  );
  render(view(client));
  const row = await screen.findByRole("button", { name: /Unsafe/ });
  expect(row).toBeDisabled();
  fireEvent.click(row);
  expect(open).not.toHaveBeenCalled();
});

it("keeps exact duplicate identities distinct, excludes other modes and offers reconnect after revocation", async () => {
  const read: Mock = vi.fn(async () => page("Current"));
  const client = {
    ...api(read),
    getComposio: vi.fn(async () => ({
      mode: "connect",
      accounts: [
        account("a"),
        account("b"),
        { ...account("project"), mode: "project" },
      ],
      next_cursor: null,
    })),
  } as unknown as CommaApiClient;
  render(view(client));
  await screen.findByRole("button", { name: "Current" });
  expect(screen.getByRole("option", { name: /Connection 1/ })).toHaveValue("a");
  expect(screen.getByRole("option", { name: /Connection 2/ })).toHaveValue("b");
  expect(
    screen
      .getAllByRole("option")
      .some((option) => (option as HTMLOptionElement).value === "project")
  ).toBe(false);
  read.mockRejectedValueOnce(
    new CommaApiError(403, "denied", { error: "composio_access_denied" })
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Google account" }), {
    target: { value: "b" },
  });
  await screen.findByText(
    "This connection is unavailable. Verify or reconnect it in Plugins."
  );
  expect(screen.queryByText("Current")).toBeNull();
  expect(read.mock.calls.at(-1)?.[2]).toMatchObject({ account_id: "b" });
});
