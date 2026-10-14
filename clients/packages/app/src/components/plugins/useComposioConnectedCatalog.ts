import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  composioAccountSchema,
  composioStatusSchema,
  type CommaApiClient,
} from "../../api";
import {
  composioCatalogPageSchema,
  type ComposioCatalogItem,
} from "./useComposioCatalog";

const accountsPageSchema = z.object({
  items: z.array(composioAccountSchema),
  next_cursor: z.string().nullable(),
});

export function useComposioConnectedCatalog(
  api: CommaApiClient,
  workspaceId: string | undefined,
  catalog: { toolkits: string[]; ready: boolean } = { toolkits: [], ready: true }
) {
  const toolkitKey = JSON.stringify([...new Set(catalog.toolkits)].toSorted());
  const ready = catalog.ready;
  const discovery = useRef<
    | {
        api: CommaApiClient;
        workspaceId: string;
        toolkits: Set<string>;
      }
    | undefined
  >(undefined);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    // An explicit retry/return from detail may observe newly authorized accounts.
    discovery.current = undefined;
    setRevision((value) => value + 1);
  }, []);
  const [state, setState] = useState<{
    api: CommaApiClient;
    workspaceId: string;
    revision: number;
    items: ComposioCatalogItem[];
    loading: boolean;
    failed: boolean;
  }>();

  useEffect(() => {
    if (!workspaceId || !ready) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const scope = { api, workspaceId, revision };
    const items: ComposioCatalogItem[] = [];
    const retainItems = (current: typeof state) =>
      current?.api === api && current.workspaceId === workspaceId ? current.items : [];
    const mergeItems = (current: typeof state) => [
      ...new Map(
        [...retainItems(current), ...items].map((item) => [item.slug, item])
      ).values(),
    ];
    setState((current) => ({
      ...scope,
      items: retainItems(current),
      loading: true,
      failed: false,
    }));
    void (async () => {
      try {
        let status = await api.getComposio(workspaceId, options);
        if (controller.signal.aborted) return;
        if (status.mode === "connect" && status.status === "connected") {
          const previous = discovery.current;
          const known =
            previous?.api === api && previous.workspaceId === workspaceId
              ? previous
              : undefined;
          const added = (JSON.parse(toolkitKey) as string[]).filter(
            (toolkit) => !known?.toolkits.has(toolkit)
          );
          if (!known || added.length > 0) {
            const next = known ?? { api, workspaceId, toolkits: new Set<string>() };
            try {
              status = composioStatusSchema.parse(
                await api.composioCommand(
                  workspaceId,
                  "reconcile_accounts",
                  { toolkits: added },
                  options
                )
              );
            } finally {
              // Settled results/errors consume the trigger; aborted reads can retry.
              if (!controller.signal.aborted) {
                added.forEach((toolkit) => next.toolkits.add(toolkit));
                discovery.current = next;
              }
            }
          }
        }
        let page = { items: status.accounts, next_cursor: status.next_cursor };
        const seen = new Set<string>();
        const cursors = new Set<string>();
        while (!controller.signal.aborted) {
          const toolkits = [
            ...new Set(
              page.items
                .filter(
                  (account) =>
                    account.enabled &&
                    account.status === "ACTIVE" &&
                    account.mode === status.mode
                )
                .map((account) => account.toolkit)
            ),
          ].filter((toolkit) => !seen.has(toolkit));
          // Local account pages contain at most 50 records. Metadata requests
          // contain at most 20 toolkits and run serially; no catalog-page crawl.
          for (let offset = 0; offset < toolkits.length; offset += 20) {
            if (controller.signal.aborted) return;
            const batch = toolkits.slice(offset, offset + 20);
            const metadata = composioCatalogPageSchema.parse(
              await api.composioCommand(
                workspaceId,
                "catalog",
                { toolkits: batch },
                options
              )
            );
            if (controller.signal.aborted) return;
            const bySlug = new Map(metadata.items.map((item) => [item.slug, item]));
            for (const toolkit of batch) {
              const item = bySlug.get(toolkit);
              if (!item) throw new Error("Connected toolkit metadata unavailable");
              seen.add(toolkit);
              items.push(item);
            }
            setState((current) => ({
              ...scope,
              items: mergeItems(current),
              loading: true,
              failed: false,
            }));
          }
          if (!page.next_cursor) break;
          if (cursors.has(page.next_cursor)) throw new Error("Repeated account cursor");
          cursors.add(page.next_cursor);
          page = accountsPageSchema.parse(
            await api.composioCommand(
              workspaceId,
              "accounts",
              { cursor: page.next_cursor },
              options
            )
          );
        }
        if (!controller.signal.aborted)
          setState({ ...scope, items: [...items], loading: false, failed: false });
      } catch {
        if (!controller.signal.aborted)
          setState((current) => ({
            ...scope,
            items: mergeItems(current),
            loading: false,
            failed: true,
          }));
      }
    })();
    return () => controller.abort();
  }, [api, workspaceId, revision, ready, toolkitKey]);

  const current =
    state !== undefined && state.workspaceId === workspaceId && state.api === api;
  return {
    items: current ? state.items : [],
    loading:
      !!workspaceId && (!current || state.loading || state.revision !== revision),
    failed: current && state.failed,
    refresh,
  };
}
