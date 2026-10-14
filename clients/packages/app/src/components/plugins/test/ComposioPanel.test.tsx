import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { render, screen, waitFor, cleanup, within } from "@comma/test-utils/render";
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
type Consent = {
  id: string;
  toolkit: string;
  status: "starting" | "pending" | "selecting" | "completed" | "cancelled" | "expired";
  expires_at: number;
};
function show(
  api: Partial<CommaApiClient>,
  consent: Consent | null | (() => Consent | null) = null,
  startConnecting = false
) {
  const originalCommand = api.composioCommand;
  const getConsent = () => (typeof consent === "function" ? consent() : consent);
  let composioCommand: CommaApiClient["composioCommand"];
  if (originalCommand && vi.isMockFunction(originalCommand)) {
    const implementation = originalCommand.getMockImplementation();
    originalCommand.mockImplementation(async (workspace, action, params, options) => {
      if (action === "consent" && params?.operation === "get")
        return { consent: getConsent() };
      const result = implementation
        ? await implementation(workspace, action, params, options)
        : {};
      return result;
    });
    composioCommand = originalCommand;
  } else {
    composioCommand = async (workspace, action, params = {}, options) => {
      if (action === "consent" && params.operation === "get")
        return { consent: getConsent() };
      const result = originalCommand
        ? await originalCommand(workspace, action, params, options)
        : {};
      return result;
    };
  }
  return render(
    <CommaI18nProvider locale="en">
      <ComposioConnectorDetail
        plugin={{ id: "composio:github", name: "GitHub", summary: "Code hosting" }}
        toolkit="github"
        api={
          {
            getAgentModels: async () => ({
              agents: { router: { agent_id: "router", name: "Router" } },
              workers: { items: [], next_cursor: null },
            }),
            ...api,
            composioCommand,
          } as CommaApiClient
        }
        workspaceId="workspace"
        onBack={() => {}}
        startConnecting={startConnecting}
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
    expect(composioCommand).toHaveBeenCalledWith("workspace", "cancel", {})
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
  await screen.findByText("Inactive accounts and past attempts");
  await user.click(screen.getByText("Inactive accounts and past attempts"));
  await user.click(screen.getByRole("button", { name: "Account options for Linear" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Reopen authorization" })
  );
  await waitFor(() => expect(openNativePlatformExternalUrl).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Account options for Linear" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Cancel authorization" })
  );
  await waitFor(() =>
    expect(composioCommand).toHaveBeenLastCalledWith("workspace", "account", {
      account_id: "selected-account",
      operation: "cancel",
    })
  );
});

it("connects the selected connector from its existing detail flow", async () => {
  const user = userEvent.setup();
  let consent: Consent | null = null;
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "connect") {
      consent = {
        id: "github-connect-flow-consent",
        toolkit: "github",
        status: "pending",
        expires_at: Date.now() + 60_000,
      };
      return {
        consent_id: "github-connect-flow-consent",
        authorization_url: "https://provider.example/consent",
        status: "pending",
      };
    }
    return {};
  });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
      getAgentModels: vi.fn().mockResolvedValue({
        agents: { router: { agent_id: "router", name: "Router" } },
        workers: { items: [], next_cursor: null },
      }),
    },
    () => consent
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect another account" })
  );
  expect(composioCommand).toHaveBeenCalledWith("workspace", "connect", {
    toolkit: "github",
  });
  expect(openNativePlatformExternalUrl).toHaveBeenCalledWith(
    "https://provider.example/consent"
  );
});

it("keeps project-mode connector authorization separate from Connect consent", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn().mockResolvedValue({
    account_id: "project-account",
    authorization_url: "https://provider.example/project-consent",
    status: "pending",
  });
  show({
    getComposio: async () => ({
      ...signedOut,
      mode: "project",
      status: "connected",
    }),
    composioCommand,
  });

  await user.click(
    await screen.findByRole("button", { name: "Connect another account" })
  );
  await waitFor(() => expect(openNativePlatformExternalUrl).toHaveBeenCalledOnce());
  expect(openNativePlatformExternalUrl).toHaveBeenCalledWith(
    "https://provider.example/project-consent"
  );
  expect(composioCommand).toHaveBeenCalledWith("workspace", "connect", {
    toolkit: "github",
  });
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "consent",
    expect.anything()
  );
  expect(screen.queryByText(/choose which account to use/)).toBeNull();
});

it("keeps a single initiated account unselectable until provider authorization completes", async () => {
  const composioCommand = vi.fn().mockResolvedValue({});
  show(
    {
      getComposio: async () => ({
        ...signedOut,
        status: "connected",
        accounts: [
          {
            id: "only-initiated-account",
            name: "Personal GitHub",
            toolkit: "github",
            mode: "connect",
            status: "INITIATED",
            enabled: false,
          },
        ],
      }),
      composioCommand,
      getAgentModels: vi.fn().mockResolvedValue({
        agents: { router: { agent_id: "router", name: "Router" } },
        workers: { items: [], next_cursor: null },
      }),
    },
    {
      id: "github-consent-1",
      toolkit: "github",
      status: "pending",
      expires_at: Date.now() + 60_000,
    }
  );

  expect(
    await screen.findByText(
      "Complete authorization in your browser. Comma detects the account automatically. If a choice is needed, select Use this account."
    )
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use this account" })).toBeNull();
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "consent",
    expect.objectContaining({ operation: "select" })
  );
});

it("does not start another Add after cancelling consent on an auto-connect detail", async () => {
  const user = userEvent.setup();
  let consent: Consent | null = {
    id: "github-auto-consent",
    toolkit: "github",
    status: "pending",
    expires_at: Date.now() + 60_000,
  };
  const composioCommand = vi.fn(async (_workspace, action, params) => {
    if (action === "consent" && params?.operation === "cancel") {
      consent = { ...consent!, status: "cancelled" };
      return { status: "cancelled" };
    }
    if (action === "connect")
      return {
        consent_id: "unexpected-consent",
        authorization_url: "https://provider.example/unexpected-consent",
        status: "pending",
      };
    return {};
  });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
    },
    () => consent,
    true
  );

  expect(
    await screen.findByRole("button", { name: "Cancel authorization" })
  ).toBeInTheDocument();
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "connect",
    expect.anything()
  );
  await user.click(screen.getByRole("button", { name: "Cancel authorization" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "consent", {
      toolkit: "github",
      consent_id: "github-auto-consent",
      operation: "cancel",
    })
  );
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "connect",
    expect.anything()
  );
});

it("refreshes consent after a failed Connect request so starting can be cancelled", async () => {
  const user = userEvent.setup();
  let consent: Consent | null = null;
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "connect") {
      consent = {
        id: "github-uncertain-consent",
        toolkit: "github",
        status: "starting",
        expires_at: Date.now() + 60_000,
      };
      throw new Error("connection result was lost");
    }
    return {};
  });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
    },
    () => consent
  );

  await user.click(
    await screen.findByRole("button", { name: "Connect another account" })
  );
  expect(
    await screen.findByRole("button", { name: "Cancel authorization" })
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reopen authorization" })).toBeNull();
  expect(composioCommand).toHaveBeenCalledWith(
    "workspace",
    "consent",
    { toolkit: "github", operation: "get" },
    {}
  );
});

it("reopens and cancels the pending consent by its ID without profile login actions", async () => {
  const user = userEvent.setup();
  let consent: Consent | null = {
    id: "github-consent-2",
    toolkit: "github",
    status: "pending",
    expires_at: Date.now() + 60_000,
  };
  const composioCommand = vi.fn(async (_workspace, action, params) => {
    if (action === "consent" && params?.operation === "reopen")
      return { authorization_url: "https://provider.example/private-consent" };
    if (action === "consent" && params?.operation === "cancel") {
      consent = { ...consent!, status: "cancelled" };
      return { status: "cancelled" };
    }
    return {};
  });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
    },
    () => consent
  );

  await user.click(await screen.findByRole("button", { name: "Reopen authorization" }));
  await waitFor(() => expect(openNativePlatformExternalUrl).toHaveBeenCalledOnce());
  expect(composioCommand).toHaveBeenCalledWith("workspace", "consent", {
    toolkit: "github",
    consent_id: "github-consent-2",
    operation: "reopen",
  });

  await user.click(await screen.findByRole("button", { name: "Cancel authorization" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "consent", {
      toolkit: "github",
      consent_id: "github-consent-2",
      operation: "cancel",
    })
  );
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "authorize",
    expect.anything()
  );
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "cancel",
    expect.anything()
  );
});

it("selects the explicitly named connection when two connections share a provider identity", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn().mockResolvedValue({});
  show(
    {
      getComposio: async () => ({
        ...signedOut,
        status: "connected",
        accounts: [
          {
            id: "verified-account-one",
            name: "Casey Example <casey@example.test> (verified-account-one)",
            toolkit: "github",
            mode: "connect",
            status: "ACTIVE",
            enabled: true,
          },
          {
            id: "verified-account-two",
            name: "Casey Example <casey@example.test> (verified-account-two)",
            toolkit: "github",
            mode: "connect",
            status: "ACTIVE",
            enabled: true,
          },
        ],
      }),
      composioCommand,
      getAgentModels: vi.fn().mockResolvedValue({
        agents: { router: { agent_id: "router", name: "Router" } },
        workers: { items: [], next_cursor: null },
      }),
    },
    {
      id: "github-consent-3",
      toolkit: "github",
      status: "pending",
      expires_at: Date.now() + 60_000,
    }
  );

  await screen.findAllByText("casey@example.test");
  await user.click(
    within(
      screen.getByRole("group", {
        name: "Casey Example · casey@example.test · Connection 2",
      })
    ).getByRole("button", { name: "Use this account" })
  );
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "consent", {
      toolkit: "github",
      consent_id: "github-consent-3",
      operation: "select",
      account_id: "verified-account-two",
    })
  );
});

it("does not treat a consent URL as a connected account", async () => {
  const user = userEvent.setup();
  let consent: Consent | null = null;
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "connect") {
      consent = {
        id: "github-consent-4",
        toolkit: "github",
        status: "pending",
        expires_at: Date.now() + 60_000,
      };
      return {
        consent_id: "github-consent-4",
        authorization_url: "https://provider.example/private-consent",
        status: "pending",
      };
    }
    return {};
  });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
      getAgentModels: vi.fn().mockResolvedValue({
        agents: { router: { agent_id: "router", name: "Router" } },
        workers: { items: [], next_cursor: null },
      }),
    },
    () => consent
  );

  await user.click(
    await screen.findByRole("button", { name: "Connect another account" })
  );
  expect(
    await screen.findByText(
      "Complete authorization in your browser. Comma detects the account automatically. If a choice is needed, select Use this account."
    )
  ).toBeInTheDocument();
  expect(openNativePlatformExternalUrl).toHaveBeenCalledWith(
    "https://provider.example/private-consent"
  );
  expect(
    await screen.findByText(
      "No verified accounts for this app. Connect an account to continue."
    )
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use this account" })).toBeNull();
});

it("allows cancellation while consent is starting and hides reopen", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn().mockResolvedValue({ status: "cancelled" });
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
    },
    {
      id: "github-consent-starting",
      toolkit: "github",
      status: "starting",
      expires_at: Date.now() + 60_000,
    }
  );

  expect(
    await screen.findByRole("button", { name: "Cancel authorization" })
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reopen authorization" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel authorization" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "consent", {
      toolkit: "github",
      consent_id: "github-consent-starting",
      operation: "cancel",
    })
  );
});

it("explains expired app consent without requiring a working account to sign in again", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn(async (_workspace, action) =>
    action === "connect"
      ? {
          consent_id: "new-github-attempt",
          authorization_url: "https://provider.example/consent",
          status: "pending",
        }
      : { enabled: false }
  );
  show(
    {
      getComposio: async () => ({
        ...signedOut,
        status: "connected",
        accounts: [
          {
            id: "working-account",
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
    },
    {
      id: "old-github-attempt",
      toolkit: "github",
      status: "expired",
      expires_at: Date.now() - 60_000,
    }
  );

  await screen.findByText("Connected", { selector: "span" });
  const expiry = screen.getByText(/past attempt expired/i);
  expect(expiry).toHaveTextContent(/Existing connections are unaffected/i);
  expect(expiry).toHaveTextContent(/Connect another account/i);
  expect(screen.queryByRole("button", { name: "Sign in with Composio" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel authorization" })).toBeNull();
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "connect",
    expect.anything()
  );

  await user.click(screen.getByRole("button", { name: "Connect another account" }));
  expect(composioCommand).toHaveBeenCalledWith("workspace", "connect", {
    toolkit: "github",
  });
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "authorize",
    expect.anything()
  );
});

it("does not offer automatic recovery actions while consent is selecting", async () => {
  const composioCommand = vi.fn().mockResolvedValue({});
  show(
    {
      getComposio: async () => ({ ...signedOut, status: "connected" }),
      composioCommand,
    },
    {
      id: "github-consent-selecting",
      toolkit: "github",
      status: "selecting",
      expires_at: Date.now() + 60_000,
    }
  );

  expect(
    await screen.findByText(
      "Account selection is in progress. If this status remains, contact support."
    )
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reopen authorization" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel authorization" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Use this account" })).toBeNull();
  expect(composioCommand).not.toHaveBeenCalledWith(
    "workspace",
    "consent",
    expect.objectContaining({ operation: expect.anything() })
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
    await screen.findByRole("button", { name: "Account options for Work GitHub" })
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Disconnect this account" })
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
  await user.click(
    screen.getByRole("button", { name: "Account options for Work GitHub" })
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Disconnect this account" })
  );
  await user.click(screen.getByRole("button", { name: "Disconnect this account" }));
  await waitFor(() =>
    expect(composioCommand).toHaveBeenCalledWith("workspace", "account", {
      account_id: "selected-account",
      operation: "disconnect",
    })
  );
});

it("authorizes the exact account for an agent with explicit workspace audience consent", async () => {
  const user = userEvent.setup();
  const composioCommand = vi.fn(async (_workspace, action) => {
    if (action === "grant") return { enabled: false };
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
  await user.click(await screen.findByRole("button", { name: "Manage" }));
  expect(await screen.findByRole("button", { name: "Save access" })).toBeDisabled();
  await screen.findByText("This account is not authorized for this agent.");
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
      enabled: true,
      share_with_workspace: true,
    })
  );
  expect(composioCommand.mock.calls.some((call) => call[1] === "tools")).toBe(false);
});
