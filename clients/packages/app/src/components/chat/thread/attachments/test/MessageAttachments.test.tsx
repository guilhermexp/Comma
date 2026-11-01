import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@comma/test-utils/render";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { describe, expect, it, vi } from "vitest";
import type { CommaApiClient } from "../../../../../api";
import type { ConversationFileSource } from "../../../../../runtime-files/fileSources";
import { FilePreviewPanel } from "../../../../chat-sidebar/FilePreviewPanel";
import { normalizeServerMessages } from "../../../model/conversationChannel";
import { ThreadFileSourceContext } from "../../threadContexts";
import {
  MediaMenuContext,
  useMediaContextMenu,
} from "../../../../file-preview/useMediaContextMenu";
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

const imageAttachment = {
  blockType: "image" as const,
  fileName: "picture.jpg",
  title: "A human image title",
  attachmentIndex: 0,
  localFileRef: `lfi1_${"a".repeat(43)}`,
};
const imageApi = {
  fetchConversationAttachment: async () =>
    new Blob([new Uint8Array([255, 216, 255, 217])], {
      type: "application/octet-stream",
    }),
} as unknown as CommaApiClient;
const imagePreview = async () => ({
  release: () => {},
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
});
function ImageHarness() {
  const menu = useMediaContextMenu();
  return (
    <MediaMenuContext.Provider value={menu.open}>
      <ThreadFileSourceContext.Provider
        value={{ api: imageApi, groupId: "group", conversationId: "home" }}
      >
        <MessageAttachments
          attachments={[imageAttachment]}
          messageId="image-message"
          onPreviewLocalFile={imagePreview}
        />
      </ThreadFileSourceContext.Provider>
      {menu.menu}
    </MediaMenuContext.Provider>
  );
}

describe("agent file cards", () => {
  it("saves a titled JPEG with its canonical extension when the transport MIME is generic", async () => {
    const saveDownload = vi.fn(
      async (_request: { fileName: string; content: Uint8Array }) => ({
        status: "saved" as const,
        fileName: "picture.jpg",
        downloadRef: `dnl1_${"a".repeat(43)}`,
      })
    );
    installNativeBridgeMock({
      platform: "electron",
      os: "macos",
      files: { saveDownload },
    });
    render(<ImageHarness />);
    const image = await screen.findByRole("img", { hidden: true });
    fireEvent.load(image);
    fireEvent.contextMenu(image, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save image" }));
    await waitFor(() => expect(saveDownload).toHaveBeenCalled());
    expect(saveDownload.mock.calls[0]![0].fileName).toBe("picture.jpg");
    expect(Array.from(saveDownload.mock.calls[0]![0].content)).toEqual([
      255, 216, 255, 217,
    ]);
  });

  it("preserves the human title, shows CSV, and opens the path-named document", async () => {
    installNativeBridgeMock({ platform: "web", os: "macos" });
    render(<Harness />);
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText("CSV")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Preview ${title}` }));
    expect(await screen.findByText(/shift,count\s+first,231/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "x.csv" })).toBeVisible();
  });
});
