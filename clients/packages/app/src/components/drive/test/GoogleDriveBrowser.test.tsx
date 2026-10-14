import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@comma/test-utils/render";
import { CommaI18nProvider } from "@comma/i18n/react";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import { CommaApiError, type CommaApiClient } from "../../../api";
import { GoogleDriveBrowser } from "../GoogleDriveBrowser";

const open = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: open,
}));
let reachEnd: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-slot") === "scroll-area-load-more")
          reachEnd = () =>
            this.callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            );
      }
      unobserve() {}
      disconnect() {
        reachEnd = undefined;
      }
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const file = (name: string, id = name) => ({
  id,
  name,
  mime_type: "application/pdf",
  modified_at: "2026-10-13T10:00:00Z",
  viewed_at: null as string | null,
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
  act(() => reachEnd?.());
  await waitFor(() =>
    expect(read.mock.calls.at(-1)?.[2].cursor).toBe("opaque/+== token")
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search names" }), {
    target: { value: "Q'\\x" },
  });
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
  await screen.findByText(
    "No authorized Google Drive account is available. Connect Google Drive in Plugins."
  );
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

it("offers different authorized identities directly in Drive and lists the chosen account without Plugins", async () => {
  const candidates = [
    {
      ...account("personal"),
      name: "Personal",
      email: "personal@example.test",
      enabled: false,
    },
    { ...account("work"), name: "Work", email: "work@example.test", enabled: false },
  ];
  let selected: (typeof candidates)[number] | undefined;
  const status = () => ({
    mode: "connect",
    status: "connected",
    user_id: "member",
    accounts: selected ? [{ ...selected, enabled: true }] : [],
    next_cursor: null,
    expires_at: null,
    capabilities: { catalog: true, search: true, account_management: true },
  });
  const command = vi.fn(async (_workspace, action, params) => {
    if (action === "reconcile_accounts") {
      if (params.account_id)
        selected = candidates.find((item) => item.id === params.account_id);
      return { ...status(), consent: null, remote_accounts: candidates };
    }
    if (action === "google_drive")
      return page(
        params.account_id === "work" ? "Work budget" : "Wrong identity budget"
      );
    throw new Error(`Unexpected action ${action}`);
  });
  const plugins = vi.fn();
  render(
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={
          {
            getComposio: async () => status(),
            composioCommand: command,
          } as unknown as CommaApiClient
        }
        workspaceId="workspace"
        active
        onPlugins={plugins}
      />
    </CommaI18nProvider>
  );
  const work = await screen.findByRole("group", { name: "Work · work@example.test" });
  expect(screen.getAllByRole("button", { name: "Use this account" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /budget/ })).toBeNull();
  fireEvent.click(within(work).getByRole("button", { name: "Use this account" }));
  expect(await screen.findByRole("button", { name: /Work budget/ })).toBeVisible();
  expect(screen.queryByText("Wrong identity budget")).toBeNull();
  expect(plugins).not.toHaveBeenCalled();
  expect(
    command.mock.calls.filter(([, action]) => action === "reconcile_accounts")
  ).toHaveLength(2);
});

it("keeps loaded pages while loading once, then fences a late page after changing scope", async () => {
  let finish: ((value: ReturnType<typeof page>) => void) | undefined;
  const read = vi.fn(async (_workspace, _action, request) => {
    if (request.cursor)
      return new Promise<ReturnType<typeof page>>((resolve) => {
        finish = resolve;
      });
    return {
      ...page(request.tab === "shared" ? "Shared item" : "First item"),
      next_cursor: request.tab === "shared" ? null : "exact/+== token",
    };
  });
  render(view(api(read)));
  await screen.findByRole("button", { name: "First item" });
  act(() => {
    reachEnd?.();
    reachEnd?.();
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[1]?.[2].cursor).toBe("exact/+== token");
  expect(screen.getByRole("button", { name: "First item" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Shared with me" }));
  await screen.findByRole("button", { name: "Shared item" });
  await act(async () => finish?.(page("Late item")));
  expect(screen.queryByText("Late item")).toBeNull();
  expect(read.mock.calls[2]?.[2].cursor).toBeUndefined();
});
it("shows skeleton status until data arrives and never calls a modified date opened", async () => {
  let finish: ((value: ReturnType<typeof page>) => void) | undefined;
  const read = vi.fn(
    () =>
      new Promise<ReturnType<typeof page>>((resolve) => {
        finish = resolve;
      })
  );
  render(view(api(read)));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(screen.getByRole("status", { name: "Loading Google Drive…" })).toBeVisible();
  await act(async () =>
    finish?.({
      ...page("Modified only"),
      files: [
        file("Modified only"),
        { ...file("Viewed"), viewed_at: "2026-10-12T10:00:00Z" },
      ],
    })
  );
  const modified = screen.getByRole("button", { name: "Modified only" });
  expect(within(modified).getByText(/Modified Oct/)).toBeVisible();
  expect(within(modified).queryByText(/Opened/)).toBeNull();
  expect(
    within(screen.getByRole("button", { name: "Viewed" })).getByText(/Opened Oct/)
  ).toBeVisible();
});
it("debounces typed searches and clears them in the active tab", async () => {
  const read = vi.fn(async () => page("Result"));
  render(view(api(read)));
  await screen.findByRole("button", { name: "Result" });
  vi.useFakeTimers();
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "ab" } });
  await act(async () => {
    vi.advanceTimersByTime(299);
  });
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.change(search, { target: { value: "abc" } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.at(-1)).toEqual(
    expect.arrayContaining([expect.objectContaining({ search: "abc", tab: "recent" })])
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(read).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});
