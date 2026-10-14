import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@comma/test-utils/render";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommaApiClient, ComposioAccount, ComposioStatus } from "../../../api";
import { ComposioConnectorDetail } from "../ComposioConnectorDetail";

vi.mock("../../../runtime-chat/nativePlatformActions", () => ({
  openNativePlatformExternalUrl: vi.fn(async () => true),
}));
beforeEach(() => {
  initializeCommaI18n(["en"]);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const account = (id: string, status = "ACTIVE"): ComposioAccount => ({
  id,
  name: id,
  status,
  toolkit: "gmail",
  mode: "connect",
  enabled: false,
});
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function fixture(
  baseline: string[] | null = [],
  expiresIn = 10_000,
  start = true,
  initialAccounts: ComposioAccount[] = []
) {
  let consent: Record<string, unknown> | null = null;
  let remote: ComposioAccount[] = [];
  let selected: ComposioAccount[] = initialAccounts;
  let hold: Promise<void> | undefined;
  const status = (): ComposioStatus => ({
    mode: "connect",
    status: "connected",
    user_id: "member",
    accounts: selected,
    next_cursor: null,
    expires_at: null,
    capabilities: { catalog: true, search: true, account_management: true },
  });
  const command = vi.fn(async (_workspace, action, params) => {
    if (action === "connect") {
      consent = {
        id: "consent",
        toolkit: "gmail",
        status: "pending",
        expires_at: Date.now() + expiresIn,
        baseline_account_ids: baseline,
      };
      return {
        consent_id: "consent",
        status: "pending",
        authorization_url: "https://provider.example/consent",
      };
    }
    if (action === "refresh_accounts") {
      await hold;
      return { ...status(), consent, remote_accounts: remote };
    }
    if (action === "consent" && params.operation === "get") return { consent };
    if (action === "consent" && params.operation === "cancel") {
      consent = { ...consent, status: "cancelled" };
      return { consent };
    }
    if (action === "consent" && params.operation === "select") {
      const chosen = remote.find(
        (item) => item.id === params.account_id && item.status === "ACTIVE"
      );
      if (!chosen) throw new Error("Account not active");
      selected = [{ ...chosen, enabled: true }];
      consent = { ...consent, status: "completed" };
      return chosen;
    }
    throw new Error(`Unexpected action ${action}`);
  });
  const page = render(
    <CommaI18nProvider locale="en">
      <ComposioConnectorDetail
        api={
          {
            getComposio: async () => status(),
            composioCommand: command,
          } as unknown as CommaApiClient
        }
        workspaceId="workspace"
        toolkit="gmail"
        plugin={{ id: "gmail", name: "Gmail", summary: "Mail" }}
        onBack={() => {}}
        startConnecting={start}
      />
    </CommaI18nProvider>
  );
  await tick();
  return {
    page,
    command,
    remote: (items: ComposioAccount[]) => {
      remote = items;
    },
    hold: (promise: Promise<void>) => {
      hold = promise;
    },
  };
}
const reads = (command: ReturnType<typeof vi.fn>) =>
  command.mock.calls.filter(([, action]) => action === "refresh_accounts").length;
const selections = (command: ReturnType<typeof vi.fn>) =>
  command.mock.calls.filter(
    ([, action, params]) => action === "consent" && params.operation === "select"
  );

it("detects one newly ACTIVE account after browser authorization and reaches Connected without a click", async () => {
  const f = await fixture();
  f.remote([account("new-mail")]);
  await tick(2000);
  expect(screen.getByText("Connected", { selector: "span" })).toBeVisible();
  expect(screen.getByText("new-mail")).toBeVisible();
  expect(selections(f.command)).toHaveLength(1);
  const count = reads(f.command);
  await tick(6000);
  expect(reads(f.command)).toBe(count);
});

it("keeps an existing connected account and its actions while consent discovery offers only unconnected candidates", async () => {
  const f = await fixture(["connected", "available"], 10_000, true, [
    { ...account("connected"), enabled: true },
  ]);
  expect(
    within(screen.getByRole("group", { name: "connected" })).getByText("Connected")
  ).toBeVisible();
  f.remote([account("connected"), account("available")]);
  await tick(2000);
  const connected = within(screen.getByRole("group", { name: "connected" }));
  expect(connected.getByText("Connected")).toBeVisible();
  expect(connected.queryByRole("button", { name: "Use this account" })).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "available" })).getByRole("button", {
      name: "Use this account",
    })
  ).toBeVisible();
  expect(selections(f.command)).toHaveLength(0);
  fireEvent.click(
    connected.getByRole("button", { name: "Account options for connected" })
  );
  await tick();
  expect(screen.getByRole("menuitem", { name: "Verify connection" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Disable in Comma" })).toBeVisible();
  expect(
    screen.getByRole("menuitem", { name: "Disconnect this account" })
  ).toBeVisible();
});

it.each([["existing"], null])(
  "keeps old or unknown-baseline accounts explicit (%j)",
  async (baseline) => {
    const f = await fixture(baseline);
    f.remote([account("existing")]);
    await tick(2000);
    expect(selections(f.command)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Use this account" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
    await tick();
    expect(screen.getByText("Connected", { selector: "span" })).toBeVisible();
  }
);

it("shows multiple new ACTIVE candidates prominently and ignores non-ACTIVE accounts", async () => {
  const f = await fixture();
  f.remote([account("one"), account("two"), account("pending", "INITIATED")]);
  await tick(2000);
  expect(selections(f.command)).toHaveLength(0);
  expect(screen.getAllByRole("button", { name: "Use this account" })).toHaveLength(2);
  expect(screen.queryByText("pending", { exact: true })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Use this account" })[1]!);
  await tick();
  expect(screen.getByText("Connected", { selector: "span" })).toBeVisible();
});

it("does not select non-ACTIVE accounts and checks on focus and visibility with one request in flight", async () => {
  const f = await fixture();
  f.remote([account("not-ready", "INITIATED")]);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  fireEvent.focus(window);
  await tick();
  const count = reads(f.command);
  fireEvent(document, new Event("visibilitychange"));
  fireEvent.focus(window);
  await tick(4000);
  expect(reads(f.command)).toBe(count);
  release();
  await tick();
  expect(selections(f.command)).toHaveLength(0);
  f.remote([account("ready")]);
  fireEvent(document, new Event("visibilitychange"));
  await tick();
  expect(screen.getByText("Connected", { selector: "span" })).toBeVisible();
});

it("stops at expiry and lets an authorized old account finish through a fresh consent", async () => {
  const f = await fixture(["authorized"], 3000);
  await tick(3000);
  const count = reads(f.command);
  await tick(8000);
  fireEvent.focus(window);
  await tick();
  expect(reads(f.command)).toBe(count);
  expect(screen.getByText(/past attempt expired/i)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect another account" }));
  await tick();
  f.remote([account("authorized")]);
  await tick(2000);
  expect(selections(f.command)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
  await tick();
  expect(screen.getByText("Connected", { selector: "span" })).toBeVisible();
});

it("does no remote refresh without pending consent and stops after cancellation or unmount", async () => {
  const idle = await fixture([], 10_000, false);
  fireEvent.focus(window);
  await tick(6000);
  expect(reads(idle.command)).toBe(0);
  idle.page.unmount();
  const f = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Cancel authorization" }));
  await tick();
  const count = reads(f.command);
  await tick(4000);
  expect(reads(f.command)).toBe(count);
  f.page.unmount();
  const active = await fixture();
  active.page.unmount();
  const before = reads(active.command);
  fireEvent.focus(window);
  await tick(6000);
  expect(reads(active.command)).toBe(before);
});
