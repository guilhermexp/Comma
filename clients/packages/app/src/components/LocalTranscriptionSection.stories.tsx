import type {
  AudioCaptureRecording,
  CommaNativeBridge,
  LocalTranscriptionNotice,
  LocalTranscriptionState,
} from "@comma/native-bridge";
import { SettingsPanel, Toaster, toast } from "@comma/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import "../styles.css";
import { LocalTranscriptionNoticeHost } from "./LocalTranscriptionNoticeHost";
import { useLocalTranscriptionSection } from "./useLocalTranscriptionSection";

const size = 654_000_000;

const recording: AudioCaptureRecording = {
  channels: 1,
  sampleRate: 48_000,
  durationMs: 600_000,
  file: { name: "call.m4a", size: 3_600_000, mediaType: "audio/mp4" },
  driveFile: { space: "comma-drive", path: "recording/2026-10-20/call.m4a" },
};

/**
 * Stands in for Main: the section reads `localTranscription.state` and the
 * notice host listens to `localTranscription.onNotice`, as in the desktop app.
 */
function WithMockBridge({
  state,
  notice = false,
  children,
}: {
  state: LocalTranscriptionState;
  notice?: boolean;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = globalThis.commaNative;
    const listeners = new Set<(notice: LocalTranscriptionNotice) => void>();
    const get = async () => state;
    globalThis.commaNative = {
      platform: "electron",
      localTranscription: {
        state: Object.assign(get, {
          get,
          subscribe: (listener: (next: LocalTranscriptionState) => void) => {
            listener(state);
            return () => undefined;
          },
        }),
        install: async () => ({ accepted: true }),
        cancel: async () => ({ accepted: true }),
        remove: async () => ({ accepted: false, reason: "busy" }),
        onNotice: (listener: (next: LocalTranscriptionNotice) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as CommaNativeBridge;
    setReady(true);
    const timer = notice
      ? setTimeout(() => {
          for (const listener of listeners)
            listener({ reason: "local_asr_model_not_installed", recording });
        }, 50)
      : undefined;
    return () => {
      clearTimeout(timer);
      toast.dismissAll();
      globalThis.commaNative = previous;
    };
  }, [notice, state]);
  return ready ? children : null;
}

function LocalTranscriptionSettings() {
  const { section, removalDialog } = useLocalTranscriptionSection();
  return (
    <>
      <SettingsPanel
        className="h-[360px] w-[860px]"
        sections={[section]}
        title="Meeting"
      />
      {removalDialog}
    </>
  );
}

const meta = {
  title: "App components/Local transcription",
  parameters: { layout: "fullscreen" },
  args: { state: { supported: true, phase: "not_installed", sizeBytes: size } },
  render: ({ state }) => (
    <WithMockBridge state={state}>
      <div className="p-xl">
        <LocalTranscriptionSettings />
      </div>
    </WithMockBridge>
  ),
} satisfies Meta<{ state: LocalTranscriptionState }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unsupported: Story = {
  args: {
    state: {
      supported: false,
      reason: "unsupported_os",
      phase: "not_installed",
      sizeBytes: size,
    },
  },
};

export const RemoteBackend: Story = {
  args: {
    state: {
      supported: false,
      reason: "remote_backend",
      phase: "not_installed",
      sizeBytes: 0,
    },
  },
};

export const NotInstalled: Story = {};

export const Downloading: Story = {
  args: {
    state: { supported: true, phase: "downloading", fraction: 0.42, sizeBytes: size },
  },
};

export const Preparing: Story = {
  args: { state: { supported: true, phase: "preparing", sizeBytes: size } },
};

/** Remove answers `busy` here, to show the refusal during a transcription. */
export const Ready: Story = {
  args: { state: { supported: true, phase: "ready", sizeBytes: size } },
};

export const Failed: Story = {
  args: {
    state: {
      supported: true,
      phase: "failed",
      sizeBytes: size,
      error: { code: "checksum_mismatch", message: "weight.bin does not match" },
    },
  },
};

/** A recording saved while the model is missing raises the install notice. */
export const InstallNotice: Story = {
  render: ({ state }) => (
    <WithMockBridge state={state} notice>
      <Toaster />
      <LocalTranscriptionNoticeHost />
      <div className="min-h-screen" />
    </WithMockBridge>
  ),
};
