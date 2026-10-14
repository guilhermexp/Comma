import { useCallback, useEffect, useRef, useState } from "react";
import { useCommaMessages } from "@comma/i18n/react";
import {
  Avatar,
  Menu,
  MenuItem,
  MenuPopover,
  MenuTrigger,
  MoreHorizontalIcon,
  Button,
  InputField,
  ScrollAreaLoadMore,
  PageLoading,
  Dialog,
  PluginDetail,
  type PluginDefinition,
} from "@comma/ui";
import type { CommaApiClient, ComposioStatus, ComposioAccount } from "../../api";
import { composioAccountSchema, composioStatusSchema } from "../../api";
import { z } from "zod";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";

import { composioAccountPresentation } from "./composioAccountPresentation";
import { ComposioAccessPanel } from "./ComposioAccessPanel";

const consentSchema = z.object({
  id: z.string().min(1),
  toolkit: z.string().min(1),
  status: z.enum([
    "starting",
    "pending",
    "selecting",
    "completed",
    "cancelled",
    "expired",
  ]),
  expires_at: z.number(),
  baseline_account_ids: z.array(z.string()).nullable().optional(),
});
const consentResponseSchema = z.object({ consent: consentSchema.nullable() });
const connectConsentResponseSchema = z.object({
  consent_id: z.string().min(1),
  authorization_url: z.string().min(1),
  status: z.literal("pending"),
});
type Consent = Omit<z.infer<typeof consentSchema>, "expires_at"> & {
  expires_at?: number;
};

export function ComposioConnectorDetail({
  api,
  workspaceId,
  onBack,
  plugin,
  toolkit,
  startConnecting = false,
  onStartConnectingConsumed,
}: {
  api: CommaApiClient;
  workspaceId: string;
  onBack: () => void;
  plugin: PluginDefinition;
  toolkit: string;
  startConnecting?: boolean;
  onStartConnectingConsumed?: () => void;
}) {
  const m = useCommaMessages();
  const [status, setStatus] = useState<ComposioStatus>();
  const [consent, setConsent] = useState<Consent | null>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [key, setKey] = useState("");
  const [details, setDetails] = useState<ComposioAccount>();
  const [disconnect, setDisconnect] = useState<{ id: string; name: string }>();
  const [authorization, setAuthorization] = useState<string>();
  const [candidates, setCandidates] = useState<ComposioAccount[]>([]);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const connectionStarted = useRef(false);
  const signInStarted = useRef(false);
  const consentInProgress =
    consent?.toolkit === toolkit &&
    (consent.status === "starting" ||
      consent.status === "pending" ||
      consent.status === "selecting");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const next = await api.getComposio(workspaceId, signal ? { signal } : {});
      let nextConsent: Consent | null = null;
      if (next.mode === "connect") {
        const result = await api.composioCommand(
          workspaceId,
          "consent",
          { toolkit, operation: "get" },
          signal ? { signal } : {}
        );
        nextConsent = consentResponseSchema.parse(result).consent;
        if (nextConsent && nextConsent.toolkit !== toolkit)
          throw new Error("Composio consent toolkit mismatch");
      }
      if (mounted.current && !signal?.aborted) {
        setStatus(next);
        setConsent(nextConsent);
      }
      return next;
    },
    [api, toolkit, workspaceId]
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  // At most one request per window every 2 s, only during the ten-minute login.
  // No timer per account, and a request completes before the next is scheduled.
  useEffect(() => {
    if (status?.status !== "pending" || !status.expires_at) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= status.expires_at!) {
        setError(true);
        return;
      }
      try {
        const next = await api.getComposio(workspaceId, { signal: controller.signal });
        if (next.status === "connected") {
          await api.composioCommand(
            workspaceId,
            "verify",
            {},
            { signal: controller.signal }
          );
          if (!controller.signal.aborted) {
            setStatus(next);
            setAuthorization(undefined);
          }
          return;
        }
        if (!controller.signal.aborted) setStatus(next);
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          return;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, load, status?.status, status?.expires_at, workspaceId]);

  // One mounted detail, one toolkit, at most 50 remote accounts per read.
  // Timer reads are at least 2 s apart for at most the ten-minute consent.
  // Focus/visibility checks share that same request and rate bound.
  useEffect(() => {
    setCandidates([]);
    if (
      status?.mode !== "connect" ||
      consent?.status !== "pending" ||
      consent.toolkit !== toolkit ||
      !consent.expires_at
    )
      return;
    const id = consent.id;
    const expiry = consent.expires_at;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let timer: ReturnType<typeof setTimeout>;
    let lastRead = -Infinity;
    let checking = false;
    let selecting = false;
    const expire = () => {
      controller.abort();
      clearTimeout(timer);
      setConsent((current) =>
        current?.id === id ? { ...current, status: "expired" } : current
      );
    };
    const expiryTimer = setTimeout(expire, Math.max(0, expiry - Date.now()));
    const schedule = (delay = 2000) => {
      clearTimeout(timer);
      if (!controller.signal.aborted) timer = setTimeout(() => void check(), delay);
    };
    const check = async () => {
      if (controller.signal.aborted || checking) return;
      if (Date.now() >= expiry) {
        expire();
        return;
      }
      if (inFlight.current) {
        schedule();
        return;
      }
      const remaining = 2000 - (Date.now() - lastRead);
      if (remaining > 0) {
        schedule(remaining);
        return;
      }
      checking = true;
      inFlight.current = true;
      lastRead = Date.now();
      clearTimeout(timer);
      try {
        const result = await api.composioCommand(
          workspaceId,
          "refresh_accounts",
          { toolkit, consent_id: id },
          options
        );
        if (controller.signal.aborted) return;
        const discovery = composioStatusSchema
          .extend({
            consent: consentSchema,
            remote_accounts: z.array(composioAccountSchema),
          })
          .parse(result);
        const next = discovery.consent;
        if (next.id !== id || next.toolkit !== toolkit)
          throw new Error("Stale consent discovery");
        setStatus(discovery);
        setConsent(next);
        if (next.status !== "pending") return;
        const active = discovery.remote_accounts.filter(
          (account) =>
            account.mode === "connect" &&
            account.toolkit === toolkit &&
            account.status === "ACTIVE"
        );
        const available = active.filter(
          (account) =>
            !discovery.accounts.some(
              (local) =>
                local.id === account.id &&
                local.mode === account.mode &&
                local.toolkit === account.toolkit &&
                local.status === "ACTIVE" &&
                local.enabled
            )
        );
        setCandidates(available);
        // Missing historical baselines require a human choice. All IDs that
        // existed at start (including inactive accounts) are excluded from auto selection.
        const fresh = next.baseline_account_ids
          ? available.filter(
              (account) => !next.baseline_account_ids!.includes(account.id)
            )
          : [];
        if (fresh.length === 1) {
          selecting = true;
          setBusy(true);
          await api.composioCommand(
            workspaceId,
            "consent",
            {
              toolkit,
              consent_id: id,
              operation: "select",
              account_id: fresh[0]!.id,
            },
            options
          );
          if (!controller.signal.aborted) await load(controller.signal);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        checking = false;
        inFlight.current = false;
        if (selecting && mounted.current) setBusy(false);
        schedule();
      }
    };
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void check();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [
    api,
    workspaceId,
    toolkit,
    consent?.id,
    consent?.status,
    consent?.expires_at,
    consent?.toolkit,
    status?.mode,
    load,
  ]);

  const act = async (
    action: string,
    params: Parameters<CommaApiClient["composioCommand"]>[2] = {}
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    // The route owns this one-shot intent across detail remounts. Consume it
    // before dispatch, including when the response is lost or rejected.
    if (action === "connect") onStartConnectingConsumed?.();
    setBusy(true);
    setError(false);
    let loadedAfterAction = false;
    try {
      const result = await api.composioCommand(workspaceId, action, params);
      if (!mounted.current) return;
      if (action === "connect" && status?.mode === "connect") {
        const started = connectConsentResponseSchema.parse(result);
        setConsent({
          id: started.consent_id,
          toolkit,
          status: "pending",
        });
        await openNativePlatformExternalUrl(started.authorization_url);
      } else if (typeof result.authorization_url === "string") {
        if (action === "authorize") setAuthorization(result.authorization_url);
        await openNativePlatformExternalUrl(result.authorization_url);
      }
      if (action === "cancel") setAuthorization(undefined);
      if (action === "accounts") {
        const page = z
          .object({
            items: z.array(composioAccountSchema),
            next_cursor: z.string().nullable(),
          })
          .parse(result);
        setStatus((current) =>
          current
            ? {
                ...current,
                accounts: [...current.accounts, ...page.items],
                next_cursor: page.next_cursor,
              }
            : current
        );
        return;
      }
      loadedAfterAction = true;
      await load();
    } catch {
      if (mounted.current) setError(true);
      if (
        (action === "connect" ||
          (action === "account" && params.operation === "reconnect")) &&
        status?.mode === "connect" &&
        !loadedAfterAction
      ) {
        try {
          await load();
        } catch {
          if (mounted.current) setError(true);
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!startConnecting || !status) return;
    if (status.mode === "connect" && consentInProgress) {
      connectionStarted.current = true;
      onStartConnectingConsumed?.();
      return;
    }
    if (status.status === "connected" && !connectionStarted.current) {
      connectionStarted.current = true;
      void act("connect", { toolkit });
    } else if (
      status.mode === "connect" &&
      status.status !== "pending" &&
      status.status !== "connected" &&
      !signInStarted.current
    ) {
      signInStarted.current = true;
      void act("authorize");
    }
  });

  const accounts =
    status?.accounts.filter(
      (account) => account.toolkit === toolkit && account.mode === status.mode
    ) ?? [];
  const connected = accounts.filter(
    (account) => account.status === "ACTIVE" && account.enabled
  );
  const inactive = accounts.filter(
    (account) => account.status !== "ACTIVE" || !account.enabled
  );
  const accountRows = (items: ComposioAccount[], selectionCandidates = false) =>
    items.map((account) => {
      const { name, email, number } = composioAccountPresentation(account, [
        ...accounts,
        ...candidates.filter(
          (candidate) => !accounts.some((item) => item.id === candidate.id)
        ),
      ]);
      const discriminator = number ? m.composio_connection_number({ number }) : "";
      return (
        <fieldset
          key={account.id}
          aria-label={[name, email !== name ? email : null, discriminator]
            .filter(Boolean)
            .join(" · ")}
          className="m-0 flex min-w-0 items-center gap-lg border-0 border-b border-solid border-secondary px-xl py-lg last:border-b-0"
        >
          <Avatar name={name} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-xxs text-sm">
            <span className="break-words font-medium">{name}</span>
            {email && email !== name && (
              <span className="break-all text-secondary">{email}</span>
            )}
            {!selectionCandidates && (
              <span className="text-xs text-secondary">
                {!account.enabled
                  ? m.composio_disabled()
                  : account.status === "ACTIVE"
                    ? m.composio_connected()
                    : account.status === "INITIATED"
                      ? m.composio_pending_account()
                      : account.status === "EXPIRED"
                        ? m.composio_expired_account()
                        : m.composio_unavailable()}
                {discriminator && ` · ${discriminator}`}
              </span>
            )}
          </div>
          {!selectionCandidates && (
            <MenuTrigger>
              <Button
                aria-label={m.composio_account_options({ account: name })}
                hierarchy="tertiary-gray"
                size="sm"
                iconLeading={<MoreHorizontalIcon />}
                isDisabled={busy}
              />
              <MenuPopover>
                <Menu aria-label={m.composio_account_options({ account: name })}>
                  <MenuItem onAction={() => setDetails(account)}>
                    {m.composio_account_details()}
                  </MenuItem>
                  {(account.status === "INITIATED"
                    ? ["verify", "reopen", "cancel", "reconnect"]
                    : [
                        "verify",
                        account.enabled ? "disable" : "enable",
                        "reconnect",
                        "disconnect",
                      ]
                  ).map((operation) => (
                    <MenuItem
                      key={operation}
                      tone={operation === "disconnect" ? "destructive" : "default"}
                      onAction={() => {
                        if (operation === "disconnect") setDisconnect(account);
                        else void act("account", { account_id: account.id, operation });
                      }}
                    >
                      {operation === "verify"
                        ? m.composio_verify()
                        : operation === "disable"
                          ? m.composio_disable()
                          : operation === "enable"
                            ? m.composio_enable()
                            : operation === "reopen"
                              ? m.composio_reopen()
                              : operation === "cancel"
                                ? m.composio_cancel()
                                : operation === "reconnect"
                                  ? m.composio_reconnect()
                                  : m.composio_disconnect()}
                    </MenuItem>
                  ))}
                </Menu>
              </MenuPopover>
            </MenuTrigger>
          )}
          {account.status === "ACTIVE" &&
            !account.enabled &&
            consent?.status === "pending" &&
            consent.toolkit === toolkit && (
              <Button
                hierarchy="secondary-gray"
                size="sm"
                isDisabled={busy}
                onPress={() =>
                  void act("consent", {
                    toolkit,
                    consent_id: consent.id,
                    operation: "select",
                    account_id: account.id,
                  })
                }
              >
                {m.composio_use_account()}
              </Button>
            )}
        </fieldset>
      );
    });

  return (
    <PluginDetail
      plugin={{
        ...plugin,
        description: "",
        summary:
          toolkit === "gmail"
            ? m.composio_gmail_summary()
            : toolkit === "googledrive"
              ? m.composio_drive_summary()
              : m.composio_app_summary({ app: plugin.name }),
      }}
      onBack={onBack}
      backLabel={m.plugins_back()}
      installed
      headerActions={
        <Button
          hierarchy="secondary-gray"
          size="sm"
          aria-expanded={configuring}
          onPress={() => setConfiguring(!configuring)}
        >
          {m.composio_manage()}
        </Button>
      }
    >
      <section className="flex flex-col gap-lg px-md">
        {error && (
          <div role="alert" className="text-sm text-secondary">
            {m.composio_error()}
          </div>
        )}
        {!status && !error ? <PageLoading label={m.common_loading()} /> : null}
        {(status?.status !== "connected" || configuring) && (
          <div className="flex flex-wrap gap-md">
            <Button isDisabled={busy} onPress={() => void act("authorize")}>
              {m.composio_sign_in()}
            </Button>
            <Button
              hierarchy="secondary-gray"
              isDisabled={busy}
              onPress={() => setAdvanced(!advanced)}
            >
              {m.composio_project()}
            </Button>
          </div>
        )}
        {advanced && (status?.status !== "connected" || configuring) && (
          <form
            className="flex flex-col gap-md"
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = key;
              setKey("");
              void act("project", { api_key: submitted });
            }}
          >
            <InputField
              label={m.composio_key()}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div>
              <Button type="submit" isDisabled={busy || !key.trim()}>
                {m.composio_save()}
              </Button>
            </div>
          </form>
        )}
        {status && (configuring || status.status !== "connected") && (
          <output className="m-0 text-sm text-secondary">
            {status.status === "pending"
              ? m.composio_pending()
              : status.status === "connected"
                ? m.composio_connected()
                : m.composio_sign_in()}
            {" · "}
            {status.mode === "connect"
              ? m.composio_personal()
              : m.composio_project_scope()}
          </output>
        )}
        {(authorization || status?.status === "pending") && (
          <div className="flex flex-wrap gap-md">
            {authorization && (
              <Button
                hierarchy="secondary-gray"
                onPress={() => void openNativePlatformExternalUrl(authorization)}
              >
                {m.composio_reopen()}
              </Button>
            )}
            <Button
              hierarchy="secondary-gray"
              isDisabled={busy}
              onPress={() => void act("cancel")}
            >
              {m.composio_cancel()}
            </Button>
          </div>
        )}
        {consent?.status === "pending" && consent.toolkit === toolkit && (
          <div className="flex flex-col gap-md">
            <p className="m-0 text-sm text-secondary">{m.composio_consent_pending()}</p>
            <div className="flex flex-wrap gap-md">
              <Button
                hierarchy="secondary-gray"
                isDisabled={busy}
                onPress={() =>
                  void act("consent", {
                    toolkit,
                    consent_id: consent.id,
                    operation: "reopen",
                  })
                }
              >
                {m.composio_reopen()}
              </Button>
              <Button
                hierarchy="secondary-gray"
                isDisabled={busy}
                onPress={() =>
                  void act("consent", {
                    toolkit,
                    consent_id: consent.id,
                    operation: "cancel",
                  })
                }
              >
                {m.composio_cancel()}
              </Button>
            </div>
          </div>
        )}
        {consent?.status === "starting" && consent.toolkit === toolkit && (
          <div className="flex flex-col gap-md">
            <p className="m-0 text-sm text-secondary">
              {m.composio_consent_starting()}
            </p>
            <div>
              <Button
                hierarchy="secondary-gray"
                isDisabled={busy}
                onPress={() =>
                  void act("consent", {
                    toolkit,
                    consent_id: consent.id,
                    operation: "cancel",
                  })
                }
              >
                {m.composio_cancel()}
              </Button>
            </div>
          </div>
        )}
        {consent?.status === "selecting" && consent.toolkit === toolkit && (
          <p className="m-0 text-sm text-secondary">{m.composio_consent_selecting()}</p>
        )}
        {status?.status === "connected" && (
          <>
            {consent?.status === "expired" && (
              <p className="text-sm text-secondary">{m.composio_expired()}</p>
            )}
            {consent?.status === "pending" && candidates.length > 0 && (
              <div className="rounded-xl border border-secondary">
                {accountRows(candidates, true)}
              </div>
            )}
            <h2 className="m-0 text-sm font-medium">{m.composio_accounts()}</h2>
            <div className="rounded-xl border border-secondary bg-secondary">
              {connected.length === 0 && (
                <p className="m-0 px-xl py-lg text-sm text-secondary">
                  {m.composio_empty()}
                </p>
              )}
              {accountRows(connected)}
              <div className="px-xl py-lg">
                <Button
                  hierarchy="tertiary-gray"
                  size="sm"
                  isDisabled={busy || consentInProgress}
                  onPress={() => void act("connect", { toolkit })}
                >
                  {m.composio_connect_another()}
                </Button>
              </div>
            </div>
            {inactive.length > 0 && (
              <details
                className="text-sm"
                open={Boolean(consentInProgress) || inactiveOpen}
                onToggle={(event) => setInactiveOpen(event.currentTarget.open)}
              >
                <summary className="cursor-pointer text-secondary">
                  {m.composio_other_connections()}
                </summary>
                {(inactiveOpen || consentInProgress) &&
                  accountRows(
                    inactive.filter(
                      (account) =>
                        !candidates.some((candidate) => candidate.id === account.id)
                    )
                  )}
              </details>
            )}
            {status.mode === "connect" && (configuring || consentInProgress) && (
              <div>
                <Button
                  hierarchy="secondary-gray"
                  size="sm"
                  isDisabled={busy}
                  onPress={() => void act("refresh_accounts", { toolkit })}
                >
                  {m.composio_show_accounts()}
                </Button>
              </div>
            )}
            <ScrollAreaLoadMore
              hasMore={Boolean(status.next_cursor)}
              loading={busy}
              failed={error}
              onLoadMore={() => {
                if (status.next_cursor)
                  void act("accounts", { cursor: status.next_cursor });
              }}
            />
            {configuring && (
              <ComposioAccessPanel
                api={api}
                workspaceId={workspaceId}
                accounts={accounts}
              />
            )}
          </>
        )}
      </section>
      <Dialog
        isOpen={Boolean(details)}
        onOpenChange={(open) => {
          if (!open) setDetails(undefined);
        }}
        title={m.composio_account_details()}
      >
        <dl className="m-0 flex min-w-0 flex-col gap-md text-sm">
          <dt>{m.composio_account_reference()}</dt>
          <dd className="m-0 break-all select-text">{details?.id}</dd>
        </dl>
      </Dialog>
      <Dialog
        isOpen={Boolean(disconnect)}
        onOpenChange={(open) => {
          if (!open && !busy) setDisconnect(undefined);
        }}
        isDismissable={!busy}
        title={m.composio_disconnect()}
        description={m.composio_disconnect_confirmation({
          account: disconnect?.name ?? "",
        })}
        actions={[
          {
            label: m.plugins_personal_source_cancel(),
            hierarchy: "secondary-gray",
            disabled: busy,
            onPress: () => setDisconnect(undefined),
          },
          {
            label: m.composio_disconnect(),
            hierarchy: "destructive",
            disabled: busy,
            onPress: () => {
              if (disconnect)
                void act("account", {
                  account_id: disconnect.id,
                  operation: "disconnect",
                }).then(() => setDisconnect(undefined));
            },
          },
        ]}
      />
    </PluginDetail>
  );
}
