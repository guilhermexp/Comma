import { act, renderHook, waitFor } from "@comma/test-utils/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateKey } from "../agendaDates";
import type { AgendaSourceEntry } from "../agendaSource";
import { useAgendaData } from "../useAgendaData";
import { testCalendar, testEntry, testEvent, testSource } from "./agendaTestSource";

const start = parseDateKey("2026-10-19");
const end = parseDateKey("2026-10-26");
const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();

function render(entries: AgendaSourceEntry[], range = { start, end }) {
  return renderHook(
    (props: { entries: AgendaSourceEntry[]; start: Date; end: Date }) =>
      useAgendaData({ workspaceId: "ws", ...props }),
    { initialProps: { entries, ...range } }
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("useAgendaData", () => {
  it("shows the other sources when one source fails", async () => {
    const google = testSource([], []);
    google.source.calendars.mockRejectedValue(
      Object.assign(new Error("down"), { code: "provider_unavailable" })
    );
    const home = testCalendar("mac", null, "Casa");
    const mac = testSource(
      [home],
      [testEvent(home, "dentist", at("2026-10-21", "09:00"), at("2026-10-21", "10:00"))]
    );
    const { result } = render([
      testEntry("acct", "google", google.source, { email: "ana@gmail.com" }),
      testEntry("mac", "mac", mac.source),
    ]);
    await waitFor(() =>
      expect(result.current.events.map((e) => e.id)).toEqual(["dentist"])
    );
    expect(result.current.groups.find((g) => g.entry.key === "acct")).toMatchObject({
      status: "error",
      error: "unavailable",
    });

    google.source.calendars.mockResolvedValue([testCalendar("google", "acct", "ana")]);
    act(() => result.current.retry("acct"));
    await waitFor(() =>
      expect(result.current.groups.find((g) => g.entry.key === "acct")?.status).toBe(
        "ready"
      )
    );
  });

  it("reads only the changed source again when it reports a change", async () => {
    const google = testSource([testCalendar("google", "acct", "ana")], []);
    const home = testCalendar("mac", null, "Casa");
    const mac = testSource([home], []);
    let notify!: () => void;
    const macSource = {
      ...mac.source,
      subscribe: (onChange: () => void) => {
        notify = onChange;
        return () => {};
      },
    };
    render([
      testEntry("acct", "google", google.source),
      testEntry("mac", "mac", macSource),
    ]);
    await waitFor(() => expect(mac.source.events).toHaveBeenCalled());
    const googleReads = google.source.calendars.mock.calls.length;
    const macReads = mac.source.calendars.mock.calls.length;
    mac.state.calendars = [home, testCalendar("mac", null, "Comma Teste")];

    act(() => notify());

    await waitFor(() =>
      expect(mac.source.events.mock.calls.at(-1)?.[0]).toEqual(["Casa", "Comma Teste"])
    );
    expect(mac.source.calendars.mock.calls.length).toBe(macReads + 1);
    expect(google.source.calendars.mock.calls.length).toBe(googleReads);
  });

  it("starts the Mac calendars of a connected Google account hidden", async () => {
    const google = testSource(
      [
        testCalendar("google", "acct", "ana@gmail.com", {
          ownerEmail: "ana@gmail.com",
        }),
      ],
      []
    );
    const fromGoogle = testCalendar("mac", null, "Trabalho", {
      ownerEmail: "Ana@gmail.com",
    });
    const icloud = testCalendar("mac", null, "Casa", { ownerEmail: "iCloud" });
    const mac = testSource([fromGoogle, icloud], []);
    const { result } = render([
      testEntry("acct", "google", google.source, { email: "ana@gmail.com" }),
      testEntry("mac", "mac", mac.source),
    ]);
    await waitFor(() => expect(mac.source.events).toHaveBeenCalled());
    expect(result.current.isVisible(fromGoogle)).toBe(false);
    expect(result.current.isVisible(icloud)).toBe(true);
    expect(mac.source.events.mock.calls.at(-1)?.[0]).toEqual(["Casa"]);

    act(() => result.current.setVisible(fromGoogle, true));
    await waitFor(() =>
      expect(mac.source.events.mock.calls.at(-1)?.[0]).toEqual(["Trabalho", "Casa"])
    );
  });

  it("remembers hidden calendars and zoom for the workspace", async () => {
    const holidays = testCalendar("google", "acct", "Feriados");
    const google = testSource(
      [holidays],
      [testEvent(holidays, "holiday", "2026-10-25", "2026-10-26")]
    );
    const entries = [testEntry("acct", "google", google.source)];
    const first = render(entries);
    await waitFor(() => expect(first.result.current.events).toHaveLength(1));
    act(() => {
      first.result.current.setVisible(holidays, false);
      first.result.current.setZoom(150);
    });
    expect(first.result.current.events).toEqual([]);
    first.unmount();

    const second = render(entries);
    expect(second.result.current.zoom).toBe(150);
    expect(second.result.current.isVisible(holidays)).toBe(false);
  });

  it("drops a calendar that a successful read no longer lists", async () => {
    const work = testCalendar("google", "acct", "Trabalho");
    const old = testCalendar("google", "acct", "Antigo");
    const google = testSource([work, old], []);
    const { result } = render([testEntry("acct", "google", google.source)]);
    await waitFor(() => expect(result.current.calendars).toHaveLength(2));

    google.source.calendars.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.retry("acct"));
    await waitFor(() => expect(result.current.groups[0]?.status).toBe("error"));
    expect(result.current.calendars).toHaveLength(2);

    google.state.calendars = [work];
    act(() => result.current.retry("acct"));
    await waitFor(() =>
      expect(result.current.calendars.map((c) => c.id)).toEqual(["Trabalho"])
    );
  });

  it("ignores an older period's events that arrive late", async () => {
    const work = testCalendar("google", "acct", "Trabalho");
    const google = testSource([work], []);
    let releaseOld!: () => void;
    google.source.events.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              events: [
                testEvent(
                  work,
                  "stale",
                  at("2026-10-20", "09:00"),
                  at("2026-10-20", "10:00")
                ),
              ],
              truncated: false,
              failedCalendarIds: [],
            });
        })
    );
    const view = render([testEntry("acct", "google", google.source)]);
    await waitFor(() => expect(google.source.events).toHaveBeenCalledTimes(1));
    view.rerender({
      entries: [testEntry("acct", "google", google.source)],
      start: parseDateKey("2026-10-26"),
      end: parseDateKey("2026-11-02"),
    });
    await waitFor(() => expect(google.source.events).toHaveBeenCalledTimes(2));
    await act(async () => releaseOld());
    expect(view.result.current.events).toEqual([]);
  });

  it("reverts a move the source refuses and names the reason", async () => {
    const work = testCalendar("google", "acct", "Trabalho");
    const meeting = testEvent(
      work,
      "m",
      at("2026-10-21", "10:00"),
      at("2026-10-21", "11:00")
    );
    const google = testSource([work], [meeting]);
    let refuse!: (error: unknown) => void;
    google.source.update.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject))
    );
    const { result } = render([testEntry("acct", "google", google.source)]);
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.update(meeting, "instance", {
        start: at("2026-10-23", "14:00"),
        end: at("2026-10-23", "15:00"),
      });
    });
    expect(result.current.events[0]?.start).toBe(at("2026-10-23", "14:00"));
    await act(async () => {
      refuse(
        Object.assign(new Error("no"), { code: "calendar_write_permission_required" })
      );
      await saved;
    });
    expect(result.current.events[0]?.start).toBe(at("2026-10-21", "10:00"));
    expect(result.current.writeError).toMatchObject({
      code: "write_permission",
      source: "google",
    });
  });

  it("moves to another source by creating first and deleting the original after", async () => {
    const home = testCalendar("mac", null, "Casa");
    const work = testCalendar("google", "acct", "Trabalho");
    const dentist = testEvent(
      home,
      "d",
      at("2026-10-21", "09:00"),
      at("2026-10-21", "10:00")
    );
    const mac = testSource([home], [dentist]);
    const google = testSource([work], []);
    const { result } = render([
      testEntry("acct", "google", google.source),
      testEntry("mac", "mac", mac.source),
    ]);
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    google.source.create.mockRejectedValueOnce(new Error("provider_timeout"));
    await act(async () => {
      await result.current.update(dentist, "instance", {}, work);
    });
    expect(mac.source.remove).not.toHaveBeenCalled();
    expect(result.current.events.map((event) => event.calendarId)).toEqual(["Casa"]);
    expect(result.current.writeError?.code).toBe("timeout");

    await act(async () => {
      await result.current.update(dentist, "instance", {}, work);
    });
    expect(google.source.create).toHaveBeenCalledTimes(2);
    expect(mac.source.remove).toHaveBeenCalledWith(dentist, "instance");
    await waitFor(() =>
      expect(result.current.events.map((event) => event.calendarId)).toEqual([
        "Trabalho",
      ])
    );
  });

  it("reads again on focus and every minute while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const work = testCalendar("google", "acct", "Trabalho");
    const google = testSource([work], []);
    render([testEntry("acct", "google", google.source)]);
    await waitFor(() => expect(google.source.events).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(google.source.events).toHaveBeenCalledTimes(2));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(google.source.events).toHaveBeenCalledTimes(3));
  });
});
