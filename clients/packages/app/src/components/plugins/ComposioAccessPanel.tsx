import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, Dropdown, Checkbox } from "@comma/ui";
import { useCommaMessages } from "@comma/i18n/react";
import { composioAccountPresentation } from "./composioAccountPresentation";
import type { CommaApiClient, ComposioAccount } from "../../api";

export function ComposioAccessPanel({
  api,
  workspaceId,
  accounts,
}: {
  api: CommaApiClient;
  workspaceId: string;
  accounts: ComposioAccount[];
}) {
  const m = useCommaMessages();
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [workerCursor, setWorkerCursor] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [account, setAccount] = useState("");
  const [sharingAccepted, setSharingAccepted] = useState(false);
  useEffect(() => {
    if (
      !accounts.some(
        (item) => item.id === account && item.enabled && item.status === "ACTIVE"
      )
    ) {
      setAccount(
        accounts.find((item) => item.enabled && item.status === "ACTIVE")?.id ?? ""
      );
    }
  }, [accounts, account]);
  const [enabled, setEnabled] = useState(false);
  const [grantLoaded, setGrantLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getAgentModels(workspaceId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setAgents(
          [result.agents.router, ...result.workers.items].map((item) => ({
            id: item.agent_id,
            label: item.name,
          }))
        );
        setWorkerCursor(result.workers.next_cursor);
        setAgent(result.agents.router.agent_id);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      controller.abort();
    };
  }, [api, workspaceId]);

  useEffect(() => {
    setEnabled(false);
    setGrantLoaded(false);
    setSharingAccepted(false);
    setSaved(false);
    if (!agent || !account) return;
    const controller = new AbortController();
    void api
      .composioCommand(
        workspaceId,
        "grant",
        { agent_id: agent, account_id: account },
        { signal: controller.signal }
      )
      .then((result) => {
        if (!controller.signal.aborted) {
          setEnabled(z.object({ enabled: z.boolean() }).parse(result).enabled);
          setGrantLoaded(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [api, workspaceId, agent, account]);

  const run = async (operation: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      await operation();
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-lg">
      <h2 className="m-0 text-sm font-medium">{m.composio_agent_access()}</h2>
      <p className="m-0 text-sm text-secondary">{m.composio_grant_hint()}</p>
      {saved && <output>{m.composio_grant_saved()}</output>}
      <Dropdown
        label={m.composio_agent()}
        items={agents}
        value={agent}
        onChange={setAgent}
        disabled={busy}
      />
      {workerCursor && (
        <Button
          hierarchy="tertiary-gray"
          isDisabled={busy}
          onPress={() =>
            void run(async () => {
              const page = await api.getWorkerModels(workspaceId, workerCursor);
              setAgents((current) => [
                ...current,
                ...page.items.map((item) => ({
                  id: item.agent_id,
                  label: item.name,
                })),
              ]);
              setWorkerCursor(page.next_cursor);
            })
          }
        >
          {m.composio_next()}
        </Button>
      )}
      <Dropdown
        label={m.composio_accounts()}
        items={accounts
          .filter((item) => item.status === "ACTIVE" && item.enabled)
          .map((item) => {
            const { name, email, number } = composioAccountPresentation(item, accounts);
            return {
              id: item.id,
              label: [
                name,
                email !== name ? email : null,
                number ? m.composio_connection_number({ number }) : null,
              ]
                .filter(Boolean)
                .join(" · "),
            };
          })}
        value={account}
        onChange={setAccount}
        disabled={busy}
      />
      <output className="text-sm text-secondary">
        {enabled ? m.composio_access_allowed() : m.composio_access_not_allowed()}
      </output>
      <Checkbox
        label={m.composio_share_confirmation()}
        checked={sharingAccepted}
        disabled={busy || !account}
        onChange={(event) => setSharingAccepted(event.target.checked)}
      />
      <div className="flex gap-md">
        <Button
          isDisabled={busy || !agent || !account || !grantLoaded || !sharingAccepted}
          onPress={() =>
            void run(async () => {
              await api.composioCommand(workspaceId, "account", {
                operation: "grant",
                account_id: account,
                agent_id: agent,
                enabled: true,
                share_with_workspace: true,
              });
              setEnabled(true);
              setSaved(true);
            })
          }
        >
          {m.composio_grant()}
        </Button>
        <Button
          hierarchy="secondary-gray"
          isDisabled={busy || !agent || !account}
          onPress={() =>
            void run(async () => {
              await api.composioCommand(workspaceId, "account", {
                operation: "grant",
                account_id: account,
                agent_id: agent,
                enabled: false,
              });
              setEnabled(false);
              setSaved(true);
            })
          }
        >
          {m.composio_revoke()}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-secondary">
          {m.composio_error()}
        </p>
      )}
    </section>
  );
}
