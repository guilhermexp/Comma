import { useCommaMessages } from "@comma/i18n/react";
import { cx } from "../utils";

export const keycapSymbol = (key: string) => (key === "Space" ? "␣" : key);

export interface SettingsShortcutKeycapsProps {
  className?: string;
  keys: readonly string[];
}

export const SettingsShortcutKeycaps = ({
  className,
  keys,
}: SettingsShortcutKeycapsProps) => {
  const messages = useCommaMessages();
  if (keys.length === 0) return null;

  const accessibleName = messages.ui_tooltip_keyboard_shortcut({
    shortcut: keys
      .map((key) => (key === "Space" ? messages.onboarding_shortcut_space() : key))
      .join(" "),
  });

  return (
    <span
      aria-label={accessibleName}
      className={cx("settings-shortcut-keycaps", className)}
      data-slot="settings-keycaps"
    >
      <span aria-hidden="true" className="settings-shortcut__keycaps">
        {keys.map((key, index) => (
          <span
            className="settings-shortcut__keycap-shell"
            data-wide={keycapSymbol(key).length > 1 ? "true" : undefined}
            key={`${key}-${index}`}
          >
            <kbd className="settings-shortcut__keycap">{keycapSymbol(key)}</kbd>
          </span>
        ))}
      </span>
    </span>
  );
};
