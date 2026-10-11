import { useCommaMessages } from "@comma/i18n/react";
import { Button as AriaButton } from "react-aria-components";
import { XIcon } from "../icons";
import { cx, definedProps } from "../utils";
import {
  toastActionsRow,
  toastCloseButton,
  toastSecondaryAction,
  toastTertiaryAction,
} from "./styles";
import type { ToastAction } from "./types";

export const ToastCloseButton = ({ onPress }: { onPress?: () => void }) => {
  const messages = useCommaMessages();
  return (
    <AriaButton
      type="button"
      {...definedProps({ onPress })}
      aria-label={messages.ui_toast_dismiss()}
      className={toastCloseButton}
    >
      <XIcon className="size-2xl shrink-0" />
    </AriaButton>
  );
};

export const ToastActions = ({ actions }: { actions?: ToastAction[] }) => {
  if (!actions?.length) return null;

  return (
    <div className={toastActionsRow}>
      {actions.map((action) => (
        <AriaButton
          key={action.label}
          type="button"
          {...definedProps({ onPress: action.onPress })}
          className={cx(
            action.hierarchy === "tertiary-gray"
              ? toastTertiaryAction
              : toastSecondaryAction
          )}
        >
          {action.label}
        </AriaButton>
      ))}
    </div>
  );
};
