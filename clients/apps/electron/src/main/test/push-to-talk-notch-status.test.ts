import type { NotchHostEvent, NotchVoiceTurn } from "@comma/native-bridge";
import { describe, expect, it, vi } from "vitest";
import {
  NotchPushToTalkStatus,
  notchLevelIntervalMs,
  type PushToTalkNotch,
} from "../push-to-talk/notch-status";
import type { PushToTalkErrorAction } from "../push-to-talk/types";
import { FakeClock } from "./support/fake-clock";

class FakeNotch implements PushToTalkNotch {
  shown = true;
  writes: Array<NotchVoiceTurn | null> = [];
  listeners = new Set<(event: NotchHostEvent) => void>();

  visible() {
    return this.shown;
  }

  setVoice(turn: NotchVoiceTurn | null) {
    this.writes.push(turn);
    return Promise.resolve({ type: "ack" });
  }

  onEvent(listener: (event: NotchHostEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: NotchHostEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function createStatus(locale: "en" | "pt-BR" | "zh-CN" = "en") {
  const notch = new FakeNotch();
  const clock = new FakeClock();
  const actions: PushToTalkErrorAction[] = [];
  const status = new NotchPushToTalkStatus({
    clock,
    locale,
    notch,
    onAction: (action) => actions.push(action),
  });
  return { actions, clock, notch, status };
}

describe("NotchPushToTalkStatus", () => {
  it("projects live call states and gives the Notch back when idle", () => {
    const { notch, status } = createStatus("pt-BR");

    status.set({ kind: "listening" });
    status.set({ kind: "thinking" });
    status.set({ kind: "speaking" });
    status.set({ kind: "ready" });
    status.set(null);

    expect(notch.writes.map((turn) => turn?.state ?? null)).toEqual([
      "listening",
      "thinking",
      "speaking",
      "busy",
      null,
    ]);
  });

  it("offers each error's action and routes the Notch's choice back to the controller", () => {
    const { actions, notch, status } = createStatus();

    status.set({ code: "microphone_denied", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({
      action: { id: "open-microphone-settings" },
      state: "error",
    });
    status.set({ code: "screen_denied", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({
      action: { id: "open-screen-recording-settings" },
      state: "error",
    });
    status.set({ code: "busy", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({ state: "error" });
    expect(notch.writes.at(-1)?.action).toBeUndefined();
    status.set({ code: "plan_limit", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({ state: "error" });
    expect(notch.writes.at(-1)?.action).toBeUndefined();
    status.set({ code: "context_failed", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({ state: "error" });
    status.set({ code: "call_failed", kind: "error" });
    expect(notch.writes.at(-1)).toMatchObject({ state: "error" });

    status.set({ kind: "ready" });
    expect(notch.writes.at(-1)).toMatchObject({
      action: { id: "open-side-chat" },
      state: "busy",
    });

    notch.emit({
      payload: { action: "voice:action", value: "open-side-chat" },
      type: "action",
    });
    notch.emit({
      payload: { action: "voice:action", value: "rm -rf" },
      type: "action",
    });
    notch.emit({
      payload: { action: "task:open", value: "open-side-chat" },
      type: "action",
    });
    expect(actions).toEqual(["open-side-chat"]);

    // Once the state is cleared, a late click on it does nothing.
    status.set(null);
    notch.emit({
      payload: { action: "voice:action", value: "open-side-chat" },
      type: "action",
    });
    expect(actions).toHaveLength(1);
  });

  it("sends the microphone level at most ~20 times a second, keeping the latest", () => {
    const { clock, notch, status } = createStatus();
    status.set({ kind: "listening" });
    notch.writes = [];

    status.setLevel(0.2);
    for (const level of [0.3, 0.5, 0.9, 1.7]) {
      clock.advance(5);
      status.setLevel(level);
    }
    expect(notch.writes.map((turn) => turn?.level)).toEqual([0.2]);

    clock.advance(notchLevelIntervalMs);
    expect(notch.writes.map((turn) => turn?.level)).toEqual([0.2, 1]);

    // An unchanged level costs nothing.
    clock.advance(notchLevelIntervalMs);
    status.setLevel(1);
    clock.advance(notchLevelIntervalMs);
    expect(notch.writes).toHaveLength(2);
  });

  it("ignores levels outside listening and drops a pending level when the state moves on", () => {
    const { clock, notch, status } = createStatus();
    status.setLevel(0.6);
    expect(notch.writes).toEqual([]);

    status.set({ kind: "listening" });
    status.setLevel(0.4);
    status.setLevel(0.8);
    status.set({ kind: "thinking" });
    clock.advance(notchLevelIntervalMs * 2);
    status.setLevel(0.5);

    expect(notch.writes.map((turn) => turn?.state)).toEqual([
      "listening",
      "listening",
      "thinking",
    ]);
    expect(clock.pending()).toBe(0);
  });

  it("reports whether the Notch is on and stops listening when disposed", () => {
    const { actions, notch, status } = createStatus("zh-CN");
    expect(status.visible()).toBe(true);
    notch.shown = false;
    expect(status.visible()).toBe(false);

    status.set({ code: "microphone_denied", kind: "error" });
    status.dispose();
    expect(notch.listeners.size).toBe(0);
    notch.emit({
      payload: { action: "voice:action", value: "open-microphone-settings" },
      type: "action",
    });
    expect(actions).toEqual([]);
  });

  it("resumes level updates after the Notch rejects a write", async () => {
    const { clock, notch, status } = createStatus();
    vi.spyOn(notch, "setVoice").mockRejectedValueOnce(new Error("gone"));
    status.set({ kind: "listening" });
    await Promise.resolve();

    status.setLevel(0.8);
    clock.advance(notchLevelIntervalMs);
    expect(notch.writes.at(-1)).toMatchObject({
      level: 0.8,
      state: "listening",
    });
  });
});
