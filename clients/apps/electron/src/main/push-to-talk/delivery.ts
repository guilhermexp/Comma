import type { ChatCoordinator } from "../modules/chat";
import type { ChatTarget } from "@comma/chat-contract";
import type { PushToTalkDelivery } from "./controller";

/**
 * Sends a turn to the active workspace's agent conversation, the one Side
 * Chat shows, without its draft (D6). After the send Side Chat opens without
 * taking the keyboard from the app in use.
 */
export function createPushToTalkDelivery(options: {
  chat: Pick<ChatCoordinator, "resolveWorkspaceChat" | "sendDetachedMessage">;
  sideChat: { openWithoutFocus(): unknown };
  /** The current-session fence a Main-owned command takes. */
  runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
}): PushToTalkDelivery {
  const { chat, runOwned, sideChat } = options;
  return {
    send: async ({ text, attachments }) => {
      const target = await runOwned(async (): Promise<ChatTarget> => {
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
      });
      sideChat.openWithoutFocus();
      return target;
    },
  };
}
