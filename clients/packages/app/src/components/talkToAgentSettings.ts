import type { messages } from "@comma/i18n";
import type {
  CommaClientSettings,
  CommaClientSettingsPatch,
  SideChatShortcut,
} from "@comma/native-bridge";
import type { SettingsPanelItem, SettingsPanelSection } from "@comma/ui";

/**
 * Settings → Keyboard shortcuts → Talk to agent. It rides on the Side Chat
 * helper, so it is unavailable, with the reason, while Side Chat is off; its
 * options wait until it is on. The last row says where audio and screenshots go.
 */
export function talkToAgentSettingsSection({
  m,
  onShortcutChange,
  onUpdate,
  pending,
  preferencesLoaded,
  settings,
  shortcutError,
  sideChatOff,
}: {
  m: typeof messages;
  onShortcutChange: (shortcut: SideChatShortcut | null) => void;
  onUpdate: (patch: CommaClientSettingsPatch) => void;
  pending: boolean;
  preferencesLoaded: boolean;
  settings: CommaClientSettings;
  shortcutError?: string;
  sideChatOff: boolean;
}): SettingsPanelSection {
  const on = settings.pushToTalkEnabled && !sideChatOff;
  const optionsDisabled = !preferencesLoaded || !on || pending;
  const items: SettingsPanelItem[] = [
    {
      id: "keyboard.talk-to-agent.enabled",
      title: m.settings_talk_to_agent(),
      description: sideChatOff
        ? m.settings_talk_to_agent_needs_side_chat()
        : m.settings_talk_to_agent_description(),
      keywords: ["push to talk", "voice", "falar", "voz", "语音", "按住说话"],
      control: {
        type: "toggle",
        checked: on,
        disabled: !preferencesLoaded || sideChatOff || pending,
        onChange: (event) => onUpdate({ pushToTalkEnabled: event.target.checked }),
      },
    },
    {
      id: "keyboard.talk-to-agent.shortcut",
      title: m.settings_talk_to_agent_shortcut(),
      description: m.settings_talk_to_agent_shortcut_description(),
      keywords: ["hotkey", "shortcut", "快捷键", "atalho", "teclado"],
      control: {
        type: "shortcut",
        value: settings.pushToTalkShortcut,
        disabled: optionsDisabled,
        recordingLabel: m.settings_press_shortcut(),
        onClear: () => onShortcutChange(null),
        onChange: onShortcutChange,
        ...(shortcutError ? { errorMessage: shortcutError } : {}),
      },
    },
    {
      id: "keyboard.talk-to-agent.speak-replies",
      title: m.settings_talk_to_agent_speak_replies(),
      description: m.settings_talk_to_agent_speak_replies_description(),
      control: {
        type: "toggle",
        checked: settings.pushToTalkSpeakReplies,
        disabled: optionsDisabled,
        onChange: (event) => onUpdate({ pushToTalkSpeakReplies: event.target.checked }),
      },
    },
    {
      id: "keyboard.talk-to-agent.send-screen",
      title: m.settings_talk_to_agent_send_screen(),
      description: m.settings_talk_to_agent_send_screen_description(),
      keywords: ["screenshot", "print", "截图", "screen recording"],
      control: {
        type: "toggle",
        checked: settings.pushToTalkSendScreen,
        disabled: optionsDisabled,
        onChange: (event) => onUpdate({ pushToTalkSendScreen: event.target.checked }),
      },
    },
    {
      id: "keyboard.talk-to-agent.privacy",
      title: m.settings_talk_to_agent_privacy(),
      description: m.settings_talk_to_agent_privacy_description(),
      keywords: ["privacy", "privacidade", "隐私"],
    },
  ];
  return { id: "keyboard.talk-to-agent", title: m.settings_talk_to_agent(), items };
}
