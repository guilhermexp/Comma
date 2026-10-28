import { describe, expect, it, vi } from "vitest";
import type { ChatWorkspaceResolution } from "@comma/chat-contract";
import { createPushToTalkDelivery, type PushToTalkApi } from "../push-to-talk/delivery";
import type { PushToTalkReplyTarget } from "../push-to-talk/reply-watcher";

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

function setup(options: { resolution?: ChatWorkspaceResolution } = {}) {
  const events: string[] = [];
  const chat = {
    resolveWorkspaceChat: vi.fn(async () => options.resolution ?? ready),
  };
  const uploadGroupFile = vi.fn(
    async (_groupId: string, { name, data }: { name: string; data: Blob }) => {
      events.push(`upload:${name}`);
      return { path: `/files/${name}`, name, size: data.size };
    }
  );
  const api: PushToTalkApi = {
    uploadGroupFile,
    sendMessage: vi.fn(
      async (
        _groupId: string,
        _conversationId: string,
        attrs: { text: string; clientRequestId?: string }
      ) => {
        events.push("send");
        return {
          messages: [
            {
              message_id: "msg_ptt_authoritative",
              client_request_id: attrs.clientRequestId,
            },
          ],
        };
      }
    ) as unknown as PushToTalkApi["sendMessage"],
  };
  const runOwned = vi.fn();
  const delivery = createPushToTalkDelivery({
    chat,
    api: () => api,
    runOwned: (handler) => {
      runOwned();
      return handler();
    },
    requestId: () => "req_fixed_id",
  });
  return { chat, api, delivery, events, runOwned, uploadGroupFile };
}

describe("createPushToTalkDelivery", () => {
  it("sends to the workspace chat with the images via CommaApi", async () => {
    const { api, delivery, events, runOwned, uploadGroupFile } = setup();

    const target = await delivery.send({ text: "What is this?", attachments: images });

    expect(target).toEqual({
      conversationId: "cnv_home",
      groupId: "grp_1",
      workspaceId: "wsp_1",
      clientRequestId: "req_fixed_id",
      messageId: "msg_ptt_authoritative",
    });
    expect(runOwned).toHaveBeenCalledOnce();
    expect(api.uploadGroupFile).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenCalledWith(
      "grp_1",
      "cnv_home",
      expect.objectContaining({
        clientRequestId: "req_fixed_id",
        text: "What is this?\n\nAttached files in your workspace:\n- screen.png (workspace file: /files/screen.png)\n- detail.jpg (workspace file: /files/detail.jpg)",
      })
    );
    expect(events).toEqual(["upload:screen.png", "upload:detail.jpg", "send"]);
    expect(
      uploadGroupFile.mock.calls.map(([, file]) => [file.name, file.data.type])
    ).toEqual([
      ["screen.png", "image/png"],
      ["detail.jpg", "image/jpeg"],
    ]);
    expect(await uploadGroupFile.mock.calls[0]![1].data.text()).toBe("screen");
  });

  it("invokes onSending callback with clientRequestId before the send request", async () => {
    const { delivery, events } = setup();
    let sendingTarget: PushToTalkReplyTarget | undefined;

    await delivery.send({
      text: "Hello",
      attachments: [images[0]!],
      onSending: (target) => {
        events.push("onSending");
        sendingTarget = target;
      },
    });

    expect(events).toEqual(["upload:screen.png", "onSending", "send"]);
    expect(sendingTarget).toEqual({
      conversationId: "cnv_home",
      groupId: "grp_1",
      workspaceId: "wsp_1",
      clientRequestId: "req_fixed_id",
    });
  });

  it("does not send the question if a screenshot upload fails", async () => {
    const { api, delivery, uploadGroupFile } = setup();
    uploadGroupFile.mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      delivery.send({ text: "Private question", attachments: images })
    ).rejects.toThrow("upload failed");
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("fails without sending while the workspace chat is not ready", async () => {
    const { api, delivery } = setup({
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
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
