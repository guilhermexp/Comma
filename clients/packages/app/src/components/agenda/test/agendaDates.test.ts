import { describe, expect, it } from "vitest";
import {
  agendaPeriod,
  agendaRangeLabel,
  busyMinutes,
  dateKey,
  eventsOnDay,
  parseDateKey,
  shiftAnchor,
} from "../agendaDates";
import type { AgendaEvent } from "../agendaSource";

function event(id: string, start: string, end: string, allDay = false): AgendaEvent {
  return {
    key: `google:a:cal:${id}`,
    source: "google",
    accountId: "a",
    calendarId: "cal",
    id,
    seriesId: null,
    occurrenceDate: null,
    title: id,
    start,
    end,
    allDay,
    location: null,
    description: null,
    url: null,
    color: null,
    editable: true,
    etag: null,
  };
}

const local = (day: string, time: string) =>
  new Date(`${day}T${time}:00`).toISOString();

describe("agendaPeriod", () => {
  it("runs a week from Monday to Sunday", () => {
    const period = agendaPeriod("week", "2026-10-20");
    expect(period.days.map(dateKey)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(dateKey(period.end)).toBe("2026-10-26");
  });

  it("shows three days from the anchor", () => {
    expect(agendaPeriod("3days", "2026-10-20").days.map(dateKey)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
  });

  it("covers a month in whole Monday weeks, at most six", () => {
    const period = agendaPeriod("month", "2026-12-15");
    expect(dateKey(period.start)).toBe("2026-11-30");
    expect(dateKey(period.end)).toBe("2027-01-04");
    expect(period.days).toHaveLength(35);
    expect(dateKey(period.focus)).toBe("2026-12-01");
  });
});

describe("shiftAnchor", () => {
  it("steps by the view's span", () => {
    expect(shiftAnchor("week", "2026-10-20", 1)).toBe("2026-10-27");
    expect(shiftAnchor("3days", "2026-10-20", -1)).toBe("2026-10-17");
    expect(shiftAnchor("month", "2026-10-31", 1)).toBe("2026-11-01");
  });

  it("returns to the current week after two steps forward and Today", () => {
    const later = shiftAnchor("week", shiftAnchor("week", "2026-10-20", 1), 1);
    expect(dateKey(agendaPeriod("week", later).start)).toBe("2026-11-02");
    expect(dateKey(agendaPeriod("week", "2026-10-20").start)).toBe("2026-10-19");
  });
});

describe("agendaRangeLabel", () => {
  it("names a week inside one month", () => {
    expect(agendaRangeLabel(agendaPeriod("week", "2026-10-20"), "week", "pt-BR")).toBe(
      "19 – 25 out 2026"
    );
  });

  it("names a week across months and a month", () => {
    expect(agendaRangeLabel(agendaPeriod("week", "2026-10-01"), "week", "pt-BR")).toBe(
      "28 set – 4 out 2026"
    );
    expect(
      agendaRangeLabel(agendaPeriod("month", "2026-12-01"), "month", "pt-BR")
    ).toBe("dezembro de 2026");
  });
});

describe("busyMinutes", () => {
  it("adds the timed events of the day", () => {
    const day = parseDateKey("2026-10-21");
    const events = [
      event("a", local("2026-10-21", "10:15"), local("2026-10-21", "10:45")),
      event("b", local("2026-10-21", "10:45"), local("2026-10-21", "12:00")),
      event("c", local("2026-10-21", "12:00"), local("2026-10-21", "13:00")),
      event("all", "2026-10-21", "2026-10-22", true),
    ];
    expect(busyMinutes(events, day)).toBe(165);
  });

  it("counts overlapping time once and clips at midnight", () => {
    const day = parseDateKey("2026-10-21");
    const events = [
      event("a", local("2026-10-21", "09:00"), local("2026-10-21", "11:00")),
      event("b", local("2026-10-21", "10:00"), local("2026-10-21", "11:30")),
      event("late", local("2026-10-21", "23:30"), local("2026-10-22", "01:00")),
    ];
    expect(busyMinutes(events, day)).toBe(180);
  });
});

describe("eventsOnDay", () => {
  it("keeps an all-day date in the system time zone", () => {
    const allDay = event("holiday", "2026-10-25", "2026-10-26", true);
    expect(eventsOnDay([allDay], parseDateKey("2026-10-24"))).toEqual([]);
    expect(eventsOnDay([allDay], parseDateKey("2026-10-25"))).toEqual([allDay]);
    expect(eventsOnDay([allDay], parseDateKey("2026-10-26"))).toEqual([]);
  });

  it("orders a day's events by start", () => {
    const late = event(
      "late",
      local("2026-10-21", "15:00"),
      local("2026-10-21", "16:00")
    );
    const early = event(
      "early",
      local("2026-10-21", "08:00"),
      local("2026-10-21", "09:00")
    );
    const allDay = event("all", "2026-10-21", "2026-10-22", true);
    expect(eventsOnDay([late, early, allDay], parseDateKey("2026-10-21"))).toEqual([
      allDay,
      early,
      late,
    ]);
  });
});
