import type { messages } from "@comma/i18n";
import type {
  AppPreferences,
  CommaClientSettings,
  CommaClientSettingsPatch,
  PushToTalkShortcut,
} from "@comma/native-bridge";
import type { SettingsPanelItem, SettingsPanelSection } from "@comma/ui";

/**
 * Settings → Keyboard shortcuts → Talk to agent. It rides on the Side Chat
 * helper, so it is unavailable, with the reason, while Side Chat is off; its
 * options wait until it is on. A modifier-only chord adds the Input Monitoring
 * row it depends on, and the screenshot adds the Screen Recording row. The
 * last row says where audio and screenshots go.
 */
export function talkToAgentSettingsSection({
  inputMonitoring,
  m,
  onOpenInputMonitoringSettings,
  onOpenScreenRecordingSettings,
  onShortcutChange,
  onUpdate,
  pending,
  preferencesLoaded,
  screenRecording,
  settings,
  shortcutError,
  sideChatOff,
}: {
  /** Main's readback for the registered chord; undefined before it reports. */
  inputMonitoring?: AppPreferences["pushToTalkInputMonitoringStatus"];
  m: typeof messages;
  onOpenInputMonitoringSettings: () => void;
  onOpenScreenRecordingSettings: () => void;
  onShortcutChange: (shortcut: PushToTalkShortcut | null) => void;
  onUpdate: (patch: CommaClientSettingsPatch) => void;
  pending: boolean;
  preferencesLoaded: boolean;
  /** Main's macOS readback; undefined on other platforms. */
  screenRecording?: AppPreferences["pushToTalkScreenRecordingStatus"];
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
        allowModifierOnly: true,
        value: settings.pushToTalkShortcut,
        disabled: !preferencesLoaded || pending,
        recordingLabel: m.settings_press_shortcut(),
        onClear: () => onShortcutChange(null),
        onChange: onShortcutChange,
        ...(shortcutError ? { errorMessage: shortcutError } : {}),
      },
    },
    ...(on &&
    settings.pushToTalkShortcut?.key === null &&
    (inputMonitoring === "denied" || inputMonitoring === "granted")
      ? [inputMonitoringItem({ m, inputMonitoring, onOpenInputMonitoringSettings })]
      : []),
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
    ...(on && settings.pushToTalkSendScreen && screenRecording
      ? [screenRecordingItem({ m, onOpenScreenRecordingSettings, screenRecording })]
      : []),
    {
      id: "keyboard.talk-to-agent.privacy",
      title: m.settings_talk_to_agent_privacy(),
      description: m.settings_talk_to_agent_privacy_description(),
      keywords: ["privacy", "privacidade", "隐私"],
    },
  ];
  return { id: "keyboard.talk-to-agent", title: m.settings_talk_to_agent(), items };
}

function inputMonitoringItem({
  inputMonitoring,
  m,
  onOpenInputMonitoringSettings,
}: {
  inputMonitoring: "denied" | "granted";
  m: typeof messages;
  onOpenInputMonitoringSettings: () => void;
}): SettingsPanelItem {
  const item = {
    id: "keyboard.talk-to-agent.input-monitoring",
    title: m.settings_talk_to_agent_input_monitoring(),
    keywords: ["permission", "permissão", "权限", "privacy", "input monitoring"],
  };
  return inputMonitoring === "granted"
    ? {
        ...item,
        description: m.settings_talk_to_agent_input_monitoring_granted_description(),
        status: {
          label: m.settings_talk_to_agent_input_monitoring_allowed(),
          color: "success",
        },
      }
    : {
        ...item,
        description: m.settings_talk_to_agent_input_monitoring_denied_description(),
        status: {
          label: m.settings_talk_to_agent_input_monitoring_inactive(),
          color: "warning",
        },
        control: {
          type: "button",
          label: m.settings_system_notifications_open_system_settings(),
          onPress: onOpenInputMonitoringSettings,
        },
      };
}

function screenRecordingItem({
  m,
  onOpenScreenRecordingSettings,
  screenRecording,
}: {
  m: typeof messages;
  onOpenScreenRecordingSettings: () => void;
  screenRecording: "denied" | "granted";
}): SettingsPanelItem {
  const item = {
    id: "keyboard.talk-to-agent.screen-recording",
    title: m.settings_talk_to_agent_screen_recording(),
    keywords: ["permission", "permissão", "权限", "privacy", "screen recording"],
  };
  return screenRecording === "granted"
    ? {
        ...item,
        description: m.settings_talk_to_agent_screen_recording_granted_description(),
        status: {
          label: m.settings_talk_to_agent_input_monitoring_allowed(),
          color: "success",
        },
      }
    : {
        ...item,
        description: m.settings_talk_to_agent_screen_recording_denied_description(),
        status: {
          label: m.settings_talk_to_agent_screen_recording_off(),
          color: "warning",
        },
        control: {
          type: "button",
          label: m.settings_system_notifications_open_system_settings(),
          onPress: onOpenScreenRecordingSettings,
        },
      };
}
