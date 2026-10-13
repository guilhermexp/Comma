import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { render, screen, cleanup } from "@comma/test-utils/render";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { ComposioConnectorDetail } from "../ComposioConnectorDetail";
afterEach(cleanup);
it("keeps connected accounts compact and exposes account actions without repeating consent", async () => {
  initializeCommaI18n(["en"]);
  const user = userEvent.setup();
  const command = vi.fn(async () => ({ consent: null }));
  const api = { getComposio: async () => ({ mode: "connect", status: "connected", accounts: [
    { id: "account-a", name: "Casey", email: "casey@example.test", toolkit: "gmail", status: "ACTIVE", enabled: true, mode: "connect" },
    { id: "old-attempt", name: "Old attempt", toolkit: "gmail", status: "EXPIRED", enabled: true, mode: "connect" }
  ], next_cursor: null }), getAgentModels: async () => ({ agents: { router: { agent_id: "router", name: "Router" } }, workers: { items: [], next_cursor: null } }), composioCommand: command } as unknown as CommaApiClient;
  const view = () => <CommaI18nProvider locale="en"><ComposioConnectorDetail api={api} workspaceId="workspace" toolkit="gmail" plugin={{ id: "composio:gmail", name: "Gmail", summary: "Raw marketing", description: "Raw marketing" }} onBack={() => {}} /></CommaI18nProvider>;
  const mounted = render(view());
  await screen.findByText("casey@example.test");
  expect(screen.queryByRole("button", { name: "Disconnect this account" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Account options for Casey" }));
  expect(await screen.findByRole("menuitem", { name: "Verify connection" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Disconnect this account" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Connect another account" })).toBeInTheDocument();
  expect(screen.queryByText("Old attempt")).toBeNull();
  mounted.unmount();
  render(view());
  await screen.findByText("casey@example.test");
  expect(command.mock.calls.every((call) => (call as unknown[])[1] !== "connect")).toBe(true);
});
