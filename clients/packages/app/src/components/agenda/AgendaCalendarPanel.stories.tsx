import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import "../../styles.css";
import { AgendaCalendarPanel } from "./AgendaCalendarPanel";
import type { AgendaCalendar, AgendaSource } from "./agendaSource";
import type { AgendaGroup } from "./useAgendaData";

// The calendar panel with a Google account and the Mac Calendar not yet on.
// On the web the bridge has no Calendar app icon, so the control shows the
// calendar glyph; the desktop app shows the Calendar app's own icon.

const calendar = (id: string, name: string, color: string): AgendaCalendar => ({
  key: `google:acc:${id}`,
  source: "google",
  accountId: "acc",
  id,
  name,
  color,
  writable: true,
  primary: id === "primary",
  ownerEmail: "ana@example.com",
  sourceLabel: null,
});

const google: AgendaGroup = {
  entry: {
    key: "google:acc",
    kind: "google",
    accountId: "acc",
    label: "Google",
    email: "ana@example.com",
    source: {} as AgendaSource,
  },
  status: "ready",
  calendars: [
    calendar("primary", "Ana", "#1a73e8"),
    calendar("work", "Trabalho", "#33b679"),
    calendar("family", "Família", "#f4511e"),
  ],
  truncated: false,
  failedCalendarIds: [],
};

const meta = {
  title: "App components/Agenda calendar panel",
  component: AgendaCalendarPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-screen bg-secondary p-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    groups: [google],
    google: { status: "ready", candidates: [] },
    mac: { access: "notDetermined", enable: fn(), openSettings: fn() },
    isVisible: () => true,
    onVisible: fn(),
    onRetry: fn(),
    onConnect: fn(),
    onUseAccount: fn(),
    onRetryAccounts: fn(),
  },
} satisfies Meta<typeof AgendaCalendarPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Before the first system prompt: the press asks macOS for access. */
export const MacNotDetermined: Story = {};

/** After a refusal: the press opens Privacy & Security › Calendars. */
export const MacDenied: Story = {
  args: { mac: { access: "denied", enable: fn(), openSettings: fn() } },
};

/** With access granted the control is gone. */
export const MacGranted: Story = { args: { mac: null } };
