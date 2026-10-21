import { CommaI18nProvider } from "@comma/i18n/react";
import type { CalendarAccess, CalendarState } from "@comma/native-bridge";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaScreen } from "../AgendaRoute";
import { useMacCalendar } from "../macCalendarSource";

// The Mac group of the calendar panel over the `calendar.*` bridge mock:
// absent on the web, an explicit "Turn on" before any system prompt, and
// System Settings once access is denied.

function MacAgenda() {
  const mac = useMacCalendar("Calendário do Mac");
  return (
    <AgendaScreen
      entries={mac.entry ? [mac.entry] : []}
      google={{ status: "ready", candidates: [] }}
      mac={mac.prompt}
      onConnect={vi.fn()}
      onNavigate={vi.fn()}
      onRetryAccounts={vi.fn()}
      onUseAccount={vi.fn()}
      search={{}}
      workspaceId="ws"
    />
  );
}

function renderMac() {
  return render(
    <CommaI18nProvider locale="pt-BR">
      <MacAgenda />
    </CommaI18nProvider>
  );
}

const state = (access: CalendarAccess, revision = 1): CalendarState => ({
  access,
  available: access !== "unavailable",
  revision,
});

function installCalendar(initial: CalendarState, extra: Record<string, unknown> = {}) {
  let current = initial;
  let publish: ((next: CalendarState) => void) | undefined;
  const calendar = {
    state: {
      get: vi.fn(async () => current),
      subscribe: vi.fn((listener: (next: CalendarState) => void) => {
        publish = listener;
        void Promise.resolve().then(() => listener(current));
        return () => undefined;
      }),
    },
    requestAccess: vi.fn(async () => "fullAccess" as const),
    openPrivacySettings: vi.fn(async () => undefined),
    calendars: vi.fn(async () => ({
      calendars: [
        {
          color: "#1badf8",
          id: "home",
          isDefault: true,
          sourceTitle: "iCloud",
          sourceType: "calDAV",
          title: "Casa",
          writable: true,
        },
      ],
    })),
    events: vi.fn(async () => ({ events: [], truncated: false })),
    ...extra,
  };
  installNativeBridgeMock({ platform: "electron", os: "macos", calendar } as never);
  return {
    calendar,
    publish: (next: CalendarState) => {
      current = next;
      act(() => publish?.(next));
    },
  };
}

const macGroup = () => screen.getByRole("region", { name: "Calendário do Mac" });

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "commaNative");
  vi.restoreAllMocks();
});

describe("Mac Calendar in the Agenda", () => {
  it("has no Mac group on the web", async () => {
    installNativeBridgeMock({ platform: "web" });
    renderMac();
    await screen.findByRole("complementary", { name: "Calendários" });
    expect(screen.queryByText("Calendário do Mac")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Ativar Calendário do Mac" })
    ).toBeNull();
  });

  it("has no Mac group when the host has no Calendar capability", async () => {
    installCalendar(state("unavailable"));
    renderMac();
    await screen.findByRole("complementary", { name: "Calendários" });
    expect(screen.queryByText("Calendário do Mac")).not.toBeInTheDocument();
  });

  it("asks for access only when the reader turns the Mac Calendar on", async () => {
    const { calendar, publish } = installCalendar(state("notDetermined"));
    renderMac();

    const enable = await within(await waitFor(macGroup)).findByRole("button", {
      name: "Ativar Calendário do Mac",
    });
    expect(calendar.requestAccess).not.toHaveBeenCalled();
    expect(calendar.calendars).not.toHaveBeenCalled();

    fireEvent.click(enable);
    expect(calendar.requestAccess).toHaveBeenCalledOnce();
    publish(state("fullAccess", 2));

    expect(
      await within(macGroup()).findByRole("checkbox", { name: "Casa" })
    ).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Ativar Calendário do Mac" })
    ).not.toBeInTheDocument();
  });

  it.each([
    ["denied", "Acesso negado"],
    ["restricted", "Acesso restrito neste Mac"],
    ["writeOnly", "O Comma só pode adicionar eventos"],
  ] as const)("offers System Settings when access is %s", async (access, reason) => {
    const { calendar } = installCalendar(state(access));
    renderMac();

    const group = await waitFor(macGroup);
    expect(within(group).getByText(new RegExp(reason))).toBeInTheDocument();
    fireEvent.click(
      within(group).getByRole("button", { name: "Abrir Ajustes do Sistema" })
    );
    expect(calendar.openPrivacySettings).toHaveBeenCalledOnce();
    expect(calendar.requestAccess).not.toHaveBeenCalled();
    expect(calendar.calendars).not.toHaveBeenCalled();
  });

  it("reads the access again when the window regains focus", async () => {
    const { calendar } = installCalendar(state("denied"));
    renderMac();
    await waitFor(macGroup);

    calendar.state.get.mockResolvedValue(state("fullAccess"));
    act(() => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByRole("checkbox", { name: "Casa" })).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Abrir Ajustes do Sistema" })
    ).toBeNull();
  });

  it("reads the calendars and events again when the Mac Calendar changes", async () => {
    const { calendar, publish } = installCalendar(state("fullAccess", 5));
    renderMac();
    await within(await waitFor(macGroup)).findByRole("checkbox", { name: "Casa" });
    await waitFor(() => expect(calendar.events).toHaveBeenCalled());
    const reads = calendar.events.mock.calls.length;
    const calendarReads = calendar.calendars.mock.calls.length;

    publish(state("fullAccess", 6));

    await waitFor(() =>
      expect(calendar.events.mock.calls.length).toBeGreaterThan(reads)
    );
    expect(calendar.calendars.mock.calls.length).toBeGreaterThan(calendarReads);
  });
});
