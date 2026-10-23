import type { CommaConversation } from "@comma/app/api";
import type { ChatMessage, ChatTarget } from "@comma/chat-contract";
import { isRouterMessage } from "../modules/message-notifications";
import type { PushToTalkClock } from "./clock";

/** How long a sent turn waits for the agent before giving up silently. */
export const replyWaitMs = 180_000;

export interface PushToTalkReplies {
  /** Waits for the first agent reply in `target`, replacing any earlier wait. */
  arm(target: ChatTarget, onReply: (text: string) => void): void;
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
    | { target: ChatTarget; onReply: (text: string) => void; cancelTimer: () => void }
    | undefined;

  constructor(options: { clock: PushToTalkClock; timeoutMs?: number }) {
    this.#clock = options.clock;
    this.#timeoutMs = options.timeoutMs ?? replyWaitMs;
  }

  arm(target: ChatTarget, onReply: (text: string) => void) {
    this.cancel();
    const cancelTimer = this.#clock.setTimeout(() => {
      if (this.#waiting?.onReply === onReply) this.#waiting = undefined;
    }, this.#timeoutMs);
    this.#waiting = { target, onReply, cancelTimer };
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
    const reply = input.messages.find((message) =>
      isRouterMessage(message, input.conversation)
    );
    if (!reply) return;
    this.cancel();
    waiting.onReply(reply.text);
  }
}
