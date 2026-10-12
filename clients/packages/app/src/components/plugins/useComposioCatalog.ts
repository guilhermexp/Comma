import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CommaApiClient } from "../../api";

const pageSchema = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      logo: z.string(),
    })
  ),
  next_cursor: z.string().nullable(),
});
export type ComposioCatalogItem = z.infer<typeof pageSchema>["items"][number];

export function useComposioCatalog(
  api: CommaApiClient,
  workspaceId: string | undefined,
  query: string
) {
  const [items, setItems] = useState<ComposioCatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const load = useCallback(
    async (next?: string) => {
      if (!workspaceId) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setFailed(false);
      try {
        const page = pageSchema.parse(
          await api.composioCommand(
            workspaceId,
            "catalog",
            {
              query,
              ...(next ? { cursor: next } : {}),
            },
            { signal: controller.signal }
          )
        );
        if (controller.signal.aborted) return;
        setItems((current) => (next ? [...current, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [api, workspaceId, query]
  );
  useEffect(() => {
    request.current?.abort();
    setItems([]);
    setCursor(null);
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [load, query]);
  return { items, cursor, loading, failed, load };
}
