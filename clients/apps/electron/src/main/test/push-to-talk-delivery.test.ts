import { describe, expect, it, vi } from "vitest";
import type { ChatTarget, ChatWorkspaceResolution } from "@comma/chat-contract";
import { createPushToTalkDelivery } from "../push-to-talk/delivery";

const ready: ChatWorkspaceResolution = {
  conversationId: "cnv_home",
  groupId: "grp_1",
  status: "ready",
  workspaceId: "wsp_1",
};
const images = [
  { name: "screen.png", mediaType: "image/png" as const, data: Buffer.from("screen") },
  { name: "detail.jpg", mediaType: "image/jpeg" as const, data: Buffer.from("detail") },
];

function setup(
  options: {
    resolution?: ChatWorkspaceResolution;
    send?: () => Promise<void>;
  } = {}
) {
  const events: string[] = [];
  const chat = {
    resolveWorkspaceChat: vi.fn(async () => options.resolution ?? ready),
    sendDetachedMessage: vi.fn(
      async (
        _target: ChatTarget,
        _text: string,
        _attachments?: readonly { name: string; data: Blob }[]
      ) => {
        events.push("send");
        await options.send?.();
      }
    ),
  };
  const sideChat = {
    openWithoutFocus: vi.fn(() => void events.push("sideChat.openWithoutFocus")),
  };
  const runOwned = vi.fn();
  const delivery = createPushToTalkDelivery({
    chat,
    sideChat,
    runOwned: (handler) => {
      runOwned();
      return handler();
    },
  });
  return { chat, delivery, events, runOwned, sideChat };
}

describe("createPushToTalkDelivery", () => {
  it("sends to the workspace chat with the images, then opens Side Chat without focus", async () => {
    const { chat, delivery, events, runOwned } = setup();

    const target = await delivery.send({ text: "What is this?", attachments: images });

    expect(target).toEqual({
      conversationId: "cnv_home",
      groupId: "grp_1",
      workspaceId: "wsp_1",
    });
    expect(runOwned).toHaveBeenCalledOnce();
    const [sentTarget, text, attachments = []] =
      chat.sendDetachedMessage.mock.calls[0]!;
    expect(sentTarget).toEqual(target);
    expect(text).toBe("What is this?");
    expect(attachments.map(({ name, data }) => [name, data.type])).toEqual([
      ["screen.png", "image/png"],
      ["detail.jpg", "image/jpeg"],
    ]);
    expect(await attachments[0]?.data.text()).toBe("screen");
    expect(events).toEqual(["send", "sideChat.openWithoutFocus"]);
  });

  it("fails without sending while the workspace chat is not ready", async () => {
    const { chat, delivery, sideChat } = setup({
      resolution: {
        groupId: "grp_1",
        retryAfterSeconds: 3,
        status: "provisioning",
        workspaceId: "wsp_1",
      },
    });

    await expect(delivery.send({ text: "Hi", attachments: [] })).rejects.toThrow(
      /provisioning/
    );
    expect(chat.sendDetachedMessage).not.toHaveBeenCalled();
    expect(sideChat.openWithoutFocus).not.toHaveBeenCalled();
  });

  it("leaves Side Chat closed when the send fails", async () => {
    const { delivery, sideChat } = setup({
      send: () => Promise.reject(new Error("upload failed")),
    });

    await expect(delivery.send({ text: "Hi", attachments: images })).rejects.toThrow(
      "upload failed"
    );
    expect(sideChat.openWithoutFocus).not.toHaveBeenCalled();
  });
});
