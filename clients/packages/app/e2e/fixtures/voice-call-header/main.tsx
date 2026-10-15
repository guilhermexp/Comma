import "@comma/ui/styles.css";
import "../../../src/styles.css";
import { useState } from "react";
import {
  CommaUiThemeProvider,
  type CommaUiThemeName,
} from "../../../src/components/commaUiTheme";
import { VoiceCallTranscript } from "../../../src/components/voice/VoiceCallTranscript";
import { useVoiceCallHistory } from "../../../src/components/voice/useVoiceCallHistory";
import { createRoot } from "react-dom/client";
import { CommaI18nProvider } from "@comma/i18n/react";
import type { CommaApiClient } from "../../../src/api";
import type { VoiceCallEvent } from "../../../src/api/voiceCalls";
import { ConversationView } from "../../../src/components/chat/conversation/ConversationView";
import { fixedDraftSource } from "../../../src/components/chat/composer/conversationDraft";
import { idleConversationChannelState } from "../../../src/components/chat/model/conversationChannel";
import { VoiceCallControl } from "../../../src/components/voice/VoiceCallControl";

declare global {
  interface Window {
    voiceHeaderFixture: {
      work: () => void;
      empty: () => void;
      theme: (theme: CommaUiThemeName) => void;
      compact: (compact: boolean) => void;
    };
  }
}

// The real client UI runs against an in-memory voice API and simulated media.
// No backend, subscription account, microphone, or provider is used by this fixture.
Object.defineProperty(window, "AudioContext", { value: undefined });
Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
  value: async () => new MediaStream(),
});
window.RTCPeerConnection = class extends EventTarget {
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { sdp: "mock offer" };
  createDataChannel() {
    return { addEventListener() {}, close() {} };
  }
  addTrack() {}
  async createOffer() {
    return { type: "offer", sdp: "mock offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
} as unknown as typeof RTCPeerConnection;

let cursor = 0;
const events: VoiceCallEvent[] = [];
const api = {
  startVoiceCall: async () => {
    events.push(
      { kind: "started" },
      {
        kind: "caption",
        role: "agent",
        turn: 1,
        text: "Olá! Como posso ajudar hoje?",
        final: true,
      }
    );
    return { call_id: "mock-call", sdp: "mock answer" };
  },
  voiceCallEvents: async () => ({
    cursor: ++cursor,
    truncated: false,
    events: events.splice(0),
  }),
  endVoiceCall: async () => ({}),
} as unknown as CommaApiClient;
const draftSource = fixedDraftSource("");
const noop = () => {};
const actions = {
  discard: noop,
  refresh: noop,
  removeAttachment: noop,
  retry: noop,
  retryAttachment: noop,
  send: noop,
  setDraft: noop,
};

function Fixture() {
  const [empty, setEmpty] = useState(false);
  const [theme, setTheme] = useState<CommaUiThemeName>("Light mode");
  const [compact, setCompact] = useState(false);
  const [callBarVisible, setCallBarVisible] = useState(false);
  const history = useVoiceCallHistory("mock-workspace/mock-conversation", "message-5");
  window.voiceHeaderFixture = {
    empty: () => setEmpty(true),
    compact: setCompact,
    theme: (value) => {
      document.documentElement.dataset.theme = value;
      setTheme(value);
    },
    work: () =>
      events.push(
        { type: "delegation", id: "mock-delegation", status: "pending" },
        {
          kind: "caption",
          role: "caller",
          turn: 1,
          text: "Pode organizar minhas tarefas para amanhã?",
          final: true,
        }
      ),
  };
  const state = {
    ...idleConversationChannelState,
    status: "ready" as const,
    connection: "live" as const,
    conversation: {
      id: "mock-conversation",
      group_id: "mock-group",
      kind: "user_chat" as const,
      title: "Comma",
      status: "completed" as const,
    },
    messages: empty
      ? []
      : Array.from({ length: 6 }, (_, index) => {
          const text =
            index === 0
              ? "Pode me ajudar a organizar a semana?"
              : index % 2
                ? "Claro. Vamos começar pelas prioridades e reservar um tempo para cada tarefa."
                : "Quero separar as tarefas do trabalho e os compromissos pessoais.";
          return {
            attachments: [],
            blocksKey: undefined,
            clientRequestId: undefined,
            createdAt: 1_792_065_600_000 + index * 60_000,
            createdBy: undefined,
            delivery: "sent" as const,
            error: undefined,
            messageId: `message-${index}`,
            parts: [
              {
                kind: "markdown" as const,
                text: index === 0 ? text : Array(5).fill(text).join(" "),
              },
            ],
            refs: [],
            role: index % 2 ? "assistant" : "user",
            source: "server" as const,
            status: "completed" as const,
            text: index === 0 ? text : Array(5).fill(text).join(" "),
          };
        }),
  };
  return (
    <CommaI18nProvider locale="pt-BR">
      <CommaUiThemeProvider theme={theme}>
        <div
          style={{
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            background: "var(--color-bg-secondary)",
            padding: 24,
          }}
        >
          <p
            style={{
              marginBottom: 16,
              color: "var(--color-text-tertiary)",
              fontSize: 12,
            }}
          >
            Comma · API simulada · prova de layout
          </p>
          <div
            style={{
              visibility: compact ? "hidden" : "visible",
              display: "flex",
              flex: 1,
              minHeight: 0,
              borderRadius: 16,
              overflow: "hidden",
              border: "1px solid var(--color-border-secondary)",
            }}
          >
            <ConversationView
              actions={actions}
              draftSource={draftSource}
              groupId="mock-group"
              workspaceId="mock-workspace"
              state={state}
              variant="home"
              surfaceActive={!compact}
              callBarVisible={callBarVisible}
              messageListTails={history.records.map(({ messageId, transcript }) => ({
                key: transcript.callId,
                messageId,
                node: <VoiceCallTranscript transcript={transcript} />,
              }))}
              headerControls={
                <VoiceCallControl
                  api={api}
                  workspaceId="mock-workspace"
                  surfaceActive={!compact}
                  onBarVisibilityChange={setCallBarVisible}
                  onTranscript={history.record}
                />
              }
            />
          </div>
        </div>
      </CommaUiThemeProvider>
    </CommaI18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
