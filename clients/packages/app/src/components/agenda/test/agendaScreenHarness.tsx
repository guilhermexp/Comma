import { CommaI18nProvider } from "@comma/i18n/react";
import { useState } from "react";
import { vi } from "vitest";
import type { GoogleAccountsState } from "../AgendaCalendarPanel";
import { AgendaScreen, type AgendaSearch } from "../AgendaRoute";
import type { AgendaSourceEntry } from "../agendaSource";

export const hourHeight = 62;
const columnWidth = 100;

/** jsdom has no layout: give the hour grid a 7 × 100 px by 24 h geometry. */
export function stubGridGeometry(days = 7) {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    if ((this as HTMLElement).dataset?.["testid"] === "agenda-hour-columns") {
      return DOMRect.fromRect({
        x: 0,
        y: 0,
        width: days * columnWidth,
        height: 24 * hourHeight,
      });
    }
    return original.call(this);
  });
}

export function gridPoint(day: number, hour: number, minute = 0) {
  return {
    clientX: day * columnWidth + 50,
    clientY: (hour + minute / 60) * hourHeight,
  };
}

/** The Agenda screen with its URL search held in state, as the route does. */
export function agendaHarness(
  entries: AgendaSourceEntry[],
  {
    search = {},
    google = { status: "ready", candidates: [] },
  }: { search?: AgendaSearch; google?: GoogleAccountsState } = {}
) {
  const onConnect = vi.fn();
  const navigations: AgendaSearch[] = [];
  function Harness() {
    const [current, setCurrent] = useState(search);
    return (
      <CommaI18nProvider locale="pt-BR">
        <AgendaScreen
          entries={entries}
          google={google}
          onConnect={onConnect}
          onNavigate={(next) => {
            navigations.push(next);
            setCurrent(next);
          }}
          onRetryAccounts={vi.fn()}
          onUseAccount={vi.fn()}
          search={current}
          workspaceId="ws"
        />
      </CommaI18nProvider>
    );
  }
  return { element: <Harness />, onConnect, navigations };
}
