import {
  defaultOpenCommaShortcut,
  defaultPushToTalkShortcut,
  defaultSideChatShortcut,
} from "@comma/native-bridge";
import { chordKeybinding, sequenceKeybinding } from "@comma/ui";
import { describe, expect, it } from "vitest";
import {
  appBindingConflictsWithSideChatShortcut,
  findAppShortcutConflictForSideChat,
  findGlobalShortcutConflict,
} from "../sideChatShortcutConflict";
import { createDefaultAppShortcutBindings } from "../appShortcutRegistry";

describe("sideChatShortcutConflict", () => {
  it("compares the Side Chat accelerator with app chords", () => {
    expect(
      appBindingConflictsWithSideChatShortcut(
        chordKeybinding("KeyZ", { control: true }),
        defaultSideChatShortcut
      )
    ).toBe(true);
    expect(
      appBindingConflictsWithSideChatShortcut(
        chordKeybinding("KeyZ", { meta: true }),
        defaultSideChatShortcut
      )
    ).toBe(false);
    expect(
      appBindingConflictsWithSideChatShortcut(
        sequenceKeybinding("KeyG", "KeyZ"),
        defaultSideChatShortcut
      )
    ).toBe(false);
  });

  it("finds the app owner when Side Chat is edited to an app chord", () => {
    const bindings = createDefaultAppShortcutBindings("macos");

    expect(
      findAppShortcutConflictForSideChat(bindings, {
        key: "b",
        modifiers: {
          alt: false,
          control: false,
          meta: true,
          shift: false,
        },
      })
    ).toBe("toggle-left-sidebar");
  });

  it("names the global shortcut a Talk to agent chord collides with", () => {
    const globals = {
      "open-comma": defaultOpenCommaShortcut,
      "side-chat": defaultSideChatShortcut,
    };

    expect(
      findGlobalShortcutConflict(defaultPushToTalkShortcut, globals)
    ).toBeUndefined();
    expect(findGlobalShortcutConflict(defaultSideChatShortcut, globals)).toBe(
      "side-chat"
    );
    expect(
      findGlobalShortcutConflict(
        // Same chord with the modifiers listed in another order.
        {
          key: "comma",
          modifiers: { shift: false, meta: false, control: false, alt: true },
        },
        globals
      )
    ).toBe("open-comma");
    // A cleared shortcut never conflicts, and a cleared owner holds no chord.
    expect(findGlobalShortcutConflict(null, globals)).toBeUndefined();
    expect(
      findGlobalShortcutConflict(defaultSideChatShortcut, { "side-chat": null })
    ).toBeUndefined();
  });

  it("keeps the default Talk to agent chord free of every default app shortcut", () => {
    for (const platform of ["macos", "windows"] as const) {
      expect(
        findAppShortcutConflictForSideChat(
          createDefaultAppShortcutBindings(platform),
          defaultPushToTalkShortcut
        )
      ).toBeUndefined();
    }
  });
});
