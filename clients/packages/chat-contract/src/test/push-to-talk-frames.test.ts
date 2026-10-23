import { describe, expect, it } from "vitest";
import {
  chatProtocolVersion,
  sideChatClientFrameSchema,
  sideChatHostFrameSchema,
} from "../index";

const envelope = { protocolVersion: chatProtocolVersion, requestId: "req_1" };

describe("push-to-talk side chat frames", () => {
  it("lets Main register and clear the hold-to-talk shortcut", () => {
    expect(
      sideChatHostFrameSchema.parse({
        ...envelope,
        keyCode: 49,
        kind: "push-to-talk.shortcut",
        modifiers: (1 << 12) | (1 << 11),
      })
    ).toMatchObject({ keyCode: 49, kind: "push-to-talk.shortcut" });

    // A null binding travels without a keyCode, like the Side Chat shortcut.
    const cleared = sideChatHostFrameSchema.parse({
      ...envelope,
      kind: "push-to-talk.shortcut",
      modifiers: 0,
    });
    expect(cleared).not.toHaveProperty("keyCode");
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
    expect(
      sideChatClientFrameSchema.safeParse({
        ...envelope,
        kind: "push-to-talk.released",
      }).success
    ).toBe(true);
  });

  it("keeps the press and release events helper-to-Main only", () => {
    expect(
      sideChatHostFrameSchema.safeParse({ ...envelope, kind: "push-to-talk.pressed" })
        .success
    ).toBe(false);
    expect(
      sideChatClientFrameSchema.safeParse({
        ...envelope,
        keyCode: 49,
        kind: "push-to-talk.shortcut",
        modifiers: 0,
      }).success
    ).toBe(false);
  });
});
