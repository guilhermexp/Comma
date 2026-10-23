import { describe, expect, it } from "vitest";
import {
  chatProtocolVersion,
  sideChatClientFrameSchema,
  sideChatHostFrameSchema,
} from "../index";

const envelope = { protocolVersion: chatProtocolVersion, requestId: "req_1" };

describe("push-to-talk side chat frames", () => {
  it("lets Main register a chord with a key, a modifier-only chord, or none", () => {
    const controlOption = (1 << 12) | (1 << 11);
    expect(
      sideChatHostFrameSchema.parse({
        ...envelope,
        binding: { keyCode: 49, modifiers: controlOption },
        kind: "push-to-talk.shortcut",
      })
    ).toMatchObject({ binding: { keyCode: 49 }, kind: "push-to-talk.shortcut" });
    // ⌃⌥ alone: a binding without keyCode.
    const chord = sideChatHostFrameSchema.parse({
      ...envelope,
      binding: { modifiers: controlOption },
      kind: "push-to-talk.shortcut",
    });
    expect(chord).toMatchObject({ binding: { modifiers: controlOption } });
    expect(chord).not.toHaveProperty("binding.keyCode");
    // Cleared: no binding at all.
    expect(
      sideChatHostFrameSchema.parse({ ...envelope, kind: "push-to-talk.shortcut" })
    ).not.toHaveProperty("binding");
    expect(
      sideChatHostFrameSchema.safeParse({
        ...envelope,
        kind: "push-to-talk.request-input-monitoring",
      }).success
    ).toBe(true);
  });

  it("reports press with the frontmost app and release from the helper", () => {
    expect(
      sideChatClientFrameSchema.parse({
        ...envelope,
        frontmostApp: { bundleId: "com.apple.Safari", name: "Safari" },
        kind: "push-to-talk.pressed",
      })
    ).toMatchObject({
      frontmostApp: { bundleId: "com.apple.Safari", name: "Safari" },
    });
    // No frontmost app (e.g. login window) and apps without a bundle id.
    expect(
      sideChatClientFrameSchema.safeParse({ ...envelope, kind: "push-to-talk.pressed" })
        .success
    ).toBe(true);
    expect(
      sideChatClientFrameSchema.safeParse({
        ...envelope,
        frontmostApp: { name: "script" },
        kind: "push-to-talk.pressed",
      }).success
    ).toBe(true);
    for (const cancelled of [false, true]) {
      expect(
        sideChatClientFrameSchema.safeParse({
          ...envelope,
          cancelled,
          kind: "push-to-talk.released",
        }).success
      ).toBe(true);
    }
    expect(
      sideChatClientFrameSchema.parse({
        ...envelope,
        inputMonitoring: "denied",
        kind: "push-to-talk.permission",
      })
    ).toMatchObject({ inputMonitoring: "denied" });
  });

  it("keeps the press and release events helper-to-Main only", () => {
    expect(
      sideChatHostFrameSchema.safeParse({ ...envelope, kind: "push-to-talk.pressed" })
        .success
    ).toBe(false);
    expect(
      sideChatClientFrameSchema.safeParse({
        ...envelope,
        binding: { keyCode: 49, modifiers: 0 },
        kind: "push-to-talk.shortcut",
      }).success
    ).toBe(false);
  });
});
