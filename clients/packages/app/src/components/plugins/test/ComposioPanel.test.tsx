import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { render, screen, waitFor, cleanup } from "@comma/test-utils/render";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommaApiClient, ComposioStatus } from "../../../api";
import { ComposioConnectorDetail } from "../ComposioConnectorDetail";
import { openNativePlatformExternalUrl } from "../../../runtime-chat/nativePlatformActions";
vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: vi.fn(async () => true),
}));
beforeEach(() => initializeCommaI18n(["en"]));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const signedOut: ComposioStatus = {
  mode: "connect",
  status: "signed_out",
  user_id: "member",
  accounts: [],
  next_cursor: null,
  capabilities: { catalog: false, search: true, account_management: false },
  expires_at: null,
};
function show(api: Partial<CommaApiClient>) {
  return render(
    <CommaI18nProvider locale="en">
      <ComposioConnectorDetail
        plugin={{ id: "composio:github", name: "GitHub", summary: "Code hosting" }}
        toolkit="github"
        api={api as CommaApiClient}
        workspaceId="workspace"
        onBack={() => {}}
      />
    </CommaI18nProvider>
  );
}
it("opening consent stays pending until server verification and supports cancellation", async () => {
  const user = userEvent.setup();
  let status = signedOut;
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "authorize") {
      status = { ...signedOut, status: "pending", expires_at: Date.now() + 600000 };
      return { authorization_url: "https://connect.composio.dev/authorize" };
    }
    status = signedOut;
    return { status: "cancelled" };
  });
  show({ getComposio: async () => status, composioCommand });
  await user.click(
    await screen.findByRole("button", { name: "Sign in with Composio" })
  );
  await waitFor(() => expect(openNativePlatformExternalUrl).toHaveBeenCalledOnce());
  expect(screen.queryByText("Connected", { exact: true })).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Cancel authorization" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenLastCalledWith("workspace", "cancel", {})
  );
  expect(screen.queryByRole("button", { name: "Reopen authorization" })).toBeNull();
});
it("project validation failure leaves the password field empty and does not claim connected", async () => {
  const user = userEvent.setup();
  show({
    getComposio: async () => signedOut,
    composioCommand: async () => {
      throw new Error("invalid key");
    },
  });
  await user.click(await screen.findByRole("button", { name: "Use project key" }));
  const key = screen.getByLabelText(/Project API key/);
  await user.type(key, "private-test-key");
  await user.click(screen.getByRole("button", { name: "Validate and save" }));
  await screen.findByRole("alert");
  expect(key).toHaveValue("");
  expect(screen.queryByText("Connected", { exact: true })).toBeNull();
});

it("app consent reopen and cancel address the selected account, not the Composio sign-in", async () => {
  const user = userEvent.setup();
  const composioCommand = vi
    .fn()
    .mockResolvedValue({ authorization_url: "https://provider.example/consent" });
  show({
    getComposio: async () => ({
      ...signedOut,
      mode: "project",
      status: "connected",
      accounts: [
        {
          id: "selected-account",
          name: "Linear",
          toolkit: "github",
          mode: "project",
          status: "INITIATED",
          enabled: true,
        },
      ],
    }),
    getAgentModels: vi.fn().mockResolvedValue({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
    composioCommand,
  });
  await user.click(await screen.findByRole("button", { name: "Reopen authorization" }));
  await waitFor(() => expect(openNativePlatformExternalUrl).toHaveBeenCalledOnce());
  expect(screen.getAllByRole("button", { name: "Cancel authorization" })).toHaveLength(
    1
  );
  await user.click(screen.getByRole("button", { name: "Cancel authorization" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenLastCalledWith("workspace", "account", {
      account_id: "selected-account",
      operation: "cancel",
    })
  );
});

it("connects the selected connector from its existing detail flow", async () => {
  const user = userEvent.setup();
  const composioCommand = vi
    .fn()
    .mockResolvedValue({ authorization_url: "https://provider.example/consent" });
  show({
    getComposio: async () => ({ ...signedOut, status: "connected" }),
    composioCommand,
    getAgentModels: vi.fn().mockResolvedValue({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
  });
  await user.click(await screen.findByRole("button", { name: "Connect app GitHub" }));
  expect(composioCommand).toHaveBeenCalledWith("workspace", "connect", {
    toolkit: "github",
  });
  expect(openNativePlatformExternalUrl).toHaveBeenCalledWith(
    "https://provider.example/consent"
  );
});

it("disconnect requires confirmation for the selected account", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn().mockResolvedValue({});
  show({
    getComposio: async () => ({
      ...signedOut,
      status: "connected",
      accounts: [
        {
          id: "selected-account",
          name: "Work GitHub",
          toolkit: "github",
          mode: "connect",
          status: "ACTIVE",
          enabled: true,
        },
      ],
    }),
    getAgentModels: vi.fn().mockResolvedValue({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
    composioCommand,
  });
  await user.click(
    await screen.findByRole("button", { name: "Disconnect this account" })
  );
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "account",
    expect.objectContaining({ operation: "disconnect" })
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "account",
    expect.objectContaining({ operation: "disconnect" })
  );
  await user.click(screen.getByRole("button", { name: "Disconnect this account" }));
  const buttons = screen.getAllByRole("button", { name: "Disconnect this account" });
  await user.click(buttons[buttons.length - 1]!);
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "account", {
      account_id: "selected-account",
      operation: "disconnect",
    })
  );
});

it("selects discovered actions by label and saves their exact IDs for the chosen account", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "grant") return { tools: [] };
    if (action === "tools")
      return {
        items: [
          {
            slug: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
            name: "List repositories",
            description: "Read repository names",
          },
        ],
        next_cursor: null,
      };
    return {};
  });
  show({
    getComposio: async () => ({
      ...signedOut,
      status: "connected",
      accounts: [
        {
          id: "selected-account",
          name: "Work GitHub",
          toolkit: "github",
          mode: "connect",
          status: "ACTIVE",
          enabled: true,
        },
      ],
    }),
    getAgentModels: vi.fn().mockResolvedValue({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
    composioCommand,
  });
  await user.click(await screen.findByRole("button", { name: /Connected accounts/ }));
  await user.click(await screen.findByRole("option", { name: /Work GitHub/ }));
  await user.type(
    await screen.findByRole("textbox", { name: /Search actions by name/ }),
    "List repositories"
  );
  const searches = screen.getAllByRole("button", { name: "Search" });
  await user.click(searches[searches.length - 1]!);
  await user.click(await screen.findByRole("checkbox", { name: /List repositories/ }));
  expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", {
      name: /Results may appear in workspace conversations/,
    })
  );
  await user.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenLastCalledWith("workspace", "account", {
      operation: "grant",
      account_id: "selected-account",
      agent_id: "router",
      tools: ["GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER"],
      share_with_workspace: true,
    })
  );
});
