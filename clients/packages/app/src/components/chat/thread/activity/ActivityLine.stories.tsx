import type { Meta, StoryObj } from "@storybook/react-vite";
import "../../../../styles.css";
import { ParticipantStatusSlot } from "./ActivityLine";

const meta = {
  title: "App components/Chat activity",
  component: ParticipantStatusSlot,
  args: {
    participantStatus: {
      conversationId: "preview",
      participantId: "router",
      actorRole: "router",
      state: "active",
      status: "is thinking...",
      updatedAt: 1,
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ParticipantStatusSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RouterThinking: Story = {};

export const WorkingOnWeChat: Story = {
  args: {
    participantStatus: { ...meta.args.participantStatus, workingProvider: "wechat" },
  },
};

export const WorkingOnTelegram: Story = {
  args: {
    participantStatus: { ...meta.args.participantStatus, workingProvider: "telegram" },
  },
};

export const WorkingOnSignal: Story = {
  args: {
    participantStatus: { ...meta.args.participantStatus, workingProvider: "signal" },
  },
};

export const RouterError: Story = {
  args: {
    participantStatus: {
      ...meta.args.participantStatus,
      state: "error",
      status: "Runtime unavailable",
    },
  },
};

// Fixture frame: a running command with its producer start, as the indicator
// shows a real tool call. The time counts from the story's load.
export const RouterRunningCommand: Story = {
  args: {
    activity: {
      conversationId: "preview",
      detail: "git",
      phase: "execution",
      responseKey: "preview-response",
      startedAt: Date.now() / 1000,
      status: "running",
      summary: "Running a command",
      summaryClass: "public",
      toolCallId: "preview-call",
      toolName: "env.exec",
    },
  },
};
