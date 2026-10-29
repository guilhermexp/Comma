import { useState } from "react";
import { fireEvent, render, screen } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { describe, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../../../api";
import type { ConversationFileSource } from "../../../../../runtime-files/fileSources";
import { FilePreviewPanel } from "../../../../chat-sidebar/FilePreviewPanel";
import { normalizeServerMessages } from "../../../model/conversationChannel";
import { ThreadFileSourceContext } from "../../threadContexts";
import { MessageAttachments } from "../MessageAttachments";

const registry = vi.hoisted(() => ({
  beginAttempt: () => ({
    signal: new AbortController().signal,
    isCurrent: () => true,
    release: () => {},
  }),
}));
vi.mock("../../../ChatProvider", () => ({
  useOptionalChatRegistry: () => undefined,
  useChatRegistry: () => registry,
}));

const title = "Comparação dos dois turnos — 231 seções";
const api = {
  fetchConversationAttachment: async () =>
    new Blob(["shift,count\nfirst,231"], { type: "application/octet-stream" }),
} as unknown as CommaApiClient;
const [message] = normalizeServerMessages(
  [
    {
      actor_type: "agent",
      agent_id: "agt1_worker",
      message_id: "msg_file",
      kind: "message",
      content: [
        {
          type: "file",
          title,
          path: "/artifacts/x.csv",
          blob_ref: { uuid: "u", hash: "h", size: 21 },
        },
      ],
    },
  ],
  [],
  "user_chat"
);

function Harness() {
  const [source, setSource] = useState<ConversationFileSource>();
  return (
    <>
      <ThreadFileSourceContext.Provider
        value={{ api, groupId: "group", conversationId: "home", open: setSource }}
      >
        <MessageAttachments attachments={message!.attachments!} messageId="msg_file" />
      </ThreadFileSourceContext.Provider>
      {source && (
        <FilePreviewPanel
          api={api}
          source={source}
          panelId="preview"
          onOpenBrowser={() => {}}
        />
      )}
    </>
  );
}

describe("agent file cards", () => {
  it("preserves the human title, shows CSV, and opens the path-named document", async () => {
    installNativeBridgeMock({ platform: "web", os: "macos" });
    render(<Harness />);
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText("CSV")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Preview ${title}` }));
    expect(
      await screen.findByText("shift,count\nfirst,231", { exact: false })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "x.csv" })).toBeVisible();
  });
});
