import { CommaI18nProvider } from "@comma/i18n/react";
import { render, screen, cleanup, waitFor, within } from "@comma/test-utils/render";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { ComposioConnectorDetail } from "../ComposioConnectorDetail";

afterEach(cleanup);
function setup() {
  const command = vi.fn(async () => ({ consent: null }));
  const api = {
    getComposio: async () => ({
      mode: "connect",
      status: "connected",
      accounts: [
        {
          id: "account-a",
          name: "Casey",
          email: "casey@example.test",
          toolkit: "gmail",
          status: "ACTIVE",
          enabled: true,
          mode: "connect",
        },
        {
          id: "old-attempt",
          name: "Old attempt",
          toolkit: "gmail",
          status: "EXPIRED",
          enabled: true,
          mode: "connect",
        },
      ],
      next_cursor: null,
    }),
    getAgentModels: async () => ({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
    composioCommand: command,
  } as unknown as CommaApiClient;
  const view = () => (
    <CommaI18nProvider locale="en">
      <ComposioConnectorDetail
        api={api}
        workspaceId="workspace"
        toolkit="gmail"
        plugin={{
          id: "composio:gmail",
          name: "Gmail",
          summary: "Raw marketing",
          description: "Raw marketing",
        }}
        onBack={() => {}}
      />
    </CommaI18nProvider>
  );
  return { command, view };
}
it("keeps connected accounts compact and exposes account actions", async () => {
  const { view } = setup();
  const user = userEvent.setup();
  render(view());
  const account = await screen.findByRole("group", {
    name: "Casey · casey@example.test",
  });
  expect(
    within(account).queryByRole("button", { name: "Disconnect this account" })
  ).toBeNull();
  expect(screen.queryByText("Old attempt")).toBeNull();
  await user.click(
    within(account).getByRole("button", { name: "Account options for Casey" })
  );
  const menu = await screen.findByRole("menu", { name: "Account options for Casey" });
  expect(
    within(menu).getByRole("menuitem", { name: "Verify connection" })
  ).toBeInTheDocument();
  expect(
    within(menu).getByRole("menuitem", { name: "Disconnect this account" })
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(
    await screen.findByRole("button", { name: "Connect another account" })
  ).toBeInTheDocument();
});
it("reopens a connected account without repeating consent", async () => {
  const { command, view } = setup();
  const mounted = render(view());
  await screen.findByText("casey@example.test");
  mounted.unmount();
  render(view());
  await screen.findByText("casey@example.test");
  expect(command.mock.calls.every((call) => (call as unknown[])[1] !== "connect")).toBe(
    true
  );
});
