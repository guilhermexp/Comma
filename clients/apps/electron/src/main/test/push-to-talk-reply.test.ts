import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CommaConversation } from "@comma/app/api";
import type { ChatMessage } from "@comma/chat-contract";
import { PushToTalkReplyWatcher, replyWaitMs } from "../push-to-talk/reply-watcher";
import { SaySpeaker, type SpeakerProcess } from "../push-to-talk/speaker";
import { FakeClock } from "./support/fake-clock";

class FakeSay extends EventEmitter implements SpeakerProcess {
  input: string | undefined;
  killed = false;
  stdin = { end: (text: string) => void (this.input = text) };
  kill() {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
}

describe("SaySpeaker", () => {
  it("speaks through /usr/bin/say on stdin and stops the running voice", () => {
    const processes: FakeSay[] = [];
    const spawn = vi.fn((_command: string, _args: string[]) => {
      const child = new FakeSay();
      processes.push(child);
      return child;
    });
    const speaker = new SaySpeaker({ spawn });

    void speaker.speak("first answer");
    expect(spawn).toHaveBeenCalledWith("/usr/bin/say", []);
    expect(processes[0]?.input).toBe("first answer");
    expect(speaker.speaking()).toBe(true);

    void speaker.speak("second answer");
    expect(processes[0]?.killed).toBe(true);
    expect(processes[1]?.input).toBe("second answer");

    speaker.stop();
    expect(processes[1]?.killed).toBe(true);
    expect(speaker.speaking()).toBe(false);
  });

  it("forgets a voice that finished on its own", () => {
    const child = new FakeSay();
    const speaker = new SaySpeaker({ spawn: () => child });
    void speaker.speak("done");
    child.emit("exit", 0);
    expect(speaker.speaking()).toBe(false);
    speaker.stop();
    expect(child.killed).toBe(false);
  });

  // Leitura da resposta: the controller waits for each sentence to end.
  it("resolves each sentence when its voice ends, is stopped or fails", async () => {
    const processes: FakeSay[] = [];
    const speaker = new SaySpeaker({
      spawn: () => {
        const child = new FakeSay();
        processes.push(child);
        return child;
      },
    });
    const ended = vi.fn();
    void speaker.speak("first").then(ended);
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    processes[0]?.emit("exit", 0);
    await Promise.resolve();
    expect(ended).toHaveBeenCalledOnce();

    const stopped = speaker.speak("second");
    speaker.stop();
    await expect(stopped).resolves.toBeUndefined();

    const failed = speaker.speak("third");
    processes[2]?.emit("error", new Error("spawn failed"));
    await expect(failed).resolves.toBeUndefined();
  });
});

const target = { conversationId: "cnv_home", groupId: "grp_1", workspaceId: "wsp_1" };
const conversation = {
  id: "cnv_home",
  kind: "user_chat",
  messages: [],
  status: "active",
  title: "Home",
  group_id: "grp_1",
} as CommaConversation;

function message(role: string, text: string, extra: Partial<ChatMessage> = {}) {
  return {
    attachments: [],
    delivery: "sent",
    messageId: `msg_${Math.random()}`,
    refs: [],
    role,
    source: "server",
    text,
    ...extra,
  } as unknown as ChatMessage;
}

function appended(messages: ChatMessage[], to = target) {
  return {
    conversation: { ...conversation, id: to.conversationId },
    messages,
    target: to,
  };
}

describe("PushToTalkReplyWatcher", () => {
  it("reads only the first agent reply in the turn's conversation", () => {
    const clock = new FakeClock();
    const watcher = new PushToTalkReplyWatcher({ clock });
    const onReply = vi.fn();
    const user = message("user", "my question", {
      messageId: "msg_q1",
      clientRequestId: "req_turn_1",
    });
    watcher.arm(
      { ...target, clientRequestId: "req_turn_1" },
      { onReply, onTimeout: vi.fn() }
    );

    watcher.handleAppended(appended([user]));
    watcher.handleAppended(
      appended([message("assistant", "other chat", { replyToMessageId: "msg_q1" })], {
        ...target,
        conversationId: "cnv_x",
      })
    );
    watcher.handleAppended(
      appended([
        message("assistant", "from Telegram", {
          platformSource: "telegram",
          replyToMessageId: "msg_q1",
        }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    watcher.handleAppended(
      appended([
        message("assistant", "The answer", { replyToMessageId: "msg_q1" }),
        message("assistant", "More", { replyToMessageId: "msg_q1" }),
      ])
    );
    watcher.handleAppended(
      appended([message("assistant", "Later reply", { replyToMessageId: "msg_q1" })])
    );
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("The answer");
    expect(clock.pending()).toBe(0);
  });

  // Mensagem digitada: ignores replies to typed messages before/during wait (F4)
  it("does not read replies to typed messages sent before the turn in the same conversation", () => {
    const watcher = new PushToTalkReplyWatcher({ clock: new FakeClock() });
    const onReply = vi.fn();
    watcher.arm(
      { ...target, clientRequestId: "req_ptt_turn_1" },
      { onReply, onTimeout: vi.fn() }
    );

    // An earlier typed question's reply arrives first
    watcher.handleAppended(
      appended([
        message("assistant", "Reply to typing", {
          replyToMessageId: "msg_typed_earlier",
        }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    // PTT user message and its matching reply arrive
    watcher.handleAppended(
      appended([
        message("user", "ptt question", {
          messageId: "msg_ptt_1",
          clientRequestId: "req_ptt_turn_1",
        }),
        message("assistant", "PTT answer", { replyToMessageId: "msg_ptt_1" }),
      ])
    );
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("PTT answer");
  });

  it("does not read replies to typed messages sent during the wait in the same conversation", () => {
    const watcher = new PushToTalkReplyWatcher({ clock: new FakeClock() });
    const onReply = vi.fn();
    watcher.arm(
      { ...target, clientRequestId: "req_ptt_turn_2" },
      { onReply, onTimeout: vi.fn() }
    );

    // PTT user message arrives
    watcher.handleAppended(
      appended([
        message("user", "ptt question", {
          messageId: "msg_ptt_2",
          clientRequestId: "req_ptt_turn_2",
        }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    // User types in sidebar during wait, and that typed message's reply arrives first
    watcher.handleAppended(
      appended([
        message("user", "typed during wait", {
          messageId: "msg_typed_during",
          clientRequestId: "req_typed_during",
        }),
      ])
    );
    watcher.handleAppended(
      appended([
        message("assistant", "Reply to typing during wait", {
          replyToMessageId: "msg_typed_during",
        }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    // Effective PTT reply arrives
    watcher.handleAppended(
      appended([
        message("assistant", "Real PTT reply", { replyToMessageId: "msg_ptt_2" }),
      ])
    );
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("Real PTT reply");
  });

  it("correlates reply by clientRequestId and ignores concurrent typed message with identical text", () => {
    const watcher = new PushToTalkReplyWatcher({ clock: new FakeClock() });
    const onReply = vi.fn();
    watcher.arm(
      { ...target, clientRequestId: "req_ptt_turn_3" },
      { onReply, onTimeout: vi.fn() }
    );

    // User also typed "help me" in the sidebar with a different clientRequestId
    watcher.handleAppended(
      appended([
        message("user", "help me", {
          messageId: "msg_typed_concurrent",
          clientRequestId: "req_typed_sidebar",
        }),
      ])
    );
    // Typed message's reply arrives first
    watcher.handleAppended(
      appended([
        message("assistant", "Typed help answer", {
          replyToMessageId: "msg_typed_concurrent",
        }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    // PTT user message arrives with matching clientRequestId
    watcher.handleAppended(
      appended([
        message("user", "help me", {
          messageId: "msg_ptt_turn_3",
          clientRequestId: "req_ptt_turn_3",
        }),
      ])
    );
    // Real PTT reply arrives
    watcher.handleAppended(
      appended([
        message("assistant", "PTT help answer", {
          replyToMessageId: "msg_ptt_turn_3",
        }),
      ])
    );
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("PTT help answer");
  });

  it("correlates reply by messageId when provided at arm time", () => {
    const watcher = new PushToTalkReplyWatcher({ clock: new FakeClock() });
    const onReply = vi.fn();
    watcher.arm(
      { ...target, messageId: "msg_ptt_direct" },
      { onReply, onTimeout: vi.fn() }
    );

    watcher.handleAppended(
      appended([
        message("assistant", "Unrelated reply", { replyToMessageId: "msg_other" }),
      ])
    );
    expect(onReply).not.toHaveBeenCalled();

    watcher.handleAppended(
      appended([
        message("assistant", "Direct PTT reply", {
          replyToMessageId: "msg_ptt_direct",
        }),
      ])
    );
    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("Direct PTT reply");
  });

  // Agente demora
  it("gives up after 180 s, says so once and ignores a later reply", () => {
    const clock = new FakeClock();
    const watcher = new PushToTalkReplyWatcher({ clock });
    const onReply = vi.fn();
    const onTimeout = vi.fn();
    watcher.arm({ ...target, messageId: "msg_timeout" }, { onReply, onTimeout });
    clock.advance(replyWaitMs - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    clock.advance(1);
    expect(replyWaitMs).toBe(180_000);
    expect(onTimeout).toHaveBeenCalledOnce();
    watcher.handleAppended(
      appended([message("assistant", "Too late", { replyToMessageId: "msg_timeout" })])
    );
    expect(onReply).not.toHaveBeenCalled();
  });

  it("stops waiting when cancelled or re-armed for a newer turn", () => {
    const watcher = new PushToTalkReplyWatcher({ clock: new FakeClock() });
    const first = vi.fn();
    const second = vi.fn();
    const firstTimeout = vi.fn();
    watcher.arm(
      { ...target, messageId: "msg_turn_1" },
      { onReply: first, onTimeout: firstTimeout }
    );
    watcher.arm(
      { ...target, messageId: "msg_turn_2" },
      { onReply: second, onTimeout: vi.fn() }
    );
    watcher.handleAppended(
      appended([message("assistant", "Answer", { replyToMessageId: "msg_turn_2" })])
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("Answer");
    expect(firstTimeout).not.toHaveBeenCalled();

    const third = vi.fn();
    watcher.arm(
      { ...target, messageId: "msg_turn_3" },
      { onReply: third, onTimeout: vi.fn() }
    );
    watcher.cancel();
    watcher.handleAppended(
      appended([message("assistant", "Answer", { replyToMessageId: "msg_turn_3" })])
    );
    expect(third).not.toHaveBeenCalled();
  });
});
