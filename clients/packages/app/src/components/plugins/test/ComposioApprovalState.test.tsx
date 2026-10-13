import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { render, screen, cleanup, act } from "@comma/test-utils/render";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../api";
import { ComposioAccessPanel } from "../ComposioAccessPanel";

afterEach(cleanup);

it("shows an empty approval state only after successful loading and recovers real requests after an error", async () => {
  initializeCommaI18n(["en"]);
  const user = userEvent.setup();
  let resolvePage!: (value: unknown) => void;
  const command = vi.fn<CommaApiClient["composioCommand"]>();
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePage = resolve;
      })
  );
  const api = {
    composioCommand: command,
    getAgentModels: async () => ({
      agents: { router: { agent_id: "router", name: "Router" } },
      workers: { items: [], next_cursor: null },
    }),
  } as unknown as CommaApiClient;
  render(
    <CommaI18nProvider locale="en">
      <ComposioAccessPanel
        api={api}
        workspaceId="workspace"
        accounts={[
          {
            id: "account",
            name: "Casey",
            toolkit: "gmail",
            status: "ACTIVE",
            enabled: true,
            mode: "connect",
          },
        ]}
      />
    </CommaI18nProvider>
  );
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => resolvePage({ requests: [], next_cursor: null }));
  expect(await screen.findByRole("status")).toBeVisible();

  let rejectPage!: (reason: Error) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPage = reject;
      })
  );
  await user.click(screen.getByRole("button", { name: "Refresh pending actions" }));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => rejectPage(new Error("unavailable")));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();

  command.mockResolvedValueOnce({
    requests: [
      {
        request_id: "request",
        source_agent_id: "router",
        request_payload: {
          account_id: "account",
          account_name: "Casey",
          tools: [{ tool_slug: "GMAIL_LIST_LABELS", arguments: { user_id: "me" } }],
        },
      },
    ],
    next_cursor: null,
  });
  await user.click(screen.getByRole("button", { name: "Refresh pending actions" }));
  expect(
    await screen.findByRole("button", { name: "Approve this action once" })
  ).toBeEnabled();
  expect(screen.getByText("GMAIL_LIST_LABELS")).toBeVisible();
  expect(screen.getByText("me", { exact: true })).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
