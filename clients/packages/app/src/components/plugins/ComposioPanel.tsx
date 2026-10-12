import { useCallback, useEffect, useRef, useState } from "react";
import { useCommaMessages } from "@comma/i18n/react";
import {
  Button,
  InputField,
  ScrollArea,
  ScrollAreaLoadMore,
  PageLoading,
  Dialog,
} from "@comma/ui";
import type { CommaApiClient, ComposioStatus } from "../../api";
import { composioAccountSchema } from "../../api";
import { z } from "zod";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";

import { ComposioAccessPanel } from "./ComposioAccessPanel";

type CatalogItem = {
  slug: string;
  name: string;
  description?: string;
  has_active_connection?: boolean;
};

export function ComposioPanel({
  api,
  workspaceId,
  onBack,
}: {
  api: CommaApiClient;
  workspaceId: string;
  onBack: () => void;
}) {
  const m = useCommaMessages();
  const [status, setStatus] = useState<ComposioStatus>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [key, setKey] = useState("");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[]>();
  const [cursor, setCursor] = useState<string>();
  const [disconnect, setDisconnect] = useState<{ id: string; name: string }>();
  const [authorization, setAuthorization] = useState<string>();
  const mounted = useRef(true);
  const inFlight = useRef(false);
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
      if (action === "search") {
        if (result.kind === "catalog" && Array.isArray(result.items)) {
          const items = result.items.filter(
            (item): item is CatalogItem =>
              typeof item === "object" &&
              item !== null &&
              typeof item.slug === "string" &&
              typeof item.name === "string"
          );
          setCatalog(params?.cursor ? [...(catalog ?? []), ...items] : items);
          setCursor(
            typeof result.next_cursor === "string" ? result.next_cursor : undefined
          );
        }
      }
      await load();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <ScrollArea
      className="size-full min-h-0 min-w-0"
      contentClassName="min-h-full"
      edgeEffect="none"
    >
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-xl px-3xl py-3xl">
        <div>
          <Button hierarchy="tertiary-gray" onPress={onBack} size="sm">
            {m.plugins_back()}
          </Button>
        </div>
        <h1 className="m-0 text-xl font-medium text-primary">{m.composio_title()}</h1>
        <p className="m-0 text-sm text-secondary">{m.composio_intro()}</p>
        {error && (
          <div role="alert" className="text-sm text-secondary">
            {m.composio_error()}
          </div>
        )}
        {!status && !error ? <PageLoading label={m.common_loading()} /> : null}
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
        {advanced && (
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
              <p className="m-0 text-sm text-secondary">{m.composio_capabilities()}</p>
            )}
            <form
              className="flex items-end gap-md"
              onSubmit={(e) => {
                e.preventDefault();
                void act("search", { query });
              }}
            >
              <InputField
                className="flex-1"
                label={m.composio_search()}
                value={query}
                maxLength={500}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button type="submit" isDisabled={busy || !query.trim()}>
                {m.composio_search_action()}
              </Button>
            </form>
            {catalog?.length === 0 && <p>{m.composio_no_results()}</p>}
            {catalog?.map((item) => (
              <div
                key={item.slug}
                className="flex items-center justify-between gap-lg border-b border-secondary pb-lg"
              >
                <div>
                  <h2 className="m-0 text-sm font-medium">{item.name}</h2>
                  <p className="m-0 text-sm text-secondary">{item.description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-md">
                  {status.mode === "connect" && item.has_active_connection && (
                    <Button
                      hierarchy="secondary-gray"
                      size="sm"
                      isDisabled={busy}
                      onPress={() =>
                        void act("refresh_accounts", { toolkit: item.slug })
                      }
                    >
                      {m.composio_show_accounts()}
                    </Button>
                  )}
                  <Button
                    hierarchy="secondary-gray"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => void act("connect", { toolkit: item.slug })}
                  >
                    {m.composio_connect()}
                  </Button>
                </div>
              </div>
            ))}
            <ScrollAreaLoadMore
              hasMore={Boolean(cursor)}
              loading={busy}
              failed={error}
              onLoadMore={() => {
                if (cursor) void act("search", { query, cursor });
              }}
            />
            <h2 className="m-0 text-lg font-medium">{m.composio_accounts()}</h2>
            {status.accounts.length === 0 && (
              <p className="m-0 text-sm text-secondary">{m.composio_empty()}</p>
            )}
            {status.accounts
              .filter((account) => account.mode === status.mode)
              .map((account) => (
                <div
                  key={account.id}
                  className="flex flex-col gap-md border-b border-secondary pb-lg"
                >
                  <p className="m-0 text-sm">
                    {account.name} · {account.id} · {account.status}
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
            <ComposioAccessPanel
              api={api}
              workspaceId={workspaceId}
              accounts={status.accounts.filter(
                (account) => account.mode === status.mode
              )}
            />
          </>
        )}
      </div>
      <Dialog
        isOpen={Boolean(disconnect)}
        onOpenChange={(open) => {
          if (!open && !busy) setDisconnect(undefined);
        }}
        isDismissable={!busy}
        title={m.composio_disconnect()}
        description={m.composio_disconnect_confirmation({
          account: `${disconnect?.name ?? ""} · ${disconnect?.id ?? ""}`,
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
    </ScrollArea>
  );
}
