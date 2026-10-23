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
  const actions: [PushToTalkErrorAction, { transcript: string | undefined }][] = [];
  const status = new NotchPushToTalkStatus({
    clock,
    locale,
    notch,
    onAction: (action, context) => actions.push([action, context]),
  });
  return { actions, clock, notch, status };
}

describe("NotchPushToTalkStatus", () => {
  it("shows each turn state in the reader's language and gives the Notch back", () => {
    const { notch, status } = createStatus("pt-BR");

    status.set({ kind: "listening" });
    status.set({ kind: "transcribing" });
    status.set({ kind: "thinking" });
    status.set({ kind: "speaking" });
    status.set({ kind: "busy" });
    status.set(null);

    expect(notch.writes).toEqual([
      { level: 0, message: "Ouvindo", state: "listening" },
      { message: "Transcrevendo", state: "transcribing" },
      { message: "Pensando", state: "thinking" },
      { message: "Falando", state: "speaking" },
      { message: "Aguarde a pergunta atual", state: "busy" },
      null,
    ]);
  });

  it("offers each error's action and routes the Notch's choice back to the controller", () => {
    const { actions, notch, status } = createStatus();

    status.set({ code: "microphone_denied", kind: "error" });
    expect(notch.writes.at(-1)).toEqual({
      action: { id: "open-microphone-settings", label: "Open System Settings" },
      message: "Comma needs Microphone access",
      state: "error",
    });
    status.set({ code: "transcription_unavailable", kind: "error" });
    expect(notch.writes.at(-1)?.action).toEqual({
      id: "open-meeting-settings",
      label: "Open Meeting settings",
    });
    // Copying needs the words that were heard.
    status.set({ code: "send_failed", kind: "error" });
    expect(notch.writes.at(-1)).toEqual({
      message: "Couldn’t send your question",
      state: "error",
    });
    status.set({ code: "send_failed", kind: "error", transcript: "what is this?" });
    expect(notch.writes.at(-1)?.action).toEqual({
      id: "copy-transcript",
      label: "Copy transcript",
    });
    expect(JSON.stringify(notch.writes)).not.toContain("what is this?");

    notch.emit({
      payload: { action: "voice:action", value: "copy-transcript" },
      type: "action",
    });
    notch.emit({
      payload: { action: "voice:action", value: "rm -rf" },
      type: "action",
    });
    notch.emit({
      payload: { action: "task:open", value: "copy-transcript" },
      type: "action",
    });
    // The words to copy go to Main's action handler, never to the Notch.
    expect(actions).toEqual([["copy-transcript", { transcript: "what is this?" }]]);

    // Once the error is gone, a late click on it does nothing.
    status.set(null);
    notch.emit({
      payload: { action: "voice:action", value: "copy-transcript" },
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
    expect(notch.writes).toEqual([
      { level: 0.2, message: "Listening", state: "listening" },
    ]);

    clock.advance(notchLevelIntervalMs);
    expect(notch.writes).toEqual([
      { level: 0.2, message: "Listening", state: "listening" },
      { level: 1, message: "Listening", state: "listening" },
    ]);

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
    status.set({ kind: "transcribing" });
    clock.advance(notchLevelIntervalMs * 2);
    status.setLevel(0.5);

    expect(notch.writes.map((turn) => turn?.state)).toEqual([
      "listening",
      "listening",
      "transcribing",
    ]);
    expect(clock.pending()).toBe(0);
  });

  it("reports whether the Notch is on and stops listening when disposed", () => {
    const { actions, notch, status } = createStatus("zh-CN");
    expect(status.visible()).toBe(true);
    notch.shown = false;
    expect(status.visible()).toBe(false);

    status.set({ code: "microphone_denied", kind: "error" });
    expect(notch.writes.at(-1)?.message).toBe("Comma 需要麦克风权限");
    status.dispose();
    expect(notch.listeners.size).toBe(0);
    notch.emit({
      payload: { action: "voice:action", value: "open-microphone-settings" },
      type: "action",
    });
    expect(actions).toEqual([]);
  });

  it("keeps the turn going when a Notch write fails", async () => {
    const { notch, status } = createStatus();
    const failure = vi
      .spyOn(notch, "setVoice")
      .mockRejectedValueOnce(new Error("gone"));
    expect(() => status.set({ kind: "thinking" })).not.toThrow();
    await Promise.resolve();
    expect(failure).toHaveBeenCalledOnce();
  });
});
