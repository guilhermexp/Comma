import { describe, expect, it, vi } from "vitest";
import { GptLiveVoice, type PushToTalkVoiceApi } from "../push-to-talk/live-voice";
import { PushToTalkVoiceWindow } from "../push-to-talk/voice-window";
import { FakeClock } from "./support/fake-clock";

const mocks = vi.hoisted(() => ({ created: vi.fn(), load: vi.fn(async () => {}) }));

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {};
    constructor() {
      mocks.created();
    }
    on() {
      return this;
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
vi.mock("../managed-window", () => ({ configureManagedWindow: mocks.load }));

describe("push-to-talk voice window", () => {
  it("reuses the loaded hidden window when the first gesture opens a call", async () => {
    const window = new PushToTalkVoiceWindow({
      logger: { error: vi.fn(), warn: vi.fn() },
      preloadPath: "/preload.js",
      registry: {} as ConstructorParameters<
        typeof PushToTalkVoiceWindow
      >[0]["registry"],
      secure: vi.fn(),
      surfaces: {} as ConstructorParameters<
        typeof PushToTalkVoiceWindow
      >[0]["surfaces"],
      url: "http://localhost/push-to-talk-voice",
    });
    const voice = new GptLiveVoice({
      api: () => ({}) as PushToTalkVoiceApi,
      resolveTarget: async () => ({
        workspaceId: "w",
        groupId: "g",
        conversationId: "c",
      }),
      runOwned: (handler) => handler(),
      host: {
        open: () => window.open(),
        close: () => window.close(),
        publish: vi.fn(),
      },
      clock: new FakeClock(),
    });

    await voice.warm();
    expect(mocks.created).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await voice.open();
    expect(mocks.created).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    voice.destroy();
  });
});
