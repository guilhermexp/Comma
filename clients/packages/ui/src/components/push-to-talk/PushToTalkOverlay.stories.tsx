import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ReactNode } from "react";
import { PushToTalkOverlay } from "./PushToTalkOverlay";

/** Stand-in for another app under the transparent overlay. */
const Desktop = ({ children }: { children: ReactNode }) => (
  <div className="relative h-screen w-screen overflow-hidden bg-secondary">
    <div className="absolute top-[64px] left-[72px] flex h-[520px] w-[860px] flex-col gap-lg rounded-xl border border-secondary bg-primary p-3xl shadow-lg">
      <div className="h-md w-[220px] rounded-sm bg-tertiary" />
      <div className="flex gap-xl">
        {[128, 196, 88, 240, 164, 212].map((height, index) => (
          <div
            className="mt-auto w-[72px] rounded-sm bg-brand-solid opacity-70"
            key={index}
            style={{ height }}
          />
        ))}
      </div>
      <div className="h-sm w-[520px] rounded-sm bg-tertiary" />
      <div className="h-sm w-[440px] rounded-sm bg-tertiary" />
    </div>
    {children}
  </div>
);

const meta = {
  title: "App components/Talk to agent overlay",
  component: PushToTalkOverlay,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Transparent overlay of the Talk to agent shortcut: a state pill beside the pointer and, while the shortcut is held, a crosshair to mark one area of the display. Main owns the turn; the overlay reports the area and the pill's actions.",
      },
    },
  },
  args: {
    anchor: { x: 560, y: 300 },
    onAction: fn(),
    onRegionChange: fn(),
    pill: { kind: "listening" },
  },
  decorators: [
    (Story) => (
      <Desktop>
        <Story />
      </Desktop>
    ),
  ],
} satisfies Meta<typeof PushToTalkOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Listening: Story = {};

export const MarkedArea: Story = {
  args: {
    anchor: { x: 520, y: 250 },
    defaultRegion: { height: 260, width: 470, x: 150, y: 190 },
  },
};

export const Transcribing: Story = { args: { pill: { kind: "transcribing" } } };

export const Busy: Story = { args: { pill: { kind: "busy" } } };

export const MicrophoneDenied: Story = {
  args: {
    pill: { code: "microphone_denied", kind: "error", transcriptAvailable: false },
  },
};

export const ScreenshotNotSent: Story = {
  args: { pill: { code: "screen_denied", kind: "error", transcriptAvailable: false } },
};

export const TranscriptionUnavailable: Story = {
  args: {
    pill: {
      code: "transcription_unavailable",
      kind: "error",
      transcriptAvailable: false,
    },
  },
};

export const SendFailed: Story = {
  args: { pill: { code: "send_failed", kind: "error", transcriptAvailable: true } },
};

export const NothingHeard: Story = {
  args: { pill: { code: "nothing_heard", kind: "error", transcriptAvailable: false } },
};

/** Near the display's bottom-right corner the pill flips to stay on screen. */
export const NearTheEdge: Story = {
  args: { anchor: { x: 1180, y: 690 }, pill: { kind: "transcribing" } },
};
