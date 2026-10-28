import { randomUUID } from "node:crypto";
import type { ChatCoordinator } from "../modules/chat";
import type { ChatTarget } from "@comma/chat-contract";
import type { CommaApiClient } from "@comma/app/api";
import { composeMessageWithAttachments } from "../../../../../packages/app/src/components/chat/model/protocol";
import type { PushToTalkDelivery } from "./controller";

export type PushToTalkSentTarget = ChatTarget & {
  clientRequestId: string;
  messageId?: string;
};

export type PushToTalkApi = Pick<CommaApiClient, "uploadGroupFile" | "sendMessage">;

/**
 * Sends a turn to the active workspace's agent conversation, the one Side
 * Chat shows, without its draft (D6). No window opens: the reply comes back
 * on the cursor companion and the notch, and the conversation keeps it.
 */
export function createPushToTalkDelivery(options: {
  chat: Pick<ChatCoordinator, "resolveWorkspaceChat">;
  api: () => Promise<PushToTalkApi> | PushToTalkApi;
  /** The current-session fence a Main-owned command takes. */
  runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
  requestId?: () => string;
}): PushToTalkDelivery {
  const { chat, runOwned, api, requestId = randomUUID } = options;

  return {
    send: ({ text, attachments, onSending }) =>
      runOwned(async (): Promise<PushToTalkSentTarget> => {
        const resolution = await chat.resolveWorkspaceChat();
        if (resolution.status !== "ready")
          throw new Error(`The workspace chat is ${resolution.status}.`);
        const { conversationId, groupId, workspaceId } = resolution;
        const sent = { conversationId, groupId, workspaceId };
        const clientRequestId = requestId();
        const sentTarget: PushToTalkSentTarget = {
          ...sent,
          clientRequestId,
        };

        const currentApi = await api();
        const uploaded = [];
        for (const { data, mediaType, name } of attachments) {
          uploaded.push(
            await currentApi.uploadGroupFile(groupId, {
              data: new Blob([new Uint8Array(data)], { type: mediaType }),
              name,
            })
          );
        }
        const composedText = composeMessageWithAttachments(text, uploaded);
        onSending?.(sentTarget);
        const conversation = await currentApi.sendMessage(groupId, conversationId, {
          text: composedText,
          clientRequestId,
        });
        const sentMessage = conversation.messages?.find(
          (m) => m.client_request_id === clientRequestId
        );
        return {
          ...sentTarget,
          ...(sentMessage?.message_id ? { messageId: sentMessage.message_id } : {}),
        };
      }),
  };
}
