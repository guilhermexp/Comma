import { useCommaMessages } from "@comma/i18n/react";
import { Button, ScrollArea } from "@comma/ui";
import type { ComposioAccount } from "../../api";
import { composioAccountPresentation } from "../plugins/composioAccountPresentation";
import type { AgendaCalendar } from "./agendaSource";
import type { MacCalendarPrompt } from "./macCalendarSource";
import type { AgendaGroup } from "./useAgendaData";

export type GoogleAccountsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; candidates: ComposioAccount[] };

type Section = { id: string; title: string; calendars: AgendaCalendar[] };

// Mac calendars group by the account that owns them; calendars without an
// owning account (subscriptions) come last.
function macSections(calendars: AgendaCalendar[], subscribed: string): Section[] {
  const byOwner = new Map<string, AgendaCalendar[]>();
  for (const calendar of calendars) {
    const owner = calendar.sourceLabel ?? calendar.ownerEmail ?? "";
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), calendar]);
  }
  return [...byOwner.entries()]
    .toSorted(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([owner, items]) => ({
      id: owner || "subscribed",
      title: owner || subscribed,
      calendars: items,
    }));
}

export function AgendaCalendarPanel({
  groups,
  google,
  mac,
  isVisible,
  onVisible,
  onRetry,
  onConnect,
  onUseAccount,
  onRetryAccounts,
}: {
  groups: readonly AgendaGroup[];
  google: GoogleAccountsState;
  /** The Mac Calendar waiting for the reader: off, or access not granted. */
  mac?: MacCalendarPrompt | null;
  isVisible: (calendar: AgendaCalendar) => boolean;
  onVisible: (calendar: AgendaCalendar, visible: boolean) => void;
  onRetry: (entryKey: string) => void;
  onConnect: () => void;
  onUseAccount: (accountId: string) => void;
  onRetryAccounts: () => void;
}) {
  const m = useCommaMessages();
  const googleGroups = groups.filter((group) => group.entry.kind === "google");

  return (
    <aside
      aria-label={m.agenda_calendars()}
      className="flex w-60 shrink-0 flex-col rounded-lg border border-secondary bg-primary"
    >
      <h2 className="m-0 px-lg pt-lg pb-sm text-sm font-semibold text-primary">
        {m.agenda_calendars()}
      </h2>
      <ScrollArea
        className="min-h-0 flex-1"
        contentClassName="flex flex-col gap-lg px-lg pb-lg"
      >
        {googleGroups.map((group) => (
          <SourceGroup
            group={group}
            isVisible={isVisible}
            key={group.entry.key}
            onRetry={() => onRetry(group.entry.key)}
            onVisible={onVisible}
            sections={[
              {
                id: "google",
                title: group.entry.email ?? group.entry.label,
                calendars: group.calendars,
              },
            ]}
          />
        ))}
        {google.status === "loading" && (
          <p className="m-0 text-sm text-tertiary">{m.agenda_loading()}</p>
        )}
        {google.status === "error" && (
          <div className="flex flex-col items-start gap-sm text-sm" role="alert">
            <p className="m-0 text-primary">{m.agenda_source_failed()}</p>
            <Button hierarchy="secondary-gray" onPress={onRetryAccounts} size="xs">
              {m.agenda_retry()}
            </Button>
          </div>
        )}
        {google.status === "ready" && googleGroups.length === 0 && (
          <div className="flex flex-col items-start gap-sm text-sm">
            {google.candidates.length > 0 ? (
              google.candidates.map((candidate) => {
                const identity = composioAccountPresentation(
                  candidate,
                  google.candidates
                );
                return (
                  <div className="flex flex-col items-start gap-xs" key={candidate.id}>
                    <span className="text-primary">
                      {identity.email ?? identity.name}
                    </span>
                    <Button
                      hierarchy="secondary-gray"
                      onPress={() => onUseAccount(candidate.id)}
                      size="xs"
                    >
                      {m.agenda_use_account()}
                    </Button>
                  </div>
                );
              })
            ) : (
              <>
                <p className="m-0 text-tertiary">{m.agenda_google_connect_hint()}</p>
                <Button hierarchy="secondary-gray" onPress={onConnect} size="xs">
                  {m.agenda_google_connect()}
                </Button>
              </>
            )}
          </div>
        )}
        {groups
          .filter((group) => group.entry.kind === "mac")
          .map((group) => (
            <SourceGroup
              group={group}
              heading={m.agenda_mac_calendar()}
              isVisible={isVisible}
              key={group.entry.key}
              onRetry={() => onRetry(group.entry.key)}
              onVisible={onVisible}
              sections={macSections(group.calendars, m.agenda_subscribed_calendars())}
            />
          ))}
        {mac && <MacCalendarAccess prompt={mac} />}
      </ScrollArea>
    </aside>
  );
}

function MacCalendarAccess({ prompt }: { prompt: MacCalendarPrompt }) {
  const m = useCommaMessages();
  const reason = {
    notDetermined: m.agenda_mac_enable_hint(),
    denied: m.agenda_mac_denied(),
    restricted: m.agenda_mac_restricted(),
    writeOnly: m.agenda_mac_write_only(),
  }[prompt.access];
  return (
    <section
      aria-label={m.agenda_mac_calendar()}
      className="flex flex-col items-start gap-xs text-sm"
      data-testid="agenda-source"
    >
      <h3 className="m-0 text-xs font-semibold tracking-wide text-tertiary uppercase">
        {m.agenda_mac_calendar()}
      </h3>
      <p className="m-0 text-tertiary">{reason}</p>
      {prompt.access === "notDetermined" ? (
        <Button hierarchy="secondary-gray" onPress={prompt.enable} size="xs">
          {m.agenda_mac_enable()}
        </Button>
      ) : (
        <Button hierarchy="secondary-gray" onPress={prompt.openSettings} size="xs">
          {m.agenda_mac_open_settings()}
        </Button>
      )}
    </section>
  );
}

function SourceGroup({
  group,
  heading,
  sections,
  isVisible,
  onVisible,
  onRetry,
}: {
  group: AgendaGroup;
  heading?: string;
  sections: Section[];
  isVisible: (calendar: AgendaCalendar) => boolean;
  onVisible: (calendar: AgendaCalendar, visible: boolean) => void;
  onRetry: () => void;
}) {
  const m = useCommaMessages();
  return (
    <section
      aria-label={heading ?? group.entry.email ?? group.entry.label}
      className="flex flex-col gap-xs"
      data-testid="agenda-source"
    >
      {heading && (
        <h3 className="m-0 text-xs font-semibold tracking-wide text-tertiary uppercase">
          {heading}
        </h3>
      )}
      {sections.map((section) => (
        <div className="flex flex-col gap-xxs" key={section.id}>
          <h4 className="m-0 truncate text-xs font-medium text-tertiary">
            {section.title}
          </h4>
          {section.calendars.map((calendar) => (
            <label
              className="flex cursor-pointer items-center gap-sm rounded-sm px-xs py-xxs text-sm text-secondary hover:bg-secondary"
              key={calendar.key}
            >
              <input
                checked={isVisible(calendar)}
                className="size-4 shrink-0 cursor-pointer"
                onChange={(event) => onVisible(calendar, event.target.checked)}
                style={{ accentColor: calendar.color }}
                type="checkbox"
              />
              <span className="truncate">{calendar.name}</span>
            </label>
          ))}
        </div>
      ))}
      {group.status === "loading" && group.calendars.length === 0 && (
        <p className="m-0 text-sm text-tertiary">{m.agenda_loading()}</p>
      )}
      {group.status === "error" && (
        <div className="flex flex-col items-start gap-xs text-sm" role="alert">
          <p className="m-0 text-error-primary">{m.agenda_source_failed()}</p>
          <Button hierarchy="secondary-gray" onPress={onRetry} size="xs">
            {m.agenda_retry()}
          </Button>
        </div>
      )}
      {group.truncated && (
        <p className="m-0 text-xs text-tertiary">{m.agenda_truncated()}</p>
      )}
    </section>
  );
}
