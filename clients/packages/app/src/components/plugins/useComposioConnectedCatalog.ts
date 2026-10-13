import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { composioAccountSchema, type CommaApiClient } from "../../api";
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
  workspaceId: string | undefined
) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [state, setState] = useState<{
    api: CommaApiClient;
    workspaceId: string;
    revision: number;
    items: ComposioCatalogItem[];
    loading: boolean;
    failed: boolean;
  }>();

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const scope = { api, workspaceId, revision };
    const items: ComposioCatalogItem[] = [];
    setState({ ...scope, items, loading: true, failed: false });
    void (async () => {
      try {
        const status = await api.getComposio(workspaceId, options);
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
            setState({ ...scope, items: [...items], loading: true, failed: false });
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
          setState({ ...scope, items: [...items], loading: false, failed: true });
      }
    })();
    return () => controller.abort();
  }, [api, workspaceId, revision]);

  const current =
    state !== undefined &&
    state.workspaceId === workspaceId &&
    state.api === api &&
    state.revision === revision;
  return {
    items: current ? state.items : [],
    loading: !!workspaceId && (!current || state.loading),
    failed: current && state.failed,
    refresh,
  };
}
