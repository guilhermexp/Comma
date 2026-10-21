import { describe, expect, it } from "vitest";
import { parseDateKey } from "../agendaDates";
import {
  agendaHourHeight,
  layoutAllDayEvents,
  layoutTimedEvents,
  snapMinutes,
  visibleItemCount,
} from "../agendaLayout";
import type { AgendaEvent } from "../agendaSource";

function event(id: string, start: string, end: string, allDay = false): AgendaEvent {
  return {
    key: id,
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

const at = (time: string, day = "2026-10-21") =>
  new Date(`${day}T${time}:00`).toISOString();

describe("layoutTimedEvents", () => {
  it("places overlapping events side by side", () => {
    const placed = layoutTimedEvents(
      [
        event("a", at("10:00"), at("11:00")),
        event("b", at("10:30"), at("11:30")),
        event("c", at("12:00"), at("13:00")),
      ],
      parseDateKey("2026-10-21")
    );
    const byId = Object.fromEntries(placed.map((item) => [item.event.id, item]));
    expect(byId["a"]).toMatchObject({
      startMinute: 600,
      endMinute: 660,
      column: 0,
      columns: 2,
    });
    expect(byId["b"]).toMatchObject({
      startMinute: 630,
      endMinute: 690,
      column: 1,
      columns: 2,
    });
    expect(byId["c"]).toMatchObject({ column: 0, columns: 1 });
  });

  it("reuses a freed column inside one collision group", () => {
    const placed = layoutTimedEvents(
      [
        event("long", at("09:00"), at("12:00")),
        event("first", at("09:00"), at("10:00")),
        event("second", at("10:00"), at("11:00")),
      ],
      parseDateKey("2026-10-21")
    );
    const byId = Object.fromEntries(placed.map((item) => [item.event.id, item]));
    expect(byId["first"]?.column).toBe(byId["second"]?.column);
    expect(byId["long"]?.columns).toBe(2);
  });

  it("clips an event that crosses midnight to the day", () => {
    const [placed] = layoutTimedEvents(
      [event("late", at("23:00"), at("01:00", "2026-10-22"))],
      parseDateKey("2026-10-21")
    );
    expect(placed).toMatchObject({ startMinute: 1380, endMinute: 1440 });
  });
});

describe("layoutAllDayEvents", () => {
  it("draws a Thursday-to-Saturday event once across three columns", () => {
    const days = ["19", "20", "21", "22", "23", "24", "25"].map((day) =>
      parseDateKey(`2026-10-${day}`)
    );
    const placed = layoutAllDayEvents(
      [
        event("trip", "2026-10-22", "2026-10-25", true),
        event("thu", "2026-10-22", "2026-10-23", true),
      ],
      days
    );
    expect(placed).toEqual([
      expect.objectContaining({ startColumn: 3, span: 3, row: 0 }),
      expect.objectContaining({ startColumn: 3, span: 1, row: 1 }),
    ]);
    expect(placed[0]?.event.id).toBe("trip");
  });

  it("keeps a multi-day timed event in the all-day row", () => {
    const days = [parseDateKey("2026-10-21"), parseDateKey("2026-10-22")];
    const placed = layoutAllDayEvents(
      [event("conf", at("09:00"), at("18:00", "2026-10-22"))],
      days
    );
    expect(placed).toEqual([expect.objectContaining({ startColumn: 0, span: 2 })]);
  });
});

describe("snapMinutes and zoom", () => {
  it("snaps to 15 minutes", () => {
    expect(snapMinutes(127)).toBe(120);
    expect(snapMinutes(128)).toBe(135);
    expect(snapMinutes(-20)).toBe(-15);
  });

  it("scales the hour with the zoom", () => {
    expect(agendaHourHeight(150)).toBe(agendaHourHeight(100) * 1.5);
  });
});

describe("visibleItemCount", () => {
  it("keeps room for the +N line when a day overflows", () => {
    // Three 20 px chips, 2 px gaps, and one more line for "+4".
    expect(visibleItemCount(86, 20, 2, 7)).toBe(3);
    expect(visibleItemCount(86, 20, 2, 4)).toBe(4);
  });
});
