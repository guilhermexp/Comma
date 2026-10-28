import type { CommaConversation } from "@comma/app/api";
import type { ChatMessage, ChatTarget } from "@comma/chat-contract";
import { isRouterMessage } from "../modules/message-notifications";
import type { PushToTalkClock } from "./clock";

/** How long a sent turn waits for the agent before giving up silently. */
export const replyWaitMs = 180_000;

export type PushToTalkReplyHandlers = {
  onReply: (text: string) => void;
  /** No reply came within the wait; a later one is ignored. */
  onTimeout: () => void;
};

export type PushToTalkReplyTarget = ChatTarget & {
  /** The client request ID minted for the sent turn. */
  clientRequestId?: string;
  /** The canonical message ID of the push-to-talk user message, if already known. */
  messageId?: string;
};

export interface PushToTalkReplies {
  /** Waits for the agent reply in `target` tied to the sent turn, replacing any earlier wait. */
  arm(target: PushToTalkReplyTarget, handlers: PushToTalkReplyHandlers): void;
  cancel(): void;
}

/**
 * Finds the agent's reply to a push-to-talk turn (D7). It is fed by the chat
 * coordinator's `onCanonicalMessagesAppended`, which reports only messages
 * the server confirmed. Only the conversation of the last sent turn counts,
 * only its first agent reply is read, and replies to typed messages are
 * never armed.
 */
export class PushToTalkReplyWatcher implements PushToTalkReplies {
  readonly #clock: PushToTalkClock;
  readonly #timeoutMs: number;
  #waiting:
    | {
        target: PushToTalkReplyTarget;
        handlers: PushToTalkReplyHandlers;
        cancelTimer: () => void;
        boundMessageId: string | undefined;
      }
    | undefined;

  constructor(options: { clock: PushToTalkClock; timeoutMs?: number }) {
    this.#clock = options.clock;
    this.#timeoutMs = options.timeoutMs ?? replyWaitMs;
  }

  arm(target: PushToTalkReplyTarget, handlers: PushToTalkReplyHandlers) {
    this.cancel();
    const cancelTimer = this.#clock.setTimeout(() => {
      if (this.#waiting?.handlers !== handlers) return;
      this.#waiting = undefined;
      handlers.onTimeout();
    }, this.#timeoutMs);
    this.#waiting = {
      target,
      handlers,
      cancelTimer,
      boundMessageId: target.messageId,
    };
  }

  cancel() {
    this.#waiting?.cancelTimer();
    this.#waiting = undefined;
  }

  handleAppended(input: {
    conversation: CommaConversation;
    messages: readonly ChatMessage[];
    target: ChatTarget;
  }) {
    const waiting = this.#waiting;
    if (!waiting) return;
    if (
      input.target.conversationId !== waiting.target.conversationId ||
      input.target.groupId !== waiting.target.groupId
    )
      return;

    // 1. If boundMessageId is not yet known, bind it from our user message via clientRequestId
    if (
      waiting.boundMessageId === undefined &&
      waiting.target.clientRequestId !== undefined
    ) {
      const userMessage = input.messages.find(
        (m) => m.role === "user" && m.clientRequestId === waiting.target.clientRequestId
      );
      if (userMessage) {
        waiting.boundMessageId = userMessage.messageId;
      }
    }

    // 2. Correlate agent reply strictly by replyToMessageId === boundMessageId
    if (waiting.boundMessageId === undefined) return;

    const reply = input.messages.find(
      (message) =>
        isRouterMessage(message, input.conversation) &&
        message.replyToMessageId === waiting.boundMessageId
    );
    if (!reply) return;
    this.cancel();
    waiting.handlers.onReply(reply.text);
  }
}
