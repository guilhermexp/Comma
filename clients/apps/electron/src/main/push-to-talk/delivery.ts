import type { ChatCoordinator } from "../modules/chat";
import type { ChatTarget } from "@comma/chat-contract";
import type { PushToTalkDelivery } from "./controller";

/**
 * Sends a turn to the active workspace's agent conversation, the one Side
 * Chat shows, without its draft (D6). No window opens: the reply comes back
 * on the cursor companion and the notch, and the conversation keeps it.
 */
export function createPushToTalkDelivery(options: {
  chat: Pick<ChatCoordinator, "resolveWorkspaceChat" | "sendDetachedMessage">;
  /** The current-session fence a Main-owned command takes. */
  runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
}): PushToTalkDelivery {
  const { chat, runOwned } = options;
  return {
    send: ({ text, attachments }) =>
      runOwned(async (): Promise<ChatTarget> => {
        const resolution = await chat.resolveWorkspaceChat();
        if (resolution.status !== "ready")
          throw new Error(`The workspace chat is ${resolution.status}.`);
        const { conversationId, groupId, workspaceId } = resolution;
        const sent = { conversationId, groupId, workspaceId };
        await chat.sendDetachedMessage(
          sent,
          text,
          attachments.map(({ data, mediaType, name }) => ({
            name,
            data: new Blob([new Uint8Array(data)], { type: mediaType }),
          }))
        );
        return sent;
      }),
  };
}
