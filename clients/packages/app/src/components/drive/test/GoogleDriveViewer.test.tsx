import { CommaI18nProvider } from "@comma/i18n/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@comma/test-utils/render";
import type { BrowserSidebarState, CommaNativeBridge } from "@comma/native-bridge";
import { afterEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { GoogleDriveBrowser } from "../GoogleDriveBrowser";

const { bridge, external } = vi.hoisted(() => ({
  external: vi.fn(async () => {}),
  bridge: {
    platform: "electron",
    browserSidebar: {
      open: vi.fn<CommaNativeBridge["browserSidebar"]["open"]>(
        async ({ sessionId, url }) => ({
          sessionId,
          url,
          active: true,
          available: true,
          visible: true,
          canGoBack: true,
        })
      ),
      update: vi.fn<CommaNativeBridge["browserSidebar"]["update"]>(
        async ({ sessionId }) => ({
          sessionId,
          active: true,
          available: true,
          visible: true,
        })
      ),
      navigate: vi.fn<CommaNativeBridge["browserSidebar"]["navigate"]>(
        async ({ sessionId }) => ({
          sessionId,
          active: true,
          available: true,
          url: "https://docs.google.com/document/d/example/edit",
          canGoForward: true,
        })
      ),
      close: vi.fn<CommaNativeBridge["browserSidebar"]["close"]>(async () => ({
        active: false,
        available: true,
      })),
      onChanged: vi.fn<CommaNativeBridge["browserSidebar"]["onChanged"]>(
        () => () => {}
      ),
      capture: vi.fn(async () => ({ status: "unavailable" as const })),
    },
  },
}));
vi.mock("@comma/native-bridge", async (original) => ({
  ...(await original<typeof import("@comma/native-bridge")>()),
  getNativeBridge: () => bridge,
}));
vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: external,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("opens a file inside Drive, follows native navigation state and restores the loaded list and scroll", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 200,
    y: 100,
    right: 1000,
    bottom: 800,
    width: 800,
    height: 700,
    left: 200,
    top: 100,
    toJSON: () => ({}),
  });
  let changed: ((state: BrowserSidebarState) => void) | undefined;
  bridge.browserSidebar.onChanged.mockImplementation((listener) => {
    changed = listener;
    return () => {};
  });
  const read = vi.fn(async () => ({
    files: [
      {
        id: "example",
        name: "Project outline",
        mime_type: "application/pdf",
        modified_at: null,
        viewed_at: null,
        url: "https://drive.google.com/file/d/example/view",
        shortcut: null,
      },
    ],
    incomplete: false,
    next_cursor: null,
  }));
  const api = {
    getComposio: async () => ({
      mode: "connect",
      accounts: [
        {
          id: "one",
          name: "Member",
          toolkit: "googledrive",
          status: "ACTIVE",
          enabled: true,
          mode: "connect",
        },
      ],
      next_cursor: null,
    }),
    composioCommand: read,
  } as unknown as CommaApiClient;
  const mounted = render(
    <CommaI18nProvider locale="en">
      <GoogleDriveBrowser
        api={api}
        workspaceId="workspace"
        active
        onPlugins={() => {}}
      />
    </CommaI18nProvider>
  );
  const file = await screen.findByRole("button", { name: "Project outline" });
  const viewport = mounted.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]'
  )!;
  viewport.scrollTop = 360;
  fireEvent.click(file);
  await screen.findByRole("button", { name: "Back to files" });
  await waitFor(() => expect(bridge.browserSidebar.open).toHaveBeenCalled());
  const request = bridge.browserSidebar.open.mock.calls[0]![0];
  expect(request).toMatchObject({
    url: "https://drive.google.com/file/d/example/view",
    profile: "google-drive",
  });
  expect(external).not.toHaveBeenCalled();
  act(() =>
    changed?.({
      sessionId: request.sessionId,
      active: true,
      available: true,
      url: "https://docs.google.com/document/d/example/edit",
      canGoBack: true,
    })
  );
  expect(screen.getByText("docs.google.com")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
  expect(external).toHaveBeenCalledWith(
    "https://docs.google.com/document/d/example/edit"
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
  expect(screen.getByRole("button", { name: "Project outline" })).toBeVisible();
  expect(viewport.scrollTop).toBe(360);
  expect(read).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(bridge.browserSidebar.close).toHaveBeenCalledWith({
      sessionId: request.sessionId,
    })
  );
});
