import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import { Button, Dialog } from "@comma/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CommaApiClient, ComposioAccount } from "../../api";
import { readActiveWorkspaceId, subscribeActiveWorkspace } from "../activeWorkspace";
import { useCommaAuth } from "../auth-context";
import { composioAccountPresentation } from "../plugins/composioAccountPresentation";
import { AgendaCalendarPanel, type GoogleAccountsState } from "./AgendaCalendarPanel";
import {
  agendaPeriod,
  agendaRangeLabel,
  dateKey,
  isDateKey,
  localIsoString,
  shiftAnchor,
  systemTimeZone,
  type AgendaView,
} from "./agendaDates";
import { agendaErrorNeedsReconnect, type AgendaErrorCode } from "./agendaErrors";
import {
  AgendaEventDetails,
  type AgendaDetailsSave,
  type AgendaDetailsTarget,
} from "./AgendaEventDetails";
import { AgendaMonthGrid } from "./AgendaMonthGrid";
import type {
  AgendaCalendar,
  AgendaEvent,
  AgendaEventInput,
  AgendaScope,
  AgendaSourceEntry,
} from "./agendaSource";
import { AgendaTimeGrid } from "./AgendaTimeGrid";
import { AgendaToolbar } from "./AgendaToolbar";
import {
  googleCalendarSource,
  listGoogleCalendarAccounts,
} from "./googleCalendarSource";
import { eventCalendarKey, useAgendaData } from "./useAgendaData";
import { useAgendaNow } from "./useAgendaNow";

export type AgendaSearch = { view?: AgendaView; date?: string };

export function validateAgendaSearch(search: Record<string, unknown>): AgendaSearch {
  const view = search["view"];
  const date = search["date"];
  return {
    ...(view === "3days" || view === "week" || view === "month" ? { view } : {}),
    ...(typeof date === "string" && isDateKey(date) ? { date } : {}),
  };
}

/** `#/agenda`: the reader's workspace and Google accounts, then the screen. */
export function AgendaRoute() {
  const { api } = useCommaAuth();
  const m = useCommaMessages();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as AgendaSearch;
  const workspace = useAgendaWorkspace(api);
  const google = useGoogleCalendarEntries(api, workspace.id);

  if (workspace.status !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-main-panel-bg text-sm text-tertiary">
        {workspace.status === "loading" ? m.agenda_loading() : m.agenda_no_workspace()}
      </div>
    );
  }
  return (
    <AgendaScreen
      entries={google.entries}
      google={google.state}
      key={workspace.id}
      onConnect={() => void navigate({ to: "/plugins" })}
      onNavigate={(next) => void navigate({ to: "/agenda", search: next })}
      onRetryAccounts={google.retry}
      onUseAccount={google.useAccount}
      search={search}
      workspaceId={workspace.id}
    />
  );
}

function useAgendaWorkspace(api: CommaApiClient) {
  const preferred = useSyncExternalStore(
    subscribeActiveWorkspace,
    readActiveWorkspaceId
  );
  const [state, setState] = useState<{
    key: string;
    status: "loading" | "ready" | "none";
    id: string;
  }>({ key: "", status: "loading", id: "" });
  const key = `${preferred ?? ""}`;
  useEffect(() => {
    const controller = new AbortController();
    void api
      .listWorkspaces({ signal: controller.signal })
      .then((items) => {
        if (controller.signal.aborted) return;
        const ready = items.filter(
          (item) => item.status === undefined || item.status === "ready"
        );
        const id = (ready.find((item) => item.id === preferred) ?? ready[0])?.id;
        setState({ key, status: id ? "ready" : "none", id: id ?? "" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, status: "none", id: "" });
      });
    return () => controller.abort();
  }, [api, preferred, key]);
  return state.key === key ? state : { key, status: "loading" as const, id: "" };
}

function useGoogleCalendarEntries(api: CommaApiClient, workspaceId: string) {
  const [accounts, setAccounts] = useState<{
    workspaceId: string;
    state: GoogleAccountsState;
    items: ComposioAccount[];
  }>();
  const [reload, setReload] = useState<{ count: number; choice?: string }>({
    count: 0,
  });
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    listGoogleCalendarAccounts(api, workspaceId, controller.signal, reload.choice)
      .then((result) => {
        if (controller.signal.aborted) return;
        setAccounts({
          workspaceId,
          items: result.accounts,
          state: { status: "ready", candidates: result.candidates },
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAccounts({ workspaceId, items: [], state: { status: "error" } });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [api, workspaceId, reload]);
  const current = accounts?.workspaceId === workspaceId ? accounts : undefined;
  const entries = useMemo(
    () =>
      (current?.items ?? []).map((account): AgendaSourceEntry => {
        const identity = composioAccountPresentation(account, current?.items ?? []);
        return {
          key: `google:${account.id}`,
          kind: "google",
          accountId: account.id,
          label: identity.email ?? identity.name,
          email: identity.email,
          source: googleCalendarSource(api, workspaceId, account.id),
        };
      }),
    [api, workspaceId, current]
  );
  return {
    entries,
    state: current?.state ?? ({ status: "loading" } as const),
    retry: useCallback(() => setReload((value) => ({ count: value.count + 1 })), []),
    useAccount: useCallback(
      (choice: string) => setReload((value) => ({ count: value.count + 1, choice })),
      []
    ),
  };
}

type ScopeRequest = {
  kind: "update" | "delete";
  run: (scope: AgendaScope) => void;
};

/**
 * The Agenda screen over any list of sources. Production passes the Google
 * accounts (and, on the Mac, the Mac calendar); tests pass in-memory sources.
 */
export function AgendaScreen({
  workspaceId,
  entries,
  google,
  search,
  onNavigate,
  onConnect,
  onUseAccount,
  onRetryAccounts,
}: {
  workspaceId: string;
  entries: readonly AgendaSourceEntry[];
  google: GoogleAccountsState;
  search: AgendaSearch;
  onNavigate: (search: Required<AgendaSearch>) => void;
  onConnect: () => void;
  onUseAccount: (accountId: string) => void;
  onRetryAccounts: () => void;
}) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const now = useAgendaNow();
  const today = dateKey(now);
  const view = search.view ?? "week";
  const anchor = search.date ?? today;
  const period = useMemo(() => agendaPeriod(view, anchor), [view, anchor]);
  const data = useAgendaData({
    workspaceId,
    entries,
    start: period.start,
    end: period.end,
  });
  const [target, setTarget] = useState<AgendaDetailsTarget | null>(null);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const [moveConfirm, setMoveConfirm] = useState<(() => void) | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AgendaEvent | null>(null);
  const selected = target?.kind === "event" ? target.event : null;

  const calendarOf = useCallback(
    (event: AgendaEvent) => data.calendarByKey.get(eventCalendarKey(event)),
    [data.calendarByKey]
  );
  const colorOf = useCallback(
    (event: AgendaEvent) => calendarOf(event)?.color ?? event.color ?? "#5b8def",
    [calendarOf]
  );
  const calendarNameOf = useCallback(
    (event: AgendaEvent) => calendarOf(event)?.name ?? "",
    [calendarOf]
  );
  const sourceLabelOf = useCallback(
    (calendar: AgendaCalendar) =>
      calendar.source === "mac"
        ? m.agenda_mac_calendar()
        : (entries.find((entry) => entry.accountId === calendar.accountId)?.label ??
          ""),
    [entries, m]
  );

  // A new event goes to the last calendar used, or the first account's primary.
  const defaultCalendarKey = useMemo(() => {
    const writable = data.calendars.filter((calendar) => calendar.writable);
    return (
      writable.find((calendar) => calendar.key === data.lastCalendarKey)?.key ??
      writable.find((calendar) => calendar.primary)?.key ??
      writable[0]?.key
    );
  }, [data.calendars, data.lastCalendarKey]);

  const withScope = (
    event: AgendaEvent,
    kind: ScopeRequest["kind"],
    run: ScopeRequest["run"]
  ) => {
    if (event.seriesId) setScopeRequest({ kind, run });
    else run("instance");
  };

  const move = (event: AgendaEvent, start: Date, end: Date) => {
    const patch: Partial<AgendaEventInput> = {
      start: localIsoString(start),
      end: localIsoString(end),
      timeZone: systemTimeZone(),
    };
    withScope(event, "update", (scope) => void data.update(event, scope, patch));
  };

  const removeEvent = data.remove;
  const requestDelete = useCallback(
    (event: AgendaEvent) => {
      if (!event.editable || !calendarOf(event)?.writable) return;
      if (event.seriesId)
        setScopeRequest({
          kind: "delete",
          run: (scope) => {
            setTarget(null);
            void removeEvent(event, scope);
          },
        });
      else setDeleteConfirm(event);
    },
    [calendarOf, removeEvent]
  );

  const save = ({ calendar, input, patch }: AgendaDetailsSave) => {
    if (!target) return;
    if (target.kind === "new") {
      setTarget(null);
      void data.create(calendar, input);
      return;
    }
    const event = target.event;
    const moving = calendar.key !== eventCalendarKey(event);
    const otherSource =
      moving &&
      (calendar.source !== event.source || calendar.accountId !== event.accountId);
    if (!moving && Object.keys(patch).length === 0) {
      setTarget(null);
      return;
    }
    const run = () =>
      withScope(event, "update", (scope) => {
        setTarget(null);
        void data.update(
          event,
          scope,
          otherSource ? input : patch,
          moving ? calendar : undefined
        );
      });
    if (otherSource) setMoveConfirm(() => run);
    else run();
  };

  // Delete removes the selected event, after the same confirmation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const element = event.target as HTMLElement | null;
      if (
        element?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']"
        )
      )
        return;
      if (selected) {
        event.preventDefault();
        requestDelete(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, requestDelete]);

  const errorMessage = (code: AgendaErrorCode) =>
    ({
      write_permission: m.agenda_error_write_permission(),
      conflict: m.agenda_error_conflict(),
      access: m.agenda_error_access(),
      timeout: m.agenda_error_timeout(),
      unavailable: m.agenda_error_unavailable(),
      read_only: m.agenda_error_read_only(),
      not_found: m.agenda_error_not_found(),
      generic: m.agenda_error_generic(),
    })[code];

  const draft = target?.kind === "new" ? target : null;

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-main-panel-bg"
      data-testid="agenda"
    >
      <AgendaToolbar
        onStep={(direction) =>
          onNavigate({ view, date: shiftAnchor(view, anchor, direction) })
        }
        onToday={() => onNavigate({ view, date: today })}
        onTogglePanel={() => data.setPanelOpen(!data.panelOpen)}
        onView={(next) =>
          onNavigate({
            view: next,
            // A period that holds today keeps today in the new view.
            date: now >= period.start && now < period.end ? today : anchor,
          })
        }
        onZoom={data.setZoom}
        panelOpen={data.panelOpen}
        rangeLabel={agendaRangeLabel(period, view, locale)}
        view={view}
        zoom={data.zoom}
      />
      {data.writeError && (
        <div
          className="mx-xl mb-md flex items-center justify-between gap-md rounded-md border border-secondary bg-primary px-lg py-sm text-sm text-primary"
          role="alert"
        >
          <span>{errorMessage(data.writeError.code)}</span>
          <span className="flex gap-sm">
            {data.writeError.source === "google" &&
              agendaErrorNeedsReconnect(data.writeError.code) && (
                <Button hierarchy="secondary-gray" onPress={onConnect} size="xs">
                  {m.agenda_reconnect()}
                </Button>
              )}
            <Button hierarchy="tertiary-gray" onPress={data.clearWriteError} size="xs">
              {m.agenda_dismiss()}
            </Button>
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-md px-xl pb-xl">
        {data.panelOpen && (
          <AgendaCalendarPanel
            google={google}
            groups={data.groups}
            isVisible={data.isVisible}
            onConnect={onConnect}
            onRetry={data.retry}
            onRetryAccounts={onRetryAccounts}
            onUseAccount={onUseAccount}
            onVisible={data.setVisible}
          />
        )}
        {view === "month" ? (
          <AgendaMonthGrid
            colorOf={colorOf}
            days={period.days}
            events={data.events}
            month={period.focus.getMonth()}
            now={now}
            onSelect={(event) => setTarget({ kind: "event", event })}
            selectedKey={selected?.key ?? null}
          />
        ) : (
          <AgendaTimeGrid
            calendarNameOf={calendarNameOf}
            colorOf={colorOf}
            days={period.days}
            draft={draft}
            events={data.events}
            now={now}
            onCreate={(start, end, allDay) =>
              setTarget({ kind: "new", start, end, allDay })
            }
            onMove={move}
            onSelect={(event) => setTarget({ kind: "event", event })}
            selectedKey={selected?.key ?? null}
            zoom={data.zoom}
          />
        )}
        {target && (
          <AgendaEventDetails
            calendar={selected ? calendarOf(selected) : undefined}
            calendars={data.calendars}
            defaultCalendarKey={defaultCalendarKey}
            key={
              target.kind === "event"
                ? target.event.key
                : `new:${target.start.getTime()}:${target.allDay}`
            }
            loadRecurrence={(event) =>
              entries
                .find(
                  (entry) =>
                    entry.kind === event.source &&
                    (event.source === "mac" || entry.accountId === event.accountId)
                )
                ?.source.recurrence(event) ?? Promise.resolve("none")
            }
            onClose={() => setTarget(null)}
            onDelete={() => selected && requestDelete(selected)}
            onSave={save}
            sourceLabelOf={sourceLabelOf}
            target={target}
          />
        )}
      </div>
      {scopeRequest && (
        <Dialog
          actions={[
            {
              hierarchy: "secondary-gray",
              label: m.agenda_cancel(),
              onPress: () => setScopeRequest(null),
            },
            {
              hierarchy: "secondary-gray",
              label: m.agenda_scope_series(),
              shortcut: false,
              onPress: () => {
                setScopeRequest(null);
                scopeRequest.run("series");
              },
            },
            {
              hierarchy: scopeRequest.kind === "delete" ? "destructive" : "primary",
              label: m.agenda_scope_instance(),
              onPress: () => {
                setScopeRequest(null);
                scopeRequest.run("instance");
              },
            },
          ]}
          description={m.agenda_scope_description()}
          isOpen
          onOpenChange={(open) => {
            if (!open) setScopeRequest(null);
          }}
          title={
            scopeRequest.kind === "delete"
              ? m.agenda_scope_delete_title()
              : m.agenda_scope_title()
          }
        />
      )}
      {moveConfirm && (
        <Dialog
          actions={[
            {
              hierarchy: "secondary-gray",
              label: m.agenda_cancel(),
              onPress: () => setMoveConfirm(null),
            },
            {
              hierarchy: "primary",
              label: m.agenda_move_source_confirm(),
              onPress: () => {
                setMoveConfirm(null);
                moveConfirm();
              },
            },
          ]}
          description={m.agenda_move_source_description()}
          isOpen
          onOpenChange={(open) => {
            if (!open) setMoveConfirm(null);
          }}
          title={m.agenda_move_source_title()}
        />
      )}
      {deleteConfirm && (
        <Dialog
          actions={[
            {
              hierarchy: "secondary-gray",
              label: m.agenda_cancel(),
              onPress: () => setDeleteConfirm(null),
            },
            {
              hierarchy: "destructive",
              label: m.agenda_delete(),
              onPress: () => {
                setDeleteConfirm(null);
                setTarget(null);
                void data.remove(deleteConfirm, "instance");
              },
            },
          ]}
          description={m.agenda_delete_description({
            title: deleteConfirm.title.trim() || m.agenda_untitled(),
          })}
          isOpen
          onOpenChange={(open) => {
            if (!open) setDeleteConfirm(null);
          }}
          title={m.agenda_delete_title()}
        />
      )}
    </div>
  );
}
