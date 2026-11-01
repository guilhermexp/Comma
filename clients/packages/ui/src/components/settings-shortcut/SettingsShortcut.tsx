import { messages as commaMessages } from "@comma/i18n";
import { useCommaMessages } from "@comma/i18n/react";
import { keycapSymbol } from "./SettingsShortcutKeycaps";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { CircleMinusIcon } from "../icons";
import { cx } from "../utils";

export type SettingsShortcutKey =
  | "space"
  | "comma"
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9";

export interface SettingsShortcutValue {
  key: SettingsShortcutKey;
  modifiers: {
    alt: boolean;
    control: boolean;
    meta: boolean;
    shift: boolean;
  };
}

/** A shortcut that may also be modifiers held alone (`key: null`). */
export interface SettingsShortcutChordValue {
  key: SettingsShortcutKey | null;
  modifiers: SettingsShortcutValue["modifiers"];
}

interface SettingsShortcutCommonProps {
  ariaLabel: string;
  className?: string;
  clearLabel?: string;
  disabled?: boolean;
  emptyLabel?: string;
  errorMessage?: string;
  onClear?: () => Promise<void> | void;
  recordingLabel?: string;
}

export type SettingsShortcutProps = SettingsShortcutCommonProps &
  (
    | {
        allowModifierOnly?: false;
        onChange?: (shortcut: SettingsShortcutValue) => Promise<void> | void;
        value: SettingsShortcutValue | null;
      }
    | {
        /**
         * Also saves two or more modifiers held alone, once all of them are
         * released without a regular key (a hold-to-talk chord such as ⌃⌥).
         */
        allowModifierOnly: true;
        onChange?: (shortcut: SettingsShortcutChordValue) => Promise<void> | void;
        value: SettingsShortcutChordValue | null;
      }
  );

const physicalShortcutKey = (code: string): SettingsShortcutKey | undefined => {
  if (code === "Space") return "space";
  if (code === "Comma") return "comma";
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter.toLocaleLowerCase() as SettingsShortcutKey;

  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  return digit as SettingsShortcutKey | undefined;
};

const keyText = (key: SettingsShortcutKey) =>
  key === "space" ? "Space" : key === "comma" ? "," : key.toLocaleUpperCase();

const shortcutParts = ({ key, modifiers }: SettingsShortcutChordValue) => [
  ...(modifiers.control ? ["Ctrl"] : []),
  ...(modifiers.alt ? ["Alt"] : []),
  ...(modifiers.shift ? ["Shift"] : []),
  ...(modifiers.meta ? ["Cmd"] : []),
  ...(key === null
    ? []
    : [key === "space" ? commaMessages.onboarding_shortcut_space() : keyText(key)]),
];

interface ShortcutKeycap {
  id: string;
  text: string;
}

type ShortcutCaptureState =
  | { kind: "idle" }
  | { keycaps?: ShortcutKeycap[]; kind: "editing" }
  | {
      code: string;
      keycaps: ShortcutKeycap[];
      kind: "preview";
      shortcut: SettingsShortcutChordValue;
    };

const modifierKeycaps = (
  modifiers: SettingsShortcutValue["modifiers"]
): ShortcutKeycap[] => [
  ...(modifiers.control ? [{ id: "control", text: "⌃" }] : []),
  ...(modifiers.alt ? [{ id: "alt", text: "⌥" }] : []),
  ...(modifiers.shift ? [{ id: "shift", text: "⇧" }] : []),
  ...(modifiers.meta ? [{ id: "meta", text: "⌘" }] : []),
];

const shortcutKeycaps = ({ key, modifiers }: SettingsShortcutChordValue) => [
  ...modifierKeycaps(modifiers),
  ...(key === null ? [] : [{ id: `key-${key}`, text: keyText(key) }]),
];

const emptyShortcutKeycaps: ShortcutKeycap[] = [
  { id: "empty-0", text: "-" },
  { id: "empty-1", text: "-" },
];

const valueKeycaps = (value: SettingsShortcutChordValue | null) =>
  value === null ? emptyShortcutKeycaps : shortcutKeycaps(value);

const shortcutModifiers = (event: KeyboardEvent<HTMLButtonElement>) => ({
  alt: event.altKey,
  control: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const hasPrimaryModifier = (modifiers: SettingsShortcutValue["modifiers"]) =>
  modifiers.alt || modifiers.control || modifiers.meta;

const modifierCount = (modifiers: SettingsShortcutValue["modifiers"]) =>
  [modifiers.alt, modifiers.control, modifiers.meta, modifiers.shift].filter(Boolean)
    .length;

const noModifiers = { alt: false, control: false, meta: false, shift: false };

const isModifierKey = (event: KeyboardEvent<HTMLButtonElement>) =>
  event.key === "Alt" ||
  event.key === "Control" ||
  event.key === "Meta" ||
  event.key === "Shift";

export const formatSettingsShortcut = (shortcut: SettingsShortcutChordValue) =>
  shortcutParts(shortcut).join(" + ");

export const SettingsShortcut = (props: SettingsShortcutProps) => {
  const {
    allowModifierOnly = false,
    ariaLabel,
    className,
    clearLabel: suppliedClearLabel,
    disabled = false,
    emptyLabel: suppliedEmptyLabel,
    errorMessage,
    onClear,
    recordingLabel: suppliedRecordingLabel,
    value,
  } = props;
  // Modifier-only values are produced only with `allowModifierOnly`, which is
  // when `onChange` accepts them.
  const onChange = props.onChange as
    | ((shortcut: SettingsShortcutChordValue) => Promise<void> | void)
    | undefined;
  const messages = useCommaMessages();
  const clearLabel = suppliedClearLabel ?? messages.ui_shortcut_clear();
  const emptyLabel = suppliedEmptyLabel ?? messages.ui_shortcut_not_set();
  const recordingLabel = suppliedRecordingLabel ?? messages.settings_press_shortcut();
  const [capture, setCapture] = useState<ShortcutCaptureState>({ kind: "idle" });
  const [optimisticValue, setOptimisticValue] = useState<
    { value: SettingsShortcutChordValue | null } | undefined
  >();
  const commitOperationRef = useRef(0);
  // Modifier-only capture: the most modifiers held at once in this gesture,
  // and whether a regular key joined them (then it is not modifier-only).
  const modifierChordRef = useRef({ keyPressed: false, peak: noModifiers });
  const controlRef = useRef<HTMLButtonElement>(null);
  const pending = optimisticValue !== undefined;
  const controlDisabled = disabled || pending;
  const nativeDisabled = disabled && !pending;
  const recording = capture.kind !== "idle" && !controlDisabled;
  const displayedValue = optimisticValue === undefined ? value : optimisticValue.value;
  const keycaps = !recording
    ? valueKeycaps(displayedValue)
    : (capture.keycaps ?? valueKeycaps(displayedValue));
  const visualState =
    recording && capture.kind === "editing"
      ? "editing"
      : recording && capture.kind === "preview"
        ? "recording"
        : errorMessage
          ? "error"
          : controlDisabled
            ? "disabled"
            : "idle";
  const showClear =
    recording &&
    capture.kind === "editing" &&
    displayedValue !== null &&
    onClear !== undefined;

  useEffect(() => {
    if (!disabled) return;

    setCapture((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, [disabled]);

  const trackOptimisticValue = (
    nextValue: SettingsShortcutChordValue | null,
    changeResult: Promise<void> | void
  ) => {
    const operation = ++commitOperationRef.current;
    if (changeResult !== undefined) {
      setOptimisticValue({ value: nextValue });
      const finishCommit = () => {
        if (commitOperationRef.current === operation) {
          setOptimisticValue(undefined);
        }
      };
      void changeResult.then(finishCommit, finishCommit);
    } else {
      setOptimisticValue(undefined);
    }
  };

  const clearShortcut = () => {
    if (controlDisabled || !onClear || displayedValue === null) return;

    trackOptimisticValue(null, onClear());
    setCapture({ kind: "idle" });
    controlRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (controlDisabled || !recording) return;
    if (event.key === "Tab") return;

    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapture({ kind: "idle" });
      return;
    }

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      clearShortcut();
      return;
    }

    const modifiers = shortcutModifiers(event);
    if (isModifierKey(event)) {
      const chord = modifierChordRef.current;
      if (modifierCount(modifiers) > modifierCount(chord.peak)) chord.peak = modifiers;
      const modifierPreviewKeycaps = modifierKeycaps(modifiers);
      if (capture.kind === "preview" && modifierPreviewKeycaps.length > 0) return;

      setCapture({
        kind: "editing",
        ...(modifierPreviewKeycaps.length > 0
          ? { keycaps: modifierPreviewKeycaps }
          : {}),
      });
      return;
    }

    modifierChordRef.current.keyPressed = true;
    const key = physicalShortcutKey(event.code);
    if (!hasPrimaryModifier(modifiers)) {
      setCapture({ kind: "editing" });
      return;
    }
    if (!key) return;

    const shortcut = { key, modifiers };
    setCapture({
      code: event.code,
      keycaps: shortcutKeycaps(shortcut),
      kind: "preview",
      shortcut,
    });
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (controlDisabled || !recording) return;

    event.preventDefault();
    event.stopPropagation();

    if (isModifierKey(event)) {
      const held = shortcutModifiers(event);
      if (modifierCount(held) === 0) {
        const { keyPressed, peak } = modifierChordRef.current;
        modifierChordRef.current = { keyPressed: false, peak: noModifiers };
        if (allowModifierOnly && !keyPressed && modifierCount(peak) >= 2) {
          const shortcut = { key: null, modifiers: peak };
          trackOptimisticValue(shortcut, onChange?.(shortcut));
          setCapture({ kind: "idle" });
          return;
        }
      }
      const modifierPreviewKeycaps = modifierKeycaps(held);
      if (capture.kind === "preview" && modifierPreviewKeycaps.length > 0) return;

      setCapture({
        kind: "editing",
        ...(modifierPreviewKeycaps.length > 0
          ? { keycaps: modifierPreviewKeycaps }
          : {}),
      });
      return;
    }
    if (capture.kind !== "preview" || capture.code !== event.code) return;

    trackOptimisticValue(capture.shortcut, onChange?.(capture.shortcut));
    setCapture({ kind: "idle" });
  };

  const handleControlBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setCapture({ kind: "idle" });
  };

  return (
    <div className="settings-shortcut-field">
      <div className="settings-shortcut__control" onBlur={handleControlBlur}>
        <button
          aria-busy={pending || undefined}
          aria-disabled={controlDisabled || undefined}
          aria-label={`${ariaLabel}: ${
            recording
              ? recordingLabel
              : displayedValue === null
                ? emptyLabel
                : formatSettingsShortcut(displayedValue)
          }`}
          aria-pressed={recording}
          className={cx("settings-shortcut", className)}
          data-no-press-feedback
          data-pending={pending ? "true" : undefined}
          data-slot="settings-shortcut"
          data-state={visualState}
          disabled={nativeDisabled}
          onClick={() => {
            if (controlDisabled) return;
            if (capture.kind === "idle") {
              modifierChordRef.current = { keyPressed: false, peak: noModifiers };
            }
            setCapture((current) =>
              current.kind === "idle" ? { kind: "editing" } : current
            );
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          ref={controlRef}
          type="button"
        >
          <span aria-hidden="true" className="settings-shortcut__keycaps">
            {keycaps.map((keycap) => (
              <span className="settings-shortcut__keycap-shell" key={keycap.id}>
                <kbd className="settings-shortcut__keycap">
                  {keycapSymbol(keycap.text)}
                </kbd>
              </span>
            ))}
          </span>
        </button>
        {showClear ? (
          <button
            aria-label={clearLabel}
            className="settings-shortcut__clear"
            data-no-press-feedback
            data-slot="settings-shortcut-clear"
            onClick={clearShortcut}
            title={clearLabel}
            type="button"
          >
            <CircleMinusIcon className="settings-shortcut__clear-icon" />
          </button>
        ) : null}
      </div>
      {errorMessage && !recording ? (
        <p className="settings-shortcut__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
};
