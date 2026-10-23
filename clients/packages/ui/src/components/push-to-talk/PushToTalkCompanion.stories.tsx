import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ReactNode } from "react";
import { PushToTalkCompanion } from "./PushToTalkCompanion";

/** Main's `pushToTalkStrokeColor`; the app passes the constant itself. */
const companionBlue = "#2F80FF";

/** Stand-in for another app under the transparent overlay: a sales report. */
const Desktop = ({ children }: { children: ReactNode }) => (
  <div className="relative h-screen w-screen overflow-hidden bg-secondary">
    <div className="flex h-[26px] items-center gap-xl bg-primary px-xl text-xs text-secondary">
      <span className="font-semibold text-primary">Numbers</span>
      <span>File</span>
      <span>Edit</span>
      <span>View</span>
    </div>
    <div className="absolute top-[64px] left-[72px] flex h-[560px] w-[900px] flex-col gap-xl rounded-xl border border-secondary bg-primary p-3xl shadow-lg">
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold text-primary">Revenue by month</span>
        <span className="text-sm text-tertiary">FY 2026 · USD thousands</span>
      </div>
      <div className="flex h-[300px] items-end gap-xl border-b border-secondary pb-md">
        {[128, 196, 268, 240, 164, 212, 150, 184].map((height, index) => (
          <div className="flex flex-1 flex-col items-center gap-sm" key={index}>
            <div className="w-full rounded-sm bg-tertiary" style={{ height }} />
            <span className="text-xs text-tertiary">
              {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"][index]}
            </span>
          </div>
        ))}
      </div>
      <p className="max-w-[640px] text-sm text-secondary">
        March closed 18% above plan, carried by the enterprise renewals. April and May
        slowed as two large contracts moved to the next quarter.
      </p>
      <div className="h-sm w-[440px] rounded-sm bg-tertiary" />
    </div>
    {children}
  </div>
);

/** A hand-drawn loop around the March bar, slightly overshooting where it closes. */
const marchLoop = Array.from({ length: 42 }, (_, index) => {
  const turn = (index / 40) * Math.PI * 2.12 - Math.PI * 0.62;
  const wobble = 1 + Math.sin(index * 1.7) * 0.03;
  return {
    x: Math.round(360 + Math.cos(turn) * 70 * wobble),
    y: Math.round(262 + Math.sin(turn) * 150 * wobble),
  };
});

const meta = {
  title: "App components/Talk to agent companion",
  component: PushToTalkCompanion,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Cursor companion of the Talk to agent shortcut: a blue marker beside the pointer with the voice level, a wait, and the reply's caption balloon. While the shortcut is held a drag draws one freehand stroke. Main owns the turn and follows the pointer; the companion reports the stroke and the balloon's clicks.",
      },
    },
  },
  args: {
    caption: null,
    color: companionBlue,
    cursor: { x: 640, y: 330 },
    level: 0.55,
    onAction: fn(),
    onCaptionClick: fn(),
    onStrokeChange: fn(),
    state: { kind: "listening" },
  },
  decorators: [
    (Story) => (
      <Desktop>
        <Story />
      </Desktop>
    ),
  ],
} satisfies Meta<typeof PushToTalkCompanion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Listening: Story = {};

/** The user circles March while asking about it. */
export const DrawingAStroke: Story = {
  args: {
    cursor: marchLoop.at(-1)!,
    defaultStroke: marchLoop,
    level: 0.8,
  },
};

export const Transcribing: Story = { args: { state: { kind: "transcribing" } } };

export const Thinking: Story = { args: { state: { kind: "thinking" } } };

export const Speaking: Story = {
  args: {
    caption:
      "March closed 18% above plan, mostly enterprise renewals. April dipped because two contracts slipped to Q3.",
    state: { kind: "speaking" },
  },
};

/** With the voice off the whole reply shows, and a long one scrolls. */
export const WholeReply: Story = {
  args: {
    caption:
      "March closed 18% above plan, mostly from enterprise renewals that landed early. April dipped because two large contracts slipped to the third quarter, and May followed the same pattern. June recovered once the delayed renewals signed. If the slipped contracts close in July as forecast, the year still ends about 6% above plan. The main risk is the August renewal cohort, which is smaller than last year's.",
    state: { kind: "speaking" },
  },
};

export const Busy: Story = { args: { state: { kind: "busy" } } };

export const MicrophoneDenied: Story = {
  args: {
    state: { code: "microphone_denied", kind: "error", transcriptAvailable: false },
  },
};

export const SendFailed: Story = {
  args: { state: { code: "send_failed", kind: "error", transcriptAvailable: true } },
};

export const NothingHeard: Story = {
  args: { state: { code: "nothing_heard", kind: "error", transcriptAvailable: false } },
};

/** Near the display's bottom-right corner the balloon flips to stay on screen. */
export const NearTheEdge: Story = {
  args: {
    caption: "Revenue peaks in March.",
    cursor: { x: 1180, y: 690 },
    state: { kind: "speaking" },
  },
};
