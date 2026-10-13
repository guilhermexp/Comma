import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, Dropdown, Checkbox, ScrollAreaLoadMore } from "@comma/ui";
import { useCommaMessages } from "@comma/i18n/react";
import { composioAccountPresentation } from "./composioAccountPresentation";
import type { CommaApiClient, ComposioAccount } from "../../api";

const approvalSchema = z.object({
  request_id: z.string(),
  source_agent_id: z.string(),
  request_payload: z.object({
    account_name: z.string(),
    account_id: z.string(),
    tools: z.array(
      z.object({ tool_slug: z.string(), arguments: z.record(z.string(), z.unknown()) })
    ),
  }),
});
const approvalsSchema = z.object({
  requests: z.array(approvalSchema),
  next_cursor: z.string().nullable(),
});

export function ComposioAccessPanel({
  api,
  workspaceId,
  accounts,
  manageAccess = false,
}: {
  api: CommaApiClient;
  workspaceId: string;
  accounts: ComposioAccount[];
  manageAccess?: boolean;
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
  const [approvals, setApprovals] = useState<z.infer<typeof approvalSchema>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [outcome, setOutcome] = useState<string>();
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
    if (!manageAccess || !agent || !account) return;
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
  }, [api, workspaceId, agent, account, manageAccess]);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .composioCommand(workspaceId, "approvals", {}, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const page = approvalsSchema.parse(result);
        setApprovals(page.requests);
        setCursor(page.next_cursor);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [api, workspaceId]);

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
  const loadApprovals = async (next?: string) => {
    const result = approvalsSchema.parse(
      await api.composioCommand(workspaceId, "approvals", next ? { cursor: next } : {})
    );
    setApprovals((current) =>
      next ? [...current, ...result.requests] : result.requests
    );
    setCursor(result.next_cursor);
  };

  return (
    <section className="flex flex-col gap-lg">
      {manageAccess && (
        <>
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
                const { name, email, number } = composioAccountPresentation(
                  item,
                  accounts
                );
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
              isDisabled={
                busy || !agent || !account || !grantLoaded || !sharingAccepted
              }
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
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-secondary">
          {m.composio_error()}
        </p>
      )}
      {outcome && <output className="text-sm">{outcome}</output>}
      <h2 className="m-0 text-sm font-medium">{m.composio_approvals()}</h2>
      <div>
        <Button
          hierarchy="secondary-gray"
          isDisabled={busy}
          onPress={() => void run(() => loadApprovals())}
        >
          {m.composio_refresh_approvals()}
        </Button>
      </div>
      {approvals
        .filter((request) =>
          accounts.some((item) => item.id === request.request_payload.account_id)
        )
        .map((request) => (
          <div
            key={request.request_id}
            className="flex flex-col gap-md border-b border-secondary pb-lg"
          >
            <p className="m-0 text-sm">{request.request_payload.account_name}</p>
            <p className="m-0 text-sm text-secondary">
              {agents.find((item) => item.id === request.source_agent_id)?.label ??
                m.composio_agent()}
            </p>
            {request.request_payload.tools.map((tool, index) => (
              <div key={`${index}:${tool.tool_slug}`}>
                <p className="m-0 text-sm font-medium">{tool.tool_slug}</p>
                <dl className="m-0 flex flex-col gap-sm text-sm">
                  {Object.entries(tool.arguments).map(([name, value]) => (
                    <div key={name}>
                      <dt className="font-medium">{name.replaceAll("_", " ")}</dt>
                      <dd className="m-0 break-words text-secondary">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
            <div className="flex gap-md">
              {[true, false].map((approved) => (
                <Button
                  key={String(approved)}
                  hierarchy={approved ? "primary" : "secondary-gray"}
                  isDisabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const response = await api.composioCommand(
                        workspaceId,
                        "decide",
                        {
                          request_id: request.request_id,
                          approved,
                        }
                      );
                      const result = z
                        .object({ result: z.object({ error: z.boolean() }) })
                        .parse(response);
                      setOutcome(
                        !approved
                          ? m.composio_deny()
                          : result.result.error
                            ? m.composio_uncertain()
                            : m.composio_action_complete()
                      );
                      await loadApprovals();
                    })
                  }
                >
                  {approved ? m.composio_approve_once() : m.composio_deny()}
                </Button>
              ))}
            </div>
          </div>
        ))}
      <ScrollAreaLoadMore
        hasMore={Boolean(cursor)}
        loading={busy}
        failed={error}
        onLoadMore={() => {
          if (cursor) void run(() => loadApprovals(cursor));
        }}
      />
    </section>
  );
}
