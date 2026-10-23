import { useCommaMessages } from "@comma/i18n/react";
import {
  commaClientSettingsSchema,
  defaultCommaClientSettings,
} from "@comma/native-bridge";
import { SettingsPanel } from "@comma/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import "../styles.css";
import { talkToAgentSettingsSection } from "./talkToAgentSettings";

interface Args {
  enabled: boolean;
  shortcutConflict: boolean;
  sideChatOff: boolean;
}

function TalkToAgentSettings({ enabled, shortcutConflict, sideChatOff }: Args) {
  const m = useCommaMessages();
  const [settings, setSettings] = useState({
    ...defaultCommaClientSettings,
    pushToTalkEnabled: enabled,
  });
  const section = talkToAgentSettingsSection({
    m,
    onShortcutChange: (pushToTalkShortcut) =>
      setSettings((current) => ({ ...current, pushToTalkShortcut })),
    onUpdate: (patch) =>
      setSettings((current) =>
        commaClientSettingsSchema.parse({ ...current, ...patch })
      ),
    pending: false,
    preferencesLoaded: true,
    settings,
    ...(shortcutConflict
      ? {
          shortcutError: m.settings_talk_to_agent_shortcut_conflict({
            shortcut: m.settings_open_side_chat(),
          }),
        }
      : {}),
    sideChatOff,
  });
  return (
    <SettingsPanel
      className="h-[720px] w-[860px]"
      sections={[section]}
      title={m.settings_keyboard_shortcuts()}
    />
  );
}

const meta = {
  title: "App components/Talk to agent settings",
  component: TalkToAgentSettings,
  parameters: { layout: "fullscreen" },
  args: { enabled: false, shortcutConflict: false, sideChatOff: false },
} satisfies Meta<typeof TalkToAgentSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};
export const On: Story = { args: { enabled: true } };
export const SideChatOff: Story = { args: { sideChatOff: true } };
export const ShortcutConflict: Story = {
  args: { enabled: true, shortcutConflict: true },
};
