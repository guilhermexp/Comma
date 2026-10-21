import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@comma/test-utils/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localIsoString } from "../agendaDates";
import {
  gridPoint,
  hourHeight,
  agendaHarness,
  stubGridGeometry,
} from "./agendaScreenHarness";
import { testCalendar, testEntry, testEvent, testSource } from "./agendaTestSource";

const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();

const work = testCalendar("google", "acct", "Trabalho", {
  name: "Trabalho",
  primary: true,
  ownerEmail: "ana@gmail.com",
});
const holidays = testCalendar("google", "acct", "Feriados", {
  name: "Feriados no Brasil",
  writable: false,
  color: "#0b8043",
});

function googleWith(events = [] as ReturnType<typeof testEvent>[]) {
  const google = testSource([work, holidays], events);
  return {
    ...google,
    entry: testEntry("google:acct", "google", google.source, {
      accountId: "acct",
      email: "ana@gmail.com",
      label: "ana@gmail.com",
    }),
  };
}

const hourGrid = () => screen.getByTestId("agenda-hour-columns").parentElement!;
const dayOf = () =>
  screen
    .getAllByTestId("agenda-day-column")
    .findIndex((column) => within(column).queryByRole("button", { name: /^m,/ }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(2026, 9, 20, 14, 50) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agenda toolbar and grid", () => {
  it("opens on the current week and steps by week and back to Today", async () => {
    const { entry } = googleWith();
    renderAgenda([entry]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Semana19 – 25 out 2026"
    );
    const headers = screen.getAllByTestId("agenda-day-header");
    expect(headers).toHaveLength(7);
    expect(headers[0]).toHaveTextContent("seg19 out");
    expect(headers[6]).toHaveTextContent("dom25 out");

    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    expect(screen.getByTestId("agenda-range")).toHaveTextContent("2 – 8 nov 2026");
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(screen.getByTestId("agenda-range")).toHaveTextContent("19 – 25 out 2026");
  });

  it("shows today and the next two days in 3 days, stepping by three", () => {
    const { entry } = googleWith();
    const { navigations } = renderAgenda([entry]);
    fireEvent.click(screen.getByRole("button", { name: "3 dias" }));
    expect(
      screen.getAllByTestId("agenda-day-header").map((h) => h.textContent)
    ).toEqual([
      expect.stringContaining("20 out"),
      expect.stringContaining("21 out"),
      expect.stringContaining("22 out"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    expect(navigations.at(-1)).toEqual({ view: "3days", date: "2026-10-23" });
  });

  it("zooms the hour height from 100% in steps and stops at 200%", () => {
    const { entry } = googleWith();
    renderAgenda([entry]);
    expect(hourGrid()).toHaveStyle({ height: `${24 * hourHeight}px` });
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(
      screen.getByRole("button", { name: "Voltar o zoom para 100%" })
    ).toHaveTextContent("150%");
    expect(hourGrid()).toHaveStyle({ height: `${24 * hourHeight * 1.5}px` });
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }));
    expect(screen.getByRole("button", { name: "Aumentar zoom" })).toBeDisabled();
  });

  it("draws the now line at 14:50 on today's column", () => {
    const { entry } = googleWith();
    renderAgenda([entry]);
    const line = screen.getByTestId("agenda-now-line");
    expect(line).toHaveAttribute("data-now", "14:50");
    expect(line).toHaveStyle({ top: `${(14 + 50 / 60) * hourHeight}px` });
    expect(line.lastElementChild).toHaveStyle({ left: `${(1 / 7) * 100}%` });
  });

  it("opens the hour grid scrolled near the current time", () => {
    const { entry } = googleWith();
    renderAgenda([entry]);
    const viewport = screen
      .getByTestId("agenda-hour-columns")
      .closest("[data-agenda-hour-viewport]")!;
    expect(viewport.scrollTop).toBeCloseTo((14 + 50 / 60 - 1.5) * hourHeight, 0);
  });

  it("puts a short event's title and start on one line", async () => {
    const { entry } = googleWith([
      testEvent(work, "Short", at("2026-10-22", "10:00"), at("2026-10-22", "10:30")),
      testEvent(work, "Long", at("2026-10-22", "12:00"), at("2026-10-22", "13:00")),
    ]);
    renderAgenda([entry]);
    const short = await screen.findByRole("button", { name: /^Short,/ });
    expect(short.children).toHaveLength(2);
    expect(short.firstElementChild).toHaveTextContent("Short 10:00");
    const long = screen.getByRole("button", { name: /^Long,/ });
    expect(long.firstElementChild).toHaveTextContent("Long");
    expect(long.children[1]).toHaveTextContent("12:00–13:00 · Trabalho");
  });

  it("totals each day's busy time and lays out its events", async () => {
    const { entry } = googleWith([
      testEvent(work, "a", at("2026-10-21", "10:15"), at("2026-10-21", "10:45")),
      testEvent(work, "b", at("2026-10-21", "10:45"), at("2026-10-21", "12:00")),
      testEvent(work, "c", at("2026-10-21", "12:00"), at("2026-10-21", "13:00")),
      testEvent(work, "trip", "2026-10-22", "2026-10-25"),
    ]);
    renderAgenda([entry]);
    await waitFor(() => expect(screen.getAllByTestId("agenda-event")).toHaveLength(3));
    const busy = screen
      .getAllByTestId("agenda-day-busy")
      .map((cell) => cell.textContent);
    expect(busy[2]).toBe("2 h 45 min");
    expect(busy[0]).toBe("—");
    const trip = screen.getByTestId("agenda-all-day-event");
    expect(trip.style.width).toMatch(/^calc\(42\.857\d*% - 8px\)$/);
  });
});

describe("Agenda calendar panel", () => {
  it("hides a calendar's events and remembers it", async () => {
    const { entry } = googleWith([
      testEvent(holidays, "h", "2026-10-21", "2026-10-22"),
    ]);
    const view = renderAgenda([entry]);
    await waitFor(() =>
      expect(screen.getByTestId("agenda-all-day-event")).toBeVisible()
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Feriados no Brasil" }));
    expect(screen.queryByTestId("agenda-all-day-event")).toBeNull();
    view.unmount();
    renderAgenda([entry]);
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Feriados no Brasil" })
      ).not.toBeChecked()
    );
  });

  it("offers to connect Google Calendar when no account is connected", () => {
    const { onConnect } = renderAgenda([]);
    fireEvent.click(screen.getByRole("button", { name: "Conectar Google Calendar" }));
    expect(onConnect).toHaveBeenCalled();
    expect(screen.queryByText("Calendário do Mac")).toBeNull();
  });

  it("groups the Mac calendar by account with subscriptions last, the Google one hidden", async () => {
    const { entry } = googleWith();
    const mac = testSource(
      [
        testCalendar("mac", null, "sub", { name: "Feriados", ownerEmail: null }),
        testCalendar("mac", null, "home", { name: "Casa", ownerEmail: "iCloud" }),
        testCalendar("mac", null, "dup", { name: "Ana", ownerEmail: "ana@gmail.com" }),
      ],
      []
    );
    renderAgenda([entry, testEntry("mac", "mac", mac.source)]);
    const group = await screen.findByRole("region", { name: "Calendário do Mac" });
    await waitFor(() =>
      expect(
        within(group)
          .getAllByRole("heading", { level: 4 })
          .map((h) => h.textContent)
      ).toEqual(["ana@gmail.com", "iCloud", "Calendários assinados"])
    );
    expect(within(group).getByRole("checkbox", { name: "Ana" })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "Casa" })).toBeChecked();
  });

  it("marks a failing source with Try again and still shows the others", async () => {
    const { entry, source } = googleWith();
    source.calendars.mockRejectedValue(new Error("provider_unavailable"));
    const home = testCalendar("mac", null, "home", { name: "Casa" });
    const mac = testSource(
      [home],
      [testEvent(home, "dentist", at("2026-10-21", "09:00"), at("2026-10-21", "10:00"))]
    );
    renderAgenda([entry, testEntry("mac", "mac", mac.source)]);
    await waitFor(() => expect(screen.getAllByTestId("agenda-event")).toHaveLength(1));
    const google = screen.getByRole("region", { name: "ana@gmail.com" });
    expect(within(google).getByRole("alert")).toHaveTextContent("Tentar de novo");
  });
});

describe("Agenda month", () => {
  it("shows three events and +4 on a full day, and lists the whole day", async () => {
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (
      this: Element
    ) {
      return (this as HTMLElement).dataset?.["agendaDay"] ? 86 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset["testid"] === "agenda-month-event" ? 20 : 0;
    });
    const { entry } = googleWith(
      Array.from({ length: 7 }, (_, index) =>
        testEvent(
          work,
          `e${index}`,
          at("2026-10-21", `${String(9 + index).padStart(2, "0")}:00`),
          at("2026-10-21", `${String(9 + index).padStart(2, "0")}:30`)
        )
      )
    );
    renderAgenda([entry], { search: { view: "month", date: "2026-10-20" } });
    const day = screen
      .getAllByTestId("agenda-month-day")
      .find((cell) => cell.querySelector("[data-agenda-day='2026-10-21']"))!;
    await waitFor(() =>
      expect(within(day).getByRole("button", { name: "+4" })).toBeVisible()
    );
    expect(within(day).getAllByTestId("agenda-month-event")).toHaveLength(3);
    fireEvent.click(within(day).getByRole("button", { name: "+4" }));
    const list = await screen.findByTestId("agenda-day-list");
    expect(within(list).getAllByRole("button")).toHaveLength(7);
  });
});

describe("Agenda dragging", () => {
  it("moves a Wednesday 10:00 event to Friday 14:00 in its source", async () => {
    stubGridGeometry();
    const meeting = testEvent(
      work,
      "m",
      at("2026-10-21", "10:00"),
      at("2026-10-21", "11:00")
    );
    const { entry, source } = googleWith([meeting]);
    renderAgenda([entry]);
    const chip = await screen.findByRole("button", { name: /^m,/ });
    const columns = screen.getByTestId("agenda-hour-columns");
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, ...gridPoint(2, 10, 5) });
    fireEvent.pointerMove(columns, { pointerId: 1, ...gridPoint(4, 14, 5) });
    expect(screen.getByTestId("agenda-drag-preview")).toHaveTextContent("14:00–15:00");
    fireEvent.pointerUp(columns, { pointerId: 1, ...gridPoint(4, 14, 5) });
    await waitFor(() => expect(source.update).toHaveBeenCalled());
    expect(source.update.mock.calls[0]?.slice(0, 3)).toEqual([
      meeting,
      "instance",
      expect.objectContaining({
        start: localIsoString(new Date(2026, 9, 23, 14, 0)),
        end: localIsoString(new Date(2026, 9, 23, 15, 0)),
      }),
    ]);
  });

  it("resizes an event's end to 13:45", async () => {
    stubGridGeometry();
    const lunch = testEvent(
      work,
      "l",
      at("2026-10-21", "12:00"),
      at("2026-10-21", "13:00")
    );
    const { entry, source } = googleWith([lunch]);
    renderAgenda([entry]);
    const chip = await screen.findByRole("button", { name: /^l,/ });
    const handle = chip.querySelector("[data-agenda-resize]")!;
    const columns = screen.getByTestId("agenda-hour-columns");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, ...gridPoint(2, 12, 58) });
    fireEvent.pointerMove(columns, { pointerId: 1, ...gridPoint(2, 13, 44) });
    fireEvent.pointerUp(columns, { pointerId: 1, ...gridPoint(2, 13, 44) });
    await waitFor(() => expect(source.update).toHaveBeenCalled());
    expect(source.update.mock.calls[0]?.[2]).toMatchObject({
      end: localIsoString(new Date(2026, 9, 21, 13, 45)),
    });
  });

  it("puts a refused move back and offers to reconnect", async () => {
    stubGridGeometry();
    const meeting = testEvent(
      work,
      "m",
      at("2026-10-21", "10:00"),
      at("2026-10-21", "11:00")
    );
    const { entry, source } = googleWith([meeting]);
    let refuse!: (error: unknown) => void;
    source.update.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject))
    );
    const { onConnect } = renderAgenda([entry]);
    const chip = await screen.findByRole("button", { name: /^m,/ });
    const columns = screen.getByTestId("agenda-hour-columns");
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, ...gridPoint(2, 10, 5) });
    fireEvent.pointerMove(columns, { pointerId: 1, ...gridPoint(4, 14, 5) });
    fireEvent.pointerUp(columns, { pointerId: 1, ...gridPoint(4, 14, 5) });
    await waitFor(() => expect(dayOf()).toBe(4));
    await act(async () =>
      refuse(
        Object.assign(new Error("no"), { code: "calendar_write_permission_required" })
      )
    );
    await waitFor(() => expect(dayOf()).toBe(2));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reconecte a conta Google com permissão para editar a agenda"
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    expect(onConnect).toHaveBeenCalled();
  });

  it("creates an event over a dragged Thursday 15:00–16:30 range", async () => {
    stubGridGeometry();
    const { entry, source } = googleWith();
    renderAgenda([entry]);
    await waitFor(() => expect(source.events).toHaveBeenCalled());
    const columns = screen.getByTestId("agenda-hour-columns");
    fireEvent.pointerDown(columns.children[3]!, {
      button: 0,
      pointerId: 1,
      ...gridPoint(3, 15, 1),
    });
    fireEvent.pointerMove(columns, { pointerId: 1, ...gridPoint(3, 16, 30) });
    expect(screen.getByTestId("agenda-create-preview")).toHaveTextContent(
      "15:00–16:30"
    );
    fireEvent.pointerUp(columns, { pointerId: 1, ...gridPoint(3, 16, 30) });
    const details = await screen.findByRole("complementary", { name: "Novo evento" });
    fireEvent.change(within(details).getByRole("textbox", { name: "Título" }), {
      target: { value: "Revisão" },
    });
    fireEvent.click(within(details).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(source.create).toHaveBeenCalled());
    expect(source.create.mock.calls[0]).toEqual([
      "Trabalho",
      expect.objectContaining({
        title: "Revisão",
        start: localIsoString(new Date(2026, 9, 22, 15, 0)),
        end: localIsoString(new Date(2026, 9, 22, 16, 30)),
        allDay: false,
        recurrence: "none",
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Revisão,/ })).toBeVisible()
    );
  });

  it("creates an all-day event from the all-day row", async () => {
    const { entry } = googleWith();
    renderAgenda([entry]);
    fireEvent.click(
      screen.getByRole("button", { name: "Novo evento · Dia inteiro · 24 out" })
    );
    const details = await screen.findByRole("complementary", { name: "Novo evento" });
    expect(
      within(details).getByRole("checkbox", { name: "Dia inteiro" })
    ).toBeChecked();
    expect(within(details).getByRole("group", { name: "Data" })).toHaveTextContent(
      "24/10/2026"
    );
  });
});

function renderAgenda(...args: Parameters<typeof agendaHarness>) {
  const { element, ...rest } = agendaHarness(...args);
  return { ...render(element), ...rest };
}
