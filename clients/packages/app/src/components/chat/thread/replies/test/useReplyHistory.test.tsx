import { act, renderHook } from "@comma/test-utils/render";
import { describe, expect, it, vi } from "vitest";
import type { CommaApiClient, SalixMessage } from "../../../../../api";
import type { ChatMessage } from "../../../model/conversationChannel";
import { useReplyHistory } from "../useReplyHistory";

const wire = (message_id: string, text: string): SalixMessage => ({
  message_id,
  kind: "message",
  actor_type: "user",
  content: [{ type: "text", text }],
});

const chat = (
  messageId: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage => ({
  attachments: [],
  delivery: "sent",
  messageId,
  refs: [],
  role: "assistant",
  source: "server",
  text: messageId,
  ...overrides,
});

describe("reply history", () => {
  it("does not reveal messages from before a Router session reset", async () => {
    const api = {
      getMessageContext: vi.fn(async () => [wire("old", "before the reset")]),
    } as unknown as CommaApiClient;
    const render = (currentMessages: ChatMessage[]) =>
      renderHook(() =>
        useReplyHistory({
          api,
          conversationId: "cnv_1",
          conversationKind: "user_chat",
          currentMessages,
          groupId: "grp_1",
          historyScope: "scope",
        })
      );

    const ordinary = render([chat("current")]);
    await act(() => ordinary.result.current.loadReplyTarget("old"));
    expect(ordinary.result.current.messages.map((item) => item.messageId)).toEqual([
      "old",
      "current",
    ]);

    const reset = render([chat("reset", { sessionReset: {} }), chat("current")]);
    await act(() => reset.result.current.loadReplyTarget("old"));
    expect(reset.result.current.messages.map((item) => item.messageId)).toEqual([
      "reset",
      "current",
    ]);
  });
});
