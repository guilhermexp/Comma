import type { PushToTalkShortcutBinding, SideChatShortcut } from "@comma/native-bridge";
import { sameAppKeyModifiers, type AppKeybinding, type AppKeyCode } from "@comma/ui";
import {
  appShortcutIds,
  type AppShortcutBindings,
  type AppShortcutId,
} from "./appShortcutRegistry";

const sideChatKeyCode = (shortcut: SideChatShortcut): AppKeyCode | "Space" =>
  shortcut.key === "space"
    ? "Space"
    : shortcut.key === "comma"
      ? "Comma"
      : /^[0-9]$/.test(shortcut.key)
        ? (`Digit${shortcut.key}` as AppKeyCode)
        : (`Key${shortcut.key.toLocaleUpperCase()}` as AppKeyCode);

/**
 * Global chords: a key with modifiers, or (Talk to agent only) `key: null`
 * for modifiers held alone. A modifier-only chord never equals one with a
 * key: the key cancels the held chord and still reaches its owner.
 */
type GlobalShortcutBinding = PushToTalkShortcutBinding;

const hasKey = (shortcut: GlobalShortcutBinding): shortcut is SideChatShortcut =>
  shortcut !== null && shortcut.key !== null;

export const appBindingConflictsWithSideChatShortcut = (
  binding: AppKeybinding | null,
  shortcut: GlobalShortcutBinding
) =>
  hasKey(shortcut) &&
  binding?.kind === "chord" &&
  binding.stroke.code === sideChatKeyCode(shortcut) &&
  sameAppKeyModifiers(binding.stroke.modifiers, shortcut.modifiers);

export const findAppShortcutConflictForSideChat = (
  bindings: AppShortcutBindings,
  shortcut: GlobalShortcutBinding
): AppShortcutId | undefined =>
  appShortcutIds.find((id) =>
    appBindingConflictsWithSideChatShortcut(bindings[id], shortcut)
  );

export const sameGlobalShortcut = (
  left: GlobalShortcutBinding,
  right: GlobalShortcutBinding
) =>
  left !== null &&
  right !== null &&
  left.key === right.key &&
  sameAppKeyModifiers(left.modifiers, right.modifiers);

/** System-wide chords Comma registers outside its own windows. */
export type GlobalShortcutId = "open-comma" | "push-to-talk" | "side-chat";

/** The other global shortcut that already holds this chord, if any. */
export const findGlobalShortcutConflict = (
  shortcut: GlobalShortcutBinding,
  globals: Partial<Record<GlobalShortcutId, GlobalShortcutBinding>>
): GlobalShortcutId | undefined =>
  (Object.keys(globals) as GlobalShortcutId[]).find((id) =>
    sameGlobalShortcut(shortcut, globals[id] ?? null)
  );
