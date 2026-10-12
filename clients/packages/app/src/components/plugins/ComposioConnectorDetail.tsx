import { useCallback, useEffect, useRef, useState } from "react";
import { useCommaMessages } from "@comma/i18n/react";
import {
  Button,
  InputField,
  ScrollAreaLoadMore,
  PageLoading,
  Dialog,
  PluginDetail,
  type PluginDefinition,
} from "@comma/ui";
import type { CommaApiClient, ComposioStatus } from "../../api";
import { composioAccountSchema } from "../../api";
import { z } from "zod";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";

import { ComposioAccessPanel } from "./ComposioAccessPanel";

export function ComposioConnectorDetail({
  api,
  workspaceId,
  onBack,
  plugin,
  toolkit,
  startConnecting = false,
}: {
  api: CommaApiClient;
  workspaceId: string;
  onBack: () => void;
  plugin: PluginDefinition;
  toolkit: string;
  startConnecting?: boolean;
}) {
  const m = useCommaMessages();
  const [status, setStatus] = useState<ComposioStatus>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [key, setKey] = useState("");
  const [disconnect, setDisconnect] = useState<{ id: string; name: string }>();
  const [authorization, setAuthorization] = useState<string>();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const connectionStarted = useRef(false);
  const signInStarted = useRef(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const next = await api.getComposio(workspaceId, signal ? { signal } : {});
      if (mounted.current && !signal?.aborted) setStatus(next);
      return next;
    },
    [api, workspaceId]
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

  const act = async (
    action: string,
    params: Parameters<CommaApiClient["composioCommand"]>[2] = {}
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await api.composioCommand(workspaceId, action, params);
      if (!mounted.current) return;
      if (typeof result.authorization_url === "string") {
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
      await load();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!startConnecting || !status) return;
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

  return (
    <PluginDetail
      plugin={plugin}
      onBack={onBack}
      backLabel={m.plugins_back()}
      installLabel={m.composio_connect()}
      installPending={busy}
      {...(status?.status === "connected"
        ? { onInstall: () => void act("connect", { toolkit }) }
        : {})}
    >
      <section className="flex flex-col gap-lg px-md">
        <h2 className="m-0 text-sm font-medium">{m.composio_via()}</h2>
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
        {status && (
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
        {status?.status === "connected" && (
          <div>
            <Button
              hierarchy="tertiary-gray"
              size="sm"
              onPress={() => setConfiguring(!configuring)}
            >
              {m.composio_connection_settings()}
            </Button>
          </div>
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
        {status?.status === "connected" && (
          <>
            {status.mode === "connect" && (
              <div>
                <Button
                  hierarchy="secondary-gray"
                  isDisabled={busy}
                  onPress={() => void act("refresh_accounts", { toolkit })}
                >
                  {m.composio_show_accounts()}
                </Button>
              </div>
            )}
            <h2 className="m-0 text-lg font-medium">{m.composio_accounts()}</h2>
            {status.accounts.filter(
              (account) => account.toolkit === toolkit && account.mode === status.mode
            ).length === 0 && (
              <p className="m-0 text-sm text-secondary">{m.composio_empty()}</p>
            )}
            {status.accounts
              .filter(
                (account) => account.mode === status.mode && account.toolkit === toolkit
              )
              .map((account) => (
                <div
                  key={account.id}
                  className="flex flex-col gap-md border-b border-secondary pb-lg"
                >
                  <p className="m-0 text-sm">
                    {account.name} ·{" "}
                    {account.status === "ACTIVE"
                      ? m.composio_connected()
                      : account.status === "INITIATED"
                        ? m.composio_pending()
                        : m.composio_unavailable()}
                  </p>
                  <div className="flex flex-wrap gap-md">
                    {(account.status === "INITIATED"
                      ? ["verify", "reopen", "cancel"]
                      : [
                          "verify",
                          account.enabled ? "disable" : "enable",
                          "reconnect",
                          "disconnect",
                        ]
                    ).map((operation) => (
                      <Button
                        key={operation}
                        hierarchy="secondary-gray"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => {
                          if (operation === "disconnect") setDisconnect(account);
                          else
                            void act("account", { account_id: account.id, operation });
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
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            <ScrollAreaLoadMore
              hasMore={Boolean(status.next_cursor)}
              loading={busy}
              failed={error}
              onLoadMore={() => {
                if (status.next_cursor)
                  void act("accounts", { cursor: status.next_cursor });
              }}
            />
            {status.accounts.some(
              (account) =>
                account.toolkit === toolkit &&
                account.mode === status.mode &&
                account.status === "ACTIVE" &&
                account.enabled
            ) && (
              <ComposioAccessPanel
                api={api}
                workspaceId={workspaceId}
                accounts={status.accounts.filter(
                  (account) =>
                    account.mode === status.mode && account.toolkit === toolkit
                )}
              />
            )}
          </>
        )}
      </section>
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
