import { fireEvent, render, screen, waitFor, within } from "@comma/test-utils/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agendaHarness, gridPoint, stubGridGeometry } from "./agendaScreenHarness";
import { testCalendar, testEntry, testEvent, testSource } from "./agendaTestSource";

const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();

const work = testCalendar("google", "acct", "Trabalho", {
  name: "Trabalho",
  primary: true,
});
const personal = testCalendar("google", "acct", "Pessoal", { name: "Pessoal" });
const holidays = testCalendar("google", "acct", "Feriados", {
  name: "Feriados no Brasil",
  writable: false,
});
const home = testCalendar("mac", null, "Casa", { name: "Casa", ownerEmail: "iCloud" });

function setup(
  events: ReturnType<typeof testEvent>[],
  { mac = [] as typeof events } = {}
) {
  const google = testSource([work, personal, holidays], events);
  const macSource = testSource([home], mac);
  const entries = [
    testEntry("google:acct", "google", google.source, {
      accountId: "acct",
      email: "ana@gmail.com",
      label: "ana@gmail.com",
    }),
    testEntry("mac", "mac", macSource.source),
  ];
  return { google, mac: macSource, ...renderAgenda(entries) };
}

/** A press that does not travel selects the event and opens its details. */
async function open(name: string) {
  const chip = await screen.findByRole("button", { name: new RegExp(`^${name}`) });
  const columns = screen.getByTestId("agenda-hour-columns");
  if (columns.contains(chip)) {
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 1, clientY: 1 });
    fireEvent.pointerUp(columns, { button: 0, pointerId: 1, clientX: 1, clientY: 1 });
  } else fireEvent.click(chip);
  return screen.findByTestId("agenda-event-details");
}

async function chooseCalendar(details: HTMLElement, name: string) {
  fireEvent.click(within(details).getByRole("button", { name: /Calendário/ }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(2026, 9, 20, 14, 50) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agenda event details", () => {
  it("shows a read-only calendar's event without editing", async () => {
    setup([testEvent(holidays, "Proclamação", "2026-10-21", "2026-10-22")]);
    const details = await open("Proclamação");
    expect(within(details).getByRole("note")).toHaveTextContent(
      "Este calendário não permite alterações."
    );
    expect(within(details).queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(within(details).queryByRole("textbox")).toBeNull();
  });

  it("saves a changed title to the event's source", async () => {
    const event = testEvent(
      work,
      "Daily",
      at("2026-10-21", "09:00"),
      at("2026-10-21", "09:30")
    );
    const { google } = setup([event]);
    const details = await open("Daily");
    fireEvent.change(within(details).getByRole("textbox", { name: "Título" }), {
      target: { value: "Daily sync" },
    });
    fireEvent.click(within(details).getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(google.source.update).toHaveBeenCalledWith(
        event,
        "instance",
        { title: "Daily sync" },
        undefined
      )
    );
  });

  it("shows and edits date and time in the app language", async () => {
    const event = testEvent(
      work,
      "Revisão",
      at("2026-10-21", "18:30"),
      at("2026-10-21", "20:00")
    );
    const { google } = setup([event]);
    const details = await open("Revisão");

    expect(within(details).getByRole("group", { name: "Início" })).toHaveTextContent(
      "21/10/2026"
    );
    const startTime = within(details).getByRole("group", { name: "Hora de início" });
    expect(startTime).toHaveTextContent("18:30");
    expect(startTime).not.toHaveTextContent(/PM/);

    const hour = within(startTime).getAllByRole("spinbutton")[0]!;
    fireEvent.focus(hour);
    fireEvent.keyDown(hour, { key: "ArrowUp" });
    fireEvent.click(within(details).getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(google.source.update).toHaveBeenCalledWith(
        event,
        "instance",
        expect.objectContaining({
          start: expect.stringMatching(/^2026-10-21T19:30:00/),
        }),
        undefined
      )
    );
  });

  it("moves an event to a calendar of the same account in place", async () => {
    const event = testEvent(
      personal,
      "Gym",
      at("2026-10-21", "07:00"),
      at("2026-10-21", "08:00")
    );
    const { google } = setup([event]);
    const details = await open("Gym");
    await chooseCalendar(details, "Trabalho");
    fireEvent.click(within(details).getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(google.source.update).toHaveBeenCalledWith(
        event,
        "instance",
        {},
        "Trabalho"
      )
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("warns, then creates in the other source before deleting the original", async () => {
    const dentist = testEvent(
      home,
      "Dentista",
      at("2026-10-21", "09:00"),
      at("2026-10-21", "10:00")
    );
    const { google, mac } = setup([], { mac: [dentist] });
    const details = await open("Dentista");
    await chooseCalendar(details, "Trabalho");
    fireEvent.click(within(details).getByRole("button", { name: "Salvar" }));
    const warning = await screen.findByRole("dialog");
    expect(warning).toHaveTextContent("Convidados e histórico não vão junto");
    expect(google.source.create).not.toHaveBeenCalled();
    fireEvent.click(within(warning).getByRole("button", { name: /Mover/ }));
    await waitFor(() =>
      expect(mac.source.remove).toHaveBeenCalledWith(dentist, "instance")
    );
    expect(google.source.create).toHaveBeenCalledWith(
      "Trabalho",
      expect.objectContaining({ title: "Dentista", start: expect.any(String) })
    );
    expect(google.source.create.mock.invocationCallOrder[0]!).toBeLessThan(
      mac.source.remove.mock.invocationCallOrder[0]!
    );
  });

  it("shows a custom repetition as Custom, without editing it", async () => {
    const event = testEvent(
      work,
      "Aula",
      at("2026-10-21", "18:00"),
      at("2026-10-21", "19:00"),
      {
        seriesId: "s1",
      }
    );
    const { google } = setup([event]);
    google.source.recurrence.mockResolvedValue("custom" as never);
    const details = await open("Aula");
    expect(await within(details).findByText("Personalizada")).toBeVisible();
    expect(within(details).queryByRole("button", { name: /Repetição/ })).toBeNull();
  });

  it("asks This event or All events when dragging an occurrence", async () => {
    stubGridGeometry();
    const event = testEvent(
      work,
      "Weekly",
      at("2026-10-21", "10:00"),
      at("2026-10-21", "11:00"),
      {
        seriesId: "s1",
      }
    );
    const { google } = setup([event]);
    const chip = await screen.findByRole("button", { name: /^Weekly/ });
    const columns = screen.getByTestId("agenda-hour-columns");
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, ...gridPoint(2, 10, 5) });
    fireEvent.pointerMove(columns, { pointerId: 1, ...gridPoint(2, 15, 5) });
    fireEvent.pointerUp(columns, { pointerId: 1, ...gridPoint(2, 15, 5) });
    const dialog = await screen.findByRole("dialog");
    expect(google.source.update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Só este evento/ }));
    await waitFor(() =>
      expect(google.source.update).toHaveBeenCalledWith(
        event,
        "instance",
        expect.objectContaining({ start: expect.any(String) }),
        undefined
      )
    );
  });

  it("deletes the selected event with the Delete key after confirming", async () => {
    const event = testEvent(
      work,
      "Café",
      at("2026-10-21", "16:00"),
      at("2026-10-21", "16:30")
    );
    const { google } = setup([event]);
    await open("Café");
    fireEvent.keyDown(document.body, { key: "Delete" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Apagar este evento?");
    fireEvent.click(within(dialog).getByRole("button", { name: /Apagar/ }));
    await waitFor(() =>
      expect(google.source.remove).toHaveBeenCalledWith(event, "instance")
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Café/ })).toBeNull()
    );
  });

  it("deletes the whole series when the reader chooses All events", async () => {
    const event = testEvent(
      work,
      "Standup",
      at("2026-10-21", "09:00"),
      at("2026-10-21", "09:15"),
      {
        seriesId: "s1",
      }
    );
    const { google } = setup([event]);
    const details = await open("Standup");
    fireEvent.click(within(details).getByRole("button", { name: "Apagar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Todos os eventos/ }));
    await waitFor(() =>
      expect(google.source.remove).toHaveBeenCalledWith(event, "series")
    );
  });
});

function renderAgenda(...args: Parameters<typeof agendaHarness>) {
  const { element, ...rest } = agendaHarness(...args);
  return { ...render(element), ...rest };
}
