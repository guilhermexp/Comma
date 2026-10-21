import type {
  AudioCaptureRecording,
  CommaNativeBridge,
  LocalTranscriptionState,
  MeetingTranscriptionActionResult,
  MeetingTranscriptionNotice,
  MeetingTranscriptionState,
} from "@comma/native-bridge";
import { SettingsPanel, Toaster, toast } from "@comma/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import { userEvent, within } from "storybook/test";
import "../styles.css";
import { LocalTranscriptionNoticeHost } from "./LocalTranscriptionNoticeHost";
import { useMeetingTranscriptionSection } from "./useMeetingTranscriptionSection";

const size = 654_000_000;

const recording: AudioCaptureRecording = {
  channels: 1,
  sampleRate: 48_000,
  durationMs: 600_000,
  file: { name: "call.m4a", size: 3_600_000, mediaType: "audio/mp4" },
  driveFile: { space: "comma-drive", path: "recording/2026-10-20/call.m4a" },
};

const localNotInstalled: LocalTranscriptionState = {
  supported: true,
  phase: "not_installed",
  sizeBytes: size,
};
const localReady: LocalTranscriptionState = { ...localNotInstalled, phase: "ready" };

const groqReady: MeetingTranscriptionState = {
  provider: "groq",
  ready: true,
  cloud: {
    kind: "groq",
    model: "whisper-large-v3",
    baseHost: "api.groq.com",
    hasKey: true,
    verification: "valid",
  },
  diarization: "ready",
};

const localEngine: MeetingTranscriptionState = {
  provider: "local",
  ready: false,
  reason: "local_model_missing",
  diarization: "not_installed",
};

interface Args {
  meeting: MeetingTranscriptionState;
  local: LocalTranscriptionState;
  /** What Save answers, as Main would after checking the key. */
  result?: MeetingTranscriptionActionResult | "pending";
  notice?: MeetingTranscriptionNotice["kind"];
}

/**
 * Stands in for Main: the section reads `meetingTranscription.state` and
 * `localTranscription.state`, and the notice host listens to
 * `meetingTranscription.onNotice`, as in the desktop app. No key is real.
 */
function WithMockBridge({ args, children }: { args: Args; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = globalThis.commaNative;
    const listeners = new Set<(notice: MeetingTranscriptionNotice) => void>();
    const state = <T,>(value: T) => {
      const get = async () => value;
      return Object.assign(get, {
        get,
        subscribe: (listener: (next: T) => void) => {
          listener(value);
          return () => undefined;
        },
      });
    };
    const answer = async (): Promise<MeetingTranscriptionActionResult> =>
      args.result === "pending"
        ? new Promise(() => undefined)
        : (args.result ?? { accepted: true });
    globalThis.commaNative = {
      platform: "electron",
      localTranscription: {
        state: state(args.local),
        install: async () => ({ accepted: true }),
        cancel: async () => ({ accepted: true }),
        remove: async () => ({ accepted: true }),
      },
      meetingTranscription: {
        state: state(args.meeting),
        setProvider: answer,
        clearKey: async () => ({ accepted: true }),
        retryVerify: async () => ({ accepted: true }),
        onNotice: (listener: (next: MeetingTranscriptionNotice) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as CommaNativeBridge;
    setReady(true);
    const kind = args.notice;
    const timer = kind
      ? setTimeout(() => {
          for (const listener of listeners)
            listener({
              kind,
              recording,
              ...(kind === "fallback" ? { reason: "cloud_unreachable" } : {}),
              ...(kind === "cloud_failed"
                ? { reason: "cloud_quota", provider: "groq" as const }
                : {}),
            });
        }, 50)
      : undefined;
    return () => {
      clearTimeout(timer);
      toast.dismissAll();
      globalThis.commaNative = previous;
    };
  }, [args]);
  return ready ? children : null;
}

function MeetingTranscriptionSettings() {
  const { section, removalDialog } = useMeetingTranscriptionSection();
  return (
    <>
      <SettingsPanel
        className="h-[760px] w-[860px]"
        sections={[section]}
        title="Meeting"
      />
      {removalDialog}
    </>
  );
}

const meta = {
  title: "App components/Meeting transcription",
  parameters: { layout: "fullscreen" },
  args: { meeting: localEngine, local: localNotInstalled },
  render: (args) => (
    <WithMockBridge args={args}>
      <div className="p-xl">
        <MeetingTranscriptionSettings />
      </div>
    </WithMockBridge>
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

async function chooseEngine(canvasElement: HTMLElement, option: string) {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: /Transcription engine/ })
  );
  await userEvent.click(
    await within(document.body).findByRole("option", { name: option })
  );
}

/** The default: this Mac, with the model still to install. */
export const LocalDefault: Story = {};

export const LocalReady: Story = {
  args: {
    meeting: { provider: "local", ready: true, diarization: "ready" },
    local: localReady,
  },
};

/** Groq chosen, before any key was saved: only the key and the model. */
export const GroqNewKey: Story = {
  play: async ({ canvasElement }) => {
    await chooseEngine(canvasElement, "Groq");
    await userEvent.type(
      await within(canvasElement).findByLabelText("API key"),
      "gsk_example_not_a_real_key"
    );
  },
};

/** Save waits for Main's check of the key. */
export const GroqChecking: Story = {
  args: { result: "pending" },
  play: async ({ canvasElement }) => {
    await GroqNewKey.play!({ canvasElement } as never);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Save" }));
  },
};

/** The provider refused the key: the previous engine stays selected. */
export const GroqKeyRejectedOnSave: Story = {
  args: { result: { accepted: false, reason: "key_rejected" } },
  play: GroqChecking.play!,
};

/** A saved Groq key: never shown, with Replace and Delete. */
export const GroqReady: Story = {
  args: { meeting: groqReady, local: localReady },
};

export const GroqSeparatorInstalling: Story = {
  args: {
    meeting: {
      ...groqReady,
      ready: false,
      reason: "diarization_missing",
      diarization: "downloading",
    },
  },
};

export const GroqSeparatorFailed: Story = {
  args: {
    meeting: {
      ...groqReady,
      ready: false,
      reason: "diarization_missing",
      diarization: "failed",
    },
  },
};

/** A transcription found the saved key revoked. */
export const GroqSavedKeyRejected: Story = {
  args: {
    meeting: {
      ...groqReady,
      ready: false,
      reason: "key_rejected",
      cloud: { ...groqReady.cloud!, verification: "rejected" },
    },
  },
};

export const GroqRechecking: Story = {
  args: {
    meeting: { ...groqReady, cloud: { ...groqReady.cloud!, verification: "checking" } },
  },
};

/** An OpenAI-compatible API: URL, key and model, and an http URL refused. */
export const CompatibleInsecureUrl: Story = {
  args: { result: { accepted: false, reason: "insecure_url" } },
  play: async ({ canvasElement }) => {
    await chooseEngine(canvasElement, "OpenAI-compatible API");
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByLabelText("Base URL"),
      "http://asr.example.com/v1"
    );
    await userEvent.type(canvas.getByLabelText("API key"), "sk-example");
    await userEvent.type(canvas.getByLabelText("Model"), "whisper-1");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
  },
};

export const CompatibleReady: Story = {
  args: {
    meeting: {
      ...groqReady,
      provider: "openai_compatible",
      cloud: {
        ...groqReady.cloud!,
        kind: "openai_compatible",
        model: "whisper-1",
        baseHost: "asr.example.com",
      },
    },
    local: localReady,
  },
};

/** Local is selected; the Groq key stays saved from before. */
const keptGroqKey: Args = {
  meeting: {
    provider: "local",
    ready: true,
    diarization: "ready",
    cloud: groqReady.cloud!,
  },
  local: localReady,
};

export const LocalWithKeptGroqKey: Story = { args: keptGroqKey };

/** Choosing Groq again shows the kept key; Save selects it after a check. */
export const LocalToGroqReuse: Story = {
  args: keptGroqKey,
  play: async ({ canvasElement }) => {
    await chooseEngine(canvasElement, "Groq");
  },
};

export const KeychainUnavailable: Story = {
  args: { meeting: { ...localEngine, reason: "secure_storage_unavailable" } },
};

function Notices() {
  return (
    <>
      <Toaster />
      <LocalTranscriptionNoticeHost />
      <div className="min-h-screen" />
    </>
  );
}

const notices = (args: Args) => (
  <WithMockBridge args={args}>
    <Notices />
  </WithMockBridge>
);

/** Groq failed and this Mac's model transcribed the recording. */
export const FallbackNotice: Story = {
  args: { meeting: groqReady, local: localReady, notice: "fallback" },
  render: notices,
};

/** Groq is selected but not ready: the notice leads to Settings → Meeting. */
export const ConfigureNotice: Story = {
  args: {
    meeting: {
      ...groqReady,
      ready: false,
      reason: "key_rejected",
      cloud: { ...groqReady.cloud!, verification: "rejected" },
    },
    notice: "configure",
  },
  render: notices,
};

/** Local is selected and its model is missing. */
export const InstallLocalNotice: Story = {
  args: { notice: "install_local" },
  render: notices,
};

/** Groq failed and no local model could take over: Try again, never Install. */
export const CloudFailedNotice: Story = {
  args: { meeting: groqReady, notice: "cloud_failed" },
  render: notices,
};
