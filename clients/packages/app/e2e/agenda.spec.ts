import { expect, test, type Page } from "@playwright/test";
import { installBrowserTestSession } from "../../../e2e/helpers/browser-auth";
import { chatSmokeWorkspace, startChatSmokeStub } from "../../../e2e/p0/chat-stub";

// The Agenda against a simulated `google_calendar` action (contract C1): open
// it from the sidebar, move between weeks, create by dragging, move an event
// to another day, and delete with the Delete key.

test.use({ timezoneId: "America/Sao_Paulo", viewport: { width: 1440, height: 1000 } });

const hourHeight = 62;

type C1Event = {
  id: string;
  calendar_id: string;
  series_id: string | null;
  title: string;
  start: { date_time: string; time_zone: string } | { date: string };
  end: { date_time: string; time_zone: string } | { date: string };
  all_day: boolean;
  location: string | null;
  description: string | null;
  url: string | null;
  color: string | null;
  editable: boolean;
  etag: string | null;
};

const timed = (id: string, title: string, start: string, end: string): C1Event => ({
  id,
  calendar_id: "ana@example.com",
  series_id: null,
  title,
  start: { date_time: start, time_zone: "America/Sao_Paulo" },
  end: { date_time: end, time_zone: "America/Sao_Paulo" },
  all_day: false,
  location: null,
  description: null,
  url: null,
  color: null,
  editable: true,
  etag: `"${id}"`,
});

async function installGoogleCalendar(page: Page) {
  const events = new Map<string, C1Event>([
    [
      "planning",
      timed(
        "planning",
        "Planning",
        "2026-10-21T10:00:00-03:00",
        "2026-10-21T11:00:00-03:00"
      ),
    ],
  ]);
  const writes: Array<Record<string, unknown>> = [];
  await page.route(
    `**/v1/comma/workspaces/${chatSmokeWorkspace.id}/composio`,
    (route) =>
      route.fulfill({
        json: {
          mode: "connect",
          status: "connected",
          user_id: "user-agenda",
          accounts: [
            {
              id: "ca_calendar",
              toolkit: "googlecalendar",
              name: "Ana",
              email: "ana@example.com",
              status: "ACTIVE",
              enabled: true,
              mode: "connect",
            },
          ],
          next_cursor: null,
          capabilities: { catalog: true, search: true, account_management: true },
          expires_at: null,
        },
      })
  );
  await page.route("**/composio/google_calendar", async (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    if (body["account_id"] !== "ca_calendar")
      return route.fulfill({ status: 403, json: { error: "composio_access_denied" } });
    switch (body["operation"]) {
      case "calendars":
        return route.fulfill({
          json: {
            account_email: "ana@example.com",
            calendars: [
              {
                id: "ana@example.com",
                name: "Ana",
                color: "#3b82f6",
                primary: true,
                selected: true,
                access_role: "owner",
                writable: true,
              },
            ],
          },
        });
      case "events": {
        const min = Date.parse(body["time_min"]);
        const max = Date.parse(body["time_max"]);
        return route.fulfill({
          json: {
            events: [...events.values()].filter((event) => {
              const start = Date.parse(
                "date_time" in event.start ? event.start.date_time : event.start.date
              );
              return start >= min && start < max;
            }),
            truncated: false,
            failed_calendar_ids: [],
          },
        });
      }
      case "create": {
        writes.push(body);
        const input = body["event"];
        const created = timed(
          `created-${writes.length}`,
          input.title,
          input.start,
          input.end
        );
        events.set(created.id, created);
        return route.fulfill({ json: { event: created } });
      }
      case "update": {
        writes.push(body);
        const event = events.get(body["event_id"])!;
        const patch = body["patch"];
        const updated = {
          ...event,
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.start
            ? {
                start: { date_time: patch.start, time_zone: "America/Sao_Paulo" },
                end: { date_time: patch.end, time_zone: "America/Sao_Paulo" },
              }
            : {}),
        };
        events.set(updated.id, updated);
        return route.fulfill({ json: { event: updated } });
      }
      case "delete":
        writes.push(body);
        events.delete(body["event_id"]);
        return route.fulfill({ json: { deleted: true } });
      default:
        return route.fulfill({
          status: 422,
          json: { error: "invalid_composio_request" },
        });
    }
  });
  return { writes };
}

async function dayColumn(page: Page, index: number) {
  const box = await page.getByTestId("agenda-day-column").nth(index).boundingBox();
  if (!box) throw new Error("the hour grid is not laid out");
  return box;
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8
    );
  }
  await page.mouse.up();
}

test("the Agenda opens from the sidebar and creates, moves and deletes Google events", async ({
  page,
}) => {
  const stub = await startChatSmokeStub();
  try {
    await installBrowserTestSession(page, {
      apiBaseUrl: stub.baseUrl,
      email: "agenda@comma.local",
      token: "comma_sess_agenda",
    });
    const backend = await installGoogleCalendar(page);
    await page.clock.install({ time: new Date("2026-10-20T14:50:00-03:00") });
    await page.goto("/");

    await page.getByRole("link", { name: "Agenda" }).click();
    await expect(page).toHaveURL(/#\/agenda$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Week");
    await expect(page.getByTestId("agenda-range")).toHaveText("19 – 25 Oct 2026");
    const planning = page.getByRole("button", { name: /^Planning,/ });
    await expect(planning).toBeVisible();

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByTestId("agenda-range")).toHaveText("26 Oct – 1 Nov 2026");
    await expect(page).toHaveURL(/view=week/);
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.getByTestId("agenda-range")).toHaveText("19 – 25 Oct 2026");

    // Create: drag Thursday from 15:00 to 16:30.
    const thursday = await dayColumn(page, 3);
    await drag(
      page,
      { x: thursday.x + thursday.width / 2, y: thursday.y + 15 * hourHeight + 2 },
      { x: thursday.x + thursday.width / 2, y: thursday.y + 16.5 * hourHeight }
    );
    const details = page.getByRole("complementary", { name: "New event" });
    await details.getByRole("textbox", { name: "Title" }).fill("Review");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("button", { name: /^Review, 3:00\sPM–4:30\sPM/ })
    ).toBeVisible();
    expect(backend.writes[0]).toMatchObject({
      operation: "create",
      calendar_id: "ana@example.com",
      event: {
        title: "Review",
        start: "2026-10-22T15:00:00-03:00",
        end: "2026-10-22T16:30:00-03:00",
        all_day: false,
      },
    });

    // Move: Wednesday 10:00 to Friday 14:00.
    await planning.scrollIntoViewIfNeeded();
    const from = await planning.boundingBox();
    const friday = await dayColumn(page, 4);
    if (!from) throw new Error("Planning is not laid out");
    await drag(
      page,
      { x: from.x + from.width / 2, y: from.y + 10 },
      { x: friday.x + friday.width / 2, y: friday.y + 14 * hourHeight + 10 }
    );
    await expect(
      page.getByRole("button", { name: /^Planning, 2:00\sPM–3:00\sPM/ })
    ).toBeVisible();
    await expect
      .poll(() => backend.writes.find((write) => write["operation"] === "update"))
      .toMatchObject({
        event_id: "planning",
        scope: "instance",
        patch: { start: "2026-10-23T14:00:00-03:00", end: "2026-10-23T15:00:00-03:00" },
      });
    await expect(
      page
        .getByTestId("agenda-day-column")
        .nth(4)
        .getByRole("button", { name: /^Planning/ })
    ).toBeVisible();

    // Delete: select Review, press Delete and confirm.
    await page.getByRole("button", { name: /^Review,/ }).click();
    await expect(page.getByTestId("agenda-event-details")).toBeVisible();
    await page.getByTestId("agenda-event-details").getByRole("heading").click();
    await page.keyboard.press("Delete");
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("Delete this event?");
    await confirm.getByRole("button", { name: /^Delete/ }).click();
    await expect(page.getByRole("button", { name: /^Review,/ })).toHaveCount(0);
    expect(backend.writes.at(-1)).toMatchObject({
      operation: "delete",
      scope: "instance",
    });

    // The view and date stay in the URL across a reload.
    await page.getByRole("button", { name: "Month" }).click();
    await expect(page).toHaveURL(/view=month/);
    await page.reload();
    await expect(page.getByTestId("agenda-month-grid")).toBeVisible();
    await expect(page.getByTestId("agenda-range")).toHaveText("October 2026");
  } finally {
    await stub.close();
  }
});
