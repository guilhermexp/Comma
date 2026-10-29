import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@comma/chat-contract";
import type { VoiceCallEvent } from "@comma/app/api";
import { PushToTalkController } from "../push-to-talk/controller";
import {
  GptLiveVoice,
  type PushToTalkCallEvent,
  type PushToTalkLiveCall,
} from "../push-to-talk/live-voice";
import type { PushToTalkScreenCaptureResult } from "../push-to-talk/screen-capture";
import type {
  PushToTalkFrontmostApp,
  PushToTalkSettings,
  PushToTalkStroke,
  PushToTalkTurnState,
} from "../push-to-talk/types";
import { FakeClock } from "./support/fake-clock";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const target = { workspaceId: "wsp_1", groupId: "grp_1", conversationId: "cnv_home" };
const settings: PushToTalkSettings = {
  enabled: true,
  sendScreen: true,
  shortcut: {
    key: null,
    modifiers: { alt: true, control: true, meta: false, shift: false },
  },
};
const safari = { name: "Safari", bundleId: "com.apple.Safari" };
const captured: PushToTalkScreenCaptureResult = {
  status: "captured",
  finalize: () => ({
    width: 2560,
    height: 1600,
    cursor: { x: 50, y: 60 },
    images: [
      { name: "screen.png", mediaType: "image/png", data: Buffer.from([1, 2, 3]) },
      { name: "detail.png", mediaType: "image/png", data: Buffer.from([4, 5]) },
    ],
  }),
};
class Call implements PushToTalkLiveCall {
  listeners = new Set<(event: PushToTalkCallEvent) => void>();
  active = false;
  sessions = 0;
  listening = false;
  close = vi.fn(() => {
    this.active = false;
    this.listening = false;
  });
  beginContext = vi.fn(async (_contextId: number): Promise<void> => undefined);
  appendContext = vi.fn(
    async (_input: Parameters<PushToTalkLiveCall["appendContext"]>[0]): Promise<void> =>
      undefined
  );
  cancelContext = vi.fn((_contextId: number): void => undefined);
  failContext = vi.fn(async (_contextId: number): Promise<void> => undefined);
  open = vi.fn(async () => {
    if (!this.active) this.sessions++;
    this.active = true;
    return target;
  });
  setListening(value: boolean) {
    this.listening = value;
  }
  onEvent(listener: (event: PushToTalkCallEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: PushToTalkCallEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
function setup(
  options: {
    capture?: () => Promise<PushToTalkScreenCaptureResult>;
    sendScreen?: boolean;
    notch?: boolean;
  } = {}
) {
  const clock = new FakeClock();
  const voice = new Call();
  const order: string[] = [];
  let press:
    | ((input: { frontmostApp: PushToTalkFrontmostApp | null }) => void)
    | undefined;
  let release: ((input: { cancelled: boolean }) => void) | undefined;
  let restart: (() => void) | undefined;
  let click: (() => void) | undefined;
  const power = new Map<string, () => void>();
  let currentUser = "owner";
  let status: PushToTalkTurnState | null = null;
  let companionState: PushToTalkTurnState | null = null;
  let caption: string | null = null;
  let visible = false;
  const hotkey = {
    register: vi.fn(async () => ({ inputMonitoring: "granted" as const })),
    requestInputMonitoring: async () => undefined,
    onInputMonitoring: () => () => undefined,
    onPressed: (fn: typeof press) => {
      press = fn;
      return () => {
        press = undefined;
      };
    },
    onReleased: (fn: typeof release) => {
      release = fn;
      return () => {
        release = undefined;
      };
    },
    onHelperRestarted: (fn: () => void) => {
      restart = fn;
      return () => {
        restart = undefined;
      };
    },
  };
  const capture = vi.fn(async () => {
    order.push("capture");
    return options.capture ? options.capture() : captured;
  });
  const screenRecording = {
    status: vi.fn(() => "granted"),
    request: vi.fn(async () => undefined),
  };
  const levels: number[] = [];
  const companion = {
    show: (input: { state: PushToTalkTurnState }) => {
      visible = true;
      companionState = input.state;
    },
    setState: (state: PushToTalkTurnState) => {
      companionState = state;
    },
    setDrawing: vi.fn(),
    setLevel: (level: number) => levels.push(level),
    setCaption: (text: string | null) => {
      if (!visible && text !== null) return;
      caption = text;
    },
    hide: vi.fn((input?: { immediate?: boolean }) => {
      order.push(input?.immediate ? "hide immediate" : "hide");
      visible = false;
    }),
    onStroke: (_fn: (stroke: PushToTalkStroke | null) => void) => () => undefined,
    onCaptionClick: (fn: () => void) => {
      click = fn;
      return () => {
        click = undefined;
      };
    },
  };
  const openSideChat = vi.fn();
  const config = { ...settings, sendScreen: options.sendScreen ?? true };
  const deps: ConstructorParameters<typeof PushToTalkController>[0] = {
    hotkey,
    voice,
    clock,
    companion,
    screenRecording,
    screen: {
      locate: () => ({
        displayId: 2,
        cursor: { x: 2000, y: 500 },
        bounds: { x: 1440, y: 0, width: 1728, height: 1117 },
        scaleFactor: 2,
      }),
      capture,
    },
    status: {
      visible: () => options.notch ?? true,
      set: (state) => {
        status = state;
      },
      setLevel: (level) => levels.push(level),
    },
    powerMonitor: {
      on: (event, fn) => power.set(event, fn),
      removeListener: (event) => power.delete(event),
    },
    openSideChat,
    isCurrentCaller: (userId) => userId === currentUser,
    settings: config,
    sessionGeneration: 1,
  };
  const controller = new PushToTalkController(deps);
  controller.start();
  const respond = async () => {
    voice.emit({
      kind: "caption",
      text: "Tudo certo. Próxima frase.",
      turn: 1,
      final: true,
    });
    voice.emit({ kind: "audible" });
    voice.emit({ kind: "silent" });
    clock.advance(2_000);
    await flush();
  };
  return {
    deps,
    controller,
    config,
    clock,
    voice,
    order,
    capture,
    screenRecording,
    companion,
    openSideChat,
    levels,
    press: () => press?.({ frontmostApp: safari }),
    release: (cancelled = false) => release?.({ cancelled }),
    restart: () => restart?.(),
    click: () => click?.(),
    power,
    setUser: (id: string) => {
      currentUser = id;
    },
    status: () => status,
    companionState: () => companionState,
    caption: () => caption,
    visible: () => visible,
    respond,
  };
}

function setupRealTransport(options: { notch?: boolean } = {}) {
  const h = setup({ sendScreen: false, ...options });
  h.controller.dispose();
  const batches: VoiceCallEvent[][] = [];
  let cursor = 0;
  const api = {
    startVoiceCall: vi.fn(async () => ({ call_id: "vc_real", sdp: "sdp_answer" })),
    appendVoiceCallContext: vi.fn(async () => ({ accepted: true as const })),
    uploadGroupFile: vi.fn(async () => ({
      path: "/uploads/file.png",
      name: "screen.png",
      size: 10,
    })),
    voiceCallEvents: vi.fn(async () => {
      const events = batches.shift() ?? [];
      cursor += events.length;
      return { events, cursor, truncated: false };
    }),
    endVoiceCall: vi.fn(async () => ({})),
  };
  const realVoice = new GptLiveVoice({
    api: () => api,
    resolveTarget: async () => target,
    runOwned: async (fn) => fn(),
    host: { open: vi.fn(async () => undefined), publish: vi.fn() },
    clock: h.clock,
  });
  const controller = new PushToTalkController({ ...h.deps, voice: realVoice });
  controller.start();
  return {
    h,
    api,
    batches,
    realVoice,
    controller,
    connect: async () => {
      await flush();
      const { generation } = realVoice.voiceSession();
      await realVoice.voiceOffer({ generation, sdp: "sdp_offer" });
      realVoice.voiceReport({ generation, event: "connected" });
      await flush();
    },
  };
}
function lateReply(text = "The Router finished.", caller = "owner") {
  const message: ChatMessage = {
    messageId: "late_1",
    role: "assistant",
    actorRole: "router",
    source: "server",
    delivery: "sent",
    text,
    attachments: [],
    refs: [],
  };
  return {
    target,
    messages: [message],
    conversation: {
      group_id: target.groupId,
      id: target.conversationId,
      title: "Home",
      status: "active",
      kind: "user_chat" as const,
      messages: [
        {
          message_id: message.messageId,
          actor_type: "agent",
          role_label: "router",
          kind: "message",
          content: [],
          metadata: {
            event_type: "voice.reply",
            voice_mode: "push_to_talk",
            voice_call_id: "vc_1",
            voice_delegation_id: "del_1",
            voice_caller_user_id: caller,
          },
        },
      ],
    },
  };
}

describe("push-to-talk live call controller", () => {
  it("invalidates a previous pending capture without hiding or contaminating the new gesture", async () => {
    const previousCapture = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    let captures = 0;
    const h = setup({
      capture: () =>
        ++captures === 1 ? previousCapture.promise : Promise.resolve(captured),
    });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    expect(h.visible()).toBe(true);
    h.clock.advance(400);
    h.release();
    await flush();
    previousCapture.resolve(captured);
    await flush();
    expect(
      h.voice.appendContext.mock.calls.map(([context]) => context.contextId)
    ).toEqual([2]);
    h.controller.dispose();
  });

  it("shows listening from a cold press without waiting for media or admission", async () => {
    const admitted = Promise.withResolvers<void>();
    const h = setup({ sendScreen: false });
    h.voice.beginContext.mockReturnValueOnce(admitted.promise);
    h.press();
    expect(h.status()?.kind).toBe("listening");
    expect(h.companionState()?.kind).toBe("listening");
    await flush();
    expect(h.voice.active).toBe(true);
    h.voice.emit({ kind: "level", level: 0.4 });
    expect(h.levels).toEqual([0.4, 0.4]);
    h.voice.emit({ kind: "connected" });
    expect(h.status()?.kind).toBe("listening");
    admitted.resolve();
    await flush();
    h.voice.emit({ kind: "level", level: 0.6 });
    expect(h.voice.listening).toBe(true);
    expect(h.status()?.kind).toBe("listening");
    expect(h.levels).toEqual([0.4, 0.4, 0.6, 0.6]);
    h.controller.dispose();
  });
  it("mutes on release without waiting for the screenshot and appends its images later", async () => {
    const gate = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => gate.promise });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    expect(h.voice.listening).toBe(false);
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    gate.resolve(captured);
    await flush();
    expect(h.voice.appendContext.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ name: "screen.png" }, { name: "detail.png" }],
    });
    expect(h.voice.listening).toBe(false);
    expect(h.openSideChat).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("listens to a new gesture while the previous context is uploading", async () => {
    const h = setup({ sendScreen: false });
    const sending = Promise.withResolvers<void>();
    h.voice.appendContext.mockReturnValueOnce(sending.promise);
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.voice.emit({ kind: "caption", text: "A reply.", turn: 1, final: false });
    h.voice.emit({ kind: "audible" });
    h.press();
    await flush();
    expect(h.caption()).toBeNull();
    expect(h.voice.listening).toBe(true);
    expect(h.voice.sessions).toBe(1);
    h.clock.advance(400);
    h.release();
    await flush();
    sending.resolve();
    await flush();
    expect(h.voice.appendContext).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });
  it("bounds outstanding captures and never forwards obsolete screenshots", async () => {
    const captures = [
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
    ];
    let next = 0;
    const h = setup({ capture: () => captures[next++]!.promise });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    expect(h.voice.listening).toBe(true);
    expect(h.capture).toHaveBeenCalledTimes(2);
    h.clock.advance(400);
    h.release();
    captures.forEach((capture) => capture.resolve(captured));
    await flush();
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    h.controller.dispose();
  });
  it("keeps cancelled captures in the context budget until they actually settle", async () => {
    const captures = [
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
    ];
    let next = 0;
    const h = setup({ capture: () => captures[next++]!.promise });
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.controller.update(h.config, 2);
    h.press();
    await flush();
    expect(h.voice.listening).toBe(true);
    expect(h.capture).toHaveBeenCalledTimes(2);
    captures.forEach((capture) => capture.resolve(captured));
    await flush();
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    h.controller.dispose();
  });
  it("arms warm idle cleanup when a gesture is rejected for context capacity", async () => {
    const captures = [
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
      Promise.withResolvers<PushToTalkScreenCaptureResult>(),
    ];
    let next = 0;
    const h = setup({ capture: () => captures[next++]!.promise });
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    expect(h.voice.active).toBe(true);
    captures.forEach((capture) => capture.resolve(captured));
    await flush();
    h.clock.advance(4000);
    h.clock.advance(90_000);
    expect(h.voice.active).toBe(false);
    expect(h.status()).toBeNull();
    h.controller.dispose();
  });
  it("does not unmute a delayed connection after release", async () => {
    const h = setup();
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.voice.emit({ kind: "connected" });
    expect(h.voice.listening).toBe(false);
    h.controller.dispose();
  });
  it("reuses the warm call for a reply within 90 seconds and releases idle media afterward", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    await h.respond();
    expect(h.visible()).toBe(false);
    expect(h.status()).toBeNull();
    h.clock.advance(60_000);
    h.press();
    await flush();
    expect(h.voice.sessions).toBe(1);
    expect(h.voice.listening).toBe(true);
    h.clock.advance(400);
    h.release();
    await flush();
    await h.respond();
    h.clock.advance(90_000);
    await flush();
    expect(h.voice.active).toBe(false);
    h.controller.dispose();
  });
  it("enters the warm period when speech finished during a held-key pause", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.voice.emit({ kind: "caption", text: "Already answered.", turn: 1, final: true });
    h.voice.emit({ kind: "audible" });
    h.voice.emit({ kind: "silent" });
    h.clock.advance(2000);
    expect(h.voice.active).toBe(true);
    h.release();
    await flush();
    h.clock.advance(1500);
    h.clock.advance(90_000);
    expect(h.voice.active).toBe(false);
    expect(h.status()).toBeNull();
    h.controller.dispose();
  });
  it("enters the warm period when the last delegation is answered after playback ended", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.voice.emit({ kind: "delegation", id: "del_1", status: "pending" });
    h.voice.emit({ kind: "caption", text: "Done.", turn: 1, final: true });
    h.voice.emit({ kind: "audible" });
    h.voice.emit({ kind: "silent" });
    h.clock.advance(2000);
    h.voice.emit({ kind: "delegation", id: "del_1", status: "answered" });
    h.clock.advance(1500);
    h.clock.advance(90_000);
    expect(h.voice.active).toBe(false);
    h.controller.dispose();
  });
  it("does not expire the warm lease during audible speech when a delegation is answered", async () => {
    const h = setup({ sendScreen: false });
    try {
      h.press();
      await flush();
      h.voice.emit({ kind: "connected" });
      h.clock.advance(400);
      h.release();
      await flush();
      h.voice.emit({ kind: "delegation", id: "del_1", status: "pending" });
      h.voice.emit({ kind: "caption", text: "Long answer.", turn: 1, final: true });
      h.voice.emit({ kind: "audible" });
      h.voice.emit({ kind: "delegation", id: "del_1", status: "answered" });
      h.clock.advance(90_001);
      expect(h.voice.active).toBe(true);
      expect(h.status()).toEqual({ kind: "speaking" });

      h.voice.emit({ kind: "silent" });
      h.clock.advance(1_500);
      h.clock.advance(89_999);
      expect(h.voice.active).toBe(true);
      h.clock.advance(1);
      expect(h.voice.active).toBe(false);
    } finally {
      h.controller.dispose();
    }
  });

  it("keeps pending delegation past 90 seconds but closes at the absolute ten-minute ceiling", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.voice.emit({ kind: "delegation", id: "del_1", status: "pending" });
    h.clock.advance(100_000);
    await flush();
    expect(h.voice.active).toBe(true);
    expect(h.status()?.kind).toBe("thinking");
    h.clock.advance(499_600);
    await flush();
    expect(h.voice.active).toBe(false);
    h.controller.handleAppended(lateReply());
    expect(h.status()?.kind).toBe("ready");
    expect(h.caption()).toBe("The Router finished.");
    expect(h.voice.sessions).toBe(1);
    h.click();
    expect(h.openSideChat).toHaveBeenCalledOnce();
    expect(h.status()).toBeNull();
    expect(h.visible()).toBe(false);
    h.controller.dispose();
  });
  it("notifies a late result with PTT disabled, but ignores a typed reply and a different caller", async () => {
    const h = setup();
    h.press();
    await flush();
    h.controller.update({ ...h.config, enabled: false }, 1);
    const typed = lateReply("Typed answer");
    typed.conversation.messages[0]!.metadata.event_type = "chat.reply";
    h.controller.handleAppended(typed);
    expect(h.status()).toBeNull();
    h.controller.handleAppended(lateReply("Another caller", "someone_else"));
    expect(h.status()).toBeNull();
    h.controller.handleAppended(lateReply());
    expect(h.status()?.kind).toBe("ready");
    expect(h.voice.sessions).toBe(1);
    h.controller.dispose();
  });
  it("keeps a late reply ready after an earlier call error expires", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "error", code: "busy" });
    h.controller.handleAppended(lateReply());
    h.clock.advance(5000);
    expect(h.status()).toEqual({ kind: "ready" });
    expect(h.caption()).toBe("The Router finished.");
    expect(h.openSideChat).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("bounds caption and warm idle cleanup for final replies without audible playback", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.voice.emit({
      kind: "caption",
      text: "Sub-threshold audio answer.",
      turn: 1,
      final: true,
    });
    expect(h.status()?.kind).toBe("speaking");
    expect(h.caption()).toBe("Sub-threshold audio answer.");
    h.clock.advance(1500);
    expect(h.status()).toBeNull();
    expect(h.visible()).toBe(false);
    expect(h.voice.active).toBe(true);
    h.clock.advance(90_000);
    expect(h.voice.active).toBe(false);
    h.controller.dispose();
  });
  it("preserves a queued late reply across error teardown and displays it after the error expires", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.controller.handleAppended(lateReply());
    h.voice.emit({ kind: "error", code: "busy" });
    expect(h.status()).toEqual({ kind: "error", code: "busy" });
    h.clock.advance(4000);
    expect(h.status()?.kind).toBe("ready");
    expect(h.caption()).toBe("The Router finished.");
    h.controller.dispose();
  });
  it.each([true, false])(
    "keeps a denied screen capture visible when the cold peer connects (notch=%s)",
    async (notch) => {
      const h = setup({ notch, capture: async () => ({ status: "denied" }) });
      h.press();
      await flush();
      const visibleState = notch ? h.status : h.companionState;
      expect(visibleState()).toEqual({ kind: "error", code: "screen_denied" });
      h.voice.emit({ kind: "connected" });
      expect(visibleState()).toEqual({ kind: "error", code: "screen_denied" });
      h.clock.advance(3999);
      expect(visibleState()).toEqual({ kind: "error", code: "screen_denied" });
      expect(h.voice.listening).toBe(false);
      h.controller.dispose();
    }
  );

  it("reports failed admission immediately even while capture and failure notification are pending", async () => {
    const capture = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const failureNotice = Promise.withResolvers<void>();
    const h = setup({ capture: () => capture.promise });
    h.voice.beginContext.mockRejectedValueOnce(new Error("Context admission rejected"));
    h.voice.failContext.mockReturnValueOnce(failureNotice.promise);
    h.press();
    await flush();
    expect(h.voice.listening).toBe(false);
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    expect(h.voice.failContext).toHaveBeenCalledWith(1);
    capture.resolve(captured);
    failureNotice.resolve();
    await flush();
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it("invalidates an admitted context when image finalization fails without awaiting notification", async () => {
    const failureNotice = Promise.withResolvers<void>();
    const h = setup({
      capture: async () => ({
        status: "captured",
        finalize: () => {
          throw new Error("Image encoding failed");
        },
      }),
    });
    h.voice.failContext.mockReturnValueOnce(failureNotice.promise);
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.voice.failContext).toHaveBeenCalledWith(1);
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    failureNotice.resolve();
    await flush();
    h.controller.dispose();
  });
  it.each(["busy", "plan_limit", "microphone_denied"] as const)(
    "shows %s in the notch and never opens a fallback call",
    async (code) => {
      const h = setup();
      h.press();
      await flush();
      h.voice.emit({ kind: "error", code });
      expect(h.status()).toEqual({ kind: "error", code });
      expect(h.voice.active).toBe(false);
      expect(h.voice.sessions).toBe(1);
      h.controller.dispose();
    }
  );
  it("fences pending capture and late result when the account changes", async () => {
    const gate = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => gate.promise });
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.setUser("account_B");
    h.controller.update(h.config, 2);
    expect(h.voice.active).toBe(false);
    gate.resolve(captured);
    await flush();
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    h.controller.handleAppended(lateReply());
    expect(h.status()).toBeNull();
    h.controller.dispose();
  });
  it("removes the old account's visible caption immediately", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "caption", text: "Private reply.", turn: 1, final: false });
    h.companion.hide.mockClear();
    h.setUser("account_B");
    h.controller.update(h.config, 2);
    expect(h.companion.hide).toHaveBeenLastCalledWith({ immediate: true });
    expect(h.caption()).toBeNull();
    h.controller.dispose();
  });
  it("requests screen permission again when the user explicitly re-enables screenshots", async () => {
    const h = setup();
    h.screenRecording.status.mockReturnValue("denied");
    h.press();
    await flush();
    h.clock.advance(200);
    h.release();
    await flush();
    expect(h.screenRecording.request).toHaveBeenCalledOnce();
    h.controller.update({ ...h.config, sendScreen: false });
    h.controller.update(h.config);
    expect(h.screenRecording.request).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });
  it("with print disabled sends only app and cursor context, without capture or permission request", async () => {
    const h = setup({ sendScreen: false });
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.screenRecording.request).not.toHaveBeenCalled();
    const sent = h.voice.appendContext.mock.calls[0]?.[0];
    expect(sent?.attachments).toEqual([]);
    expect(sent?.text).toContain("Safari");
    expect(sent?.text).toContain("560");
    h.controller.dispose();
  });
  it.each([false, true])(
    "discards an accidental or cancelled gesture without context (cancelled=%s)",
    async (cancelled) => {
      const h = setup();
      h.press();
      await flush();
      h.clock.advance(cancelled ? 400 : 200);
      h.release(cancelled);
      await flush();
      expect(h.voice.listening).toBe(false);
      expect(h.voice.active).toBe(false);
      expect(h.voice.appendContext).not.toHaveBeenCalled();
      h.controller.dispose();
    }
  );
  it("keeps accepted service work even when the gesture is short", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "caller_turn" });
    h.clock.advance(200);
    h.release();
    await flush();
    expect(h.voice.listening).toBe(false);
    expect(h.voice.active).toBe(true);
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("mutes the 120-second gesture even with a pending screenshot", async () => {
    const gate = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => gate.promise });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(120_000);
    expect(h.voice.listening).toBe(false);
    gate.resolve(captured);
    await flush();
    h.controller.dispose();
  });
  it("closes on suspend and clears the caption on a new gesture without another session", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.voice.emit({ kind: "caption", text: "Speaking.", turn: 1, final: false });
    h.voice.emit({ kind: "audible" });
    h.press();
    await flush();
    expect(h.caption()).toBeNull();
    expect(h.voice.sessions).toBe(1);
    h.power.get("suspend")?.();
    expect(h.voice.active).toBe(false);
    h.controller.dispose();
  });
  it("hides even an exiting companion before capture and uses it for errors when notch is off", async () => {
    const h = setup({ notch: false });
    h.press();
    await flush();
    expect(h.order.indexOf("hide immediate")).toBeLessThan(h.order.indexOf("capture"));
    h.voice.emit({ kind: "error", code: "plan_limit" });
    expect(h.companionState()).toEqual({ kind: "error", code: "plan_limit" });
    h.controller.dispose();
  });
  it("keeps listening enabled when a newer held gesture replaces the original gesture during connection", async () => {
    const h = setup({ sendScreen: false });
    const gate = Promise.withResolvers<typeof target>();
    h.voice.open.mockReturnValueOnce(gate.promise);
    h.press();
    await flush();
    h.clock.advance(400);
    h.release();
    h.press();
    await flush();
    expect(h.voice.listening).toBe(true);
    gate.resolve(target);
    await flush();
    expect(h.voice.listening).toBe(true);
    h.clock.advance(400);
    h.release();
    expect(h.voice.listening).toBe(false);
    h.controller.dispose();
  });
  it("retains captions arriving during screen capture and restores them when the companion is shown", async () => {
    const gate = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => gate.promise });
    h.press();
    await flush();
    expect(h.visible()).toBe(false);
    h.voice.emit({
      kind: "caption",
      text: "Answer arriving during capture.",
      turn: 1,
      final: true,
    });
    expect(h.caption()).toBeNull();
    gate.resolve(captured);
    await flush();
    expect(h.visible()).toBe(true);
    expect(h.caption()).toBe("Answer arriving during capture.");
    h.controller.dispose();
  });
  it("bounds idle cleanup of a silent released gesture to the 90-second warm period", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.voice.active).toBe(true);
    expect(h.status()?.kind).toBe("thinking");
    h.clock.advance(60_000);
    expect(h.voice.active).toBe(true);
    expect(h.status()?.kind).toBe("thinking");
    h.clock.advance(30_000);
    await flush();
    expect(h.voice.active).toBe(false);
    expect(h.status()).toBeNull();

    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    await h.respond();
    h.press();
    await flush();
    expect(h.voice.sessions).toBe(2);
    h.clock.advance(400);
    h.release();
    await flush();
    h.clock.advance(90_000);
    expect(h.voice.active).toBe(false);
    h.controller.dispose();
  });
  it("distinguishes requested screenshot failure from print-off and posts failed without falling back to text-only", async () => {
    const gate = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => gate.promise });
    h.press();
    await flush();
    expect(h.voice.beginContext).toHaveBeenCalledWith(1, h.clock.now() + 300);
    h.clock.advance(400);
    h.release();
    gate.resolve({ status: "unavailable" });
    await flush();
    expect(h.voice.failContext).toHaveBeenCalledWith(1);
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    h.controller.dispose();
  });
  it("cancels context on gesture cancellation or too-short release", async () => {
    const h = setup();
    h.press();
    await flush();
    expect(h.voice.beginContext).toHaveBeenCalledWith(1, h.clock.now() + 300);
    h.release(true);
    await flush();
    expect(h.voice.cancelContext).toHaveBeenCalledWith(1);
    h.press();
    await flush();
    expect(h.voice.beginContext).toHaveBeenCalledWith(2, h.clock.now() + 300);
    h.clock.advance(100);
    h.release();
    await flush();
    expect(h.voice.cancelContext).toHaveBeenCalledWith(2);
    h.controller.dispose();
  });
  it("shows a context timeout while capture is still pending and never sends its late images", async () => {
    const capture = Promise.withResolvers<PushToTalkScreenCaptureResult>();
    const h = setup({ capture: () => capture.promise, notch: false });
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    h.voice.emit({ kind: "context_failed", contextId: 1 });
    expect(h.visible()).toBe(true);
    expect(h.companionState()).toMatchObject({ kind: "error", code: "context_failed" });
    capture.resolve(captured);
    await flush();
    expect(h.voice.appendContext).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it("ignores stale context_failed events and presents error only for the matching context", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    h.press();
    await flush();
    h.voice.emit({ kind: "context_failed", contextId: 1 });
    expect(h.status()?.kind).toBe("listening");
    h.voice.emit({ kind: "context_failed", contextId: 2 });
    expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
    h.controller.dispose();
  });
  it("cancels the silent idle timer when caller_turn arrives so in-progress replies are preserved", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.status()?.kind).toBe("thinking");
    h.voice.emit({ kind: "caller_turn" });
    h.clock.advance(60_000);
    expect(h.voice.active).toBe(true);
    h.clock.advance(40_000);
    await flush();
    expect(h.voice.active).toBe(true);
    h.controller.dispose();
  });
  it("does not arm 90s idle timer when caller_turn arrives before release", async () => {
    const h = setup();
    h.press();
    await flush();
    h.voice.emit({ kind: "connected" });
    h.voice.emit({ kind: "caller_turn" });
    h.clock.advance(400);
    h.release();
    await flush();
    expect(h.status()?.kind).toBe("thinking");
    h.clock.advance(60_000);
    expect(h.voice.active).toBe(true);
    h.clock.advance(40_000);
    await flush();
    expect(h.voice.active).toBe(true);
    h.controller.dispose();
  });
  it.each([true, false])(
    "reports a real backend context failure on the designated surface (notch=%s)",
    async (notch) => {
      const { h, batches, realVoice, controller, connect } = setupRealTransport({
        notch,
      });
      try {
        h.press();
        await connect();
        expect(realVoice.voiceSession().listening).toBe(true);
        h.clock.advance(400);
        h.release();
        expect(realVoice.voiceSession().listening).toBe(false);
        await flush();
        batches.push([
          { type: "delegation", id: "del_failed", status: "pending" },
          { type: "delegation", id: "del_failed", status: "failed" },
          { type: "context_failed", context_id: 1 },
        ]);
        h.clock.advance(500);
        await flush();
        expect(h.status()).toEqual({ kind: "error", code: "context_failed" });
        expect(h.visible()).toBe(!notch);
        if (!notch)
          expect(h.companionState()).toEqual({
            kind: "error",
            code: "context_failed",
          });
        expect(realVoice.voiceSession().listening).toBe(false);
        expect(h.openSideChat).not.toHaveBeenCalled();
      } finally {
        controller.dispose();
        realVoice.close();
      }
    }
  );

  it("keeps continuous live speech visible across a new gesture until actual silence", async () => {
    const { h, batches, realVoice, controller, connect } = setupRealTransport();
    try {
      h.press();
      await connect();
      h.clock.advance(400);
      h.release();
      await flush();
      const generation = realVoice.voiceSession().generation;
      realVoice.voiceReport({ generation, event: "audible" });
      h.press();
      await flush();
      h.clock.advance(400);
      h.release();
      await flush();
      batches.push([
        {
          kind: "caption",
          role: "agent",
          turn: 1,
          text: "Still speaking.",
          final: true,
        },
      ]);
      h.clock.advance(500);
      await flush();
      h.clock.advance(2_000);
      expect(h.visible()).toBe(true);
      expect(h.status()).toEqual({ kind: "speaking" });
      expect(h.caption()).toBe("Still speaking.");
      realVoice.voiceReport({ generation, event: "silent" });
      h.clock.advance(1_500);
      expect(h.visible()).toBe(false);
      expect(realVoice.voiceSession().listening).toBe(false);
    } finally {
      controller.dispose();
      realVoice.close();
    }
  });

  it("shows fresh live speech before its caption while the next gesture remains held", async () => {
    const { h, batches, realVoice, controller, connect } = setupRealTransport();
    try {
      h.press();
      await connect();
      h.clock.advance(400);
      h.release();
      await flush();
      batches.push([
        {
          kind: "caption",
          role: "agent",
          turn: 1,
          text: "Previous answer.",
          final: true,
        },
      ]);
      h.clock.advance(500);
      await flush();
      const generation = realVoice.voiceSession().generation;
      realVoice.voiceReport({ generation, event: "audible" });
      h.press();
      await flush();
      expect(h.caption()).toBeNull();
      expect(realVoice.voiceSession().listening).toBe(true);

      // The service may answer during a pause with the shortcut still held.
      // Media precedes its caption and must already drive the speaking surface.
      realVoice.voiceReport({ generation, event: "silent" });
      realVoice.voiceReport({ generation, event: "audible" });
      expect(h.status()).toEqual({ kind: "speaking" });
      expect(realVoice.voiceSession().listening).toBe(true);
      expect(h.caption()).toBeNull();

      batches.push([
        {
          kind: "caption",
          role: "agent",
          turn: 2,
          text: "Fresh answer.",
          final: false,
        },
      ]);
      h.clock.advance(500);
      await flush();
      expect(h.caption()).toBe("Fresh answer.");
      h.release();
      expect(realVoice.voiceSession().listening).toBe(false);
      expect(h.openSideChat).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
      realVoice.close();
    }
  });

  it.each(["cancelled", "short"] as const)(
    "silently discards a %s warm gesture while real transport admission is in flight",
    async (mode) => {
      const { h, api, batches, realVoice, controller, connect } = setupRealTransport();
      const admission = Promise.withResolvers<{ accepted: true }>();
      try {
        h.press();
        await connect();
        h.clock.advance(400);
        h.release();
        await flush();
        batches.push([
          { kind: "caption", role: "agent", turn: 1, text: "Done.", final: true },
        ]);
        h.clock.advance(500);
        await flush();
        const generation = realVoice.voiceSession().generation;
        realVoice.voiceReport({ generation, event: "audible" });
        realVoice.voiceReport({ generation, event: "silent" });
        h.clock.advance(1_500);
        await flush();
        expect(h.status()).toBeNull();

        api.appendVoiceCallContext.mockImplementationOnce(() => admission.promise);
        h.press();
        await flush();
        expect(realVoice.voiceSession()).toMatchObject({
          listening: true,
          admitted: false,
        });
        h.clock.advance(mode === "short" ? 100 : 400);
        h.release(mode === "cancelled");
        expect(realVoice.voiceSession().listening).toBe(false);
        await flush();

        expect(h.status()).toBeNull();
        expect(h.visible()).toBe(false);
        expect(realVoice.voiceSession().active).toBe(true);
        h.press();
        await flush();
        expect(realVoice.voiceSession().listening).toBe(true);
        expect(api.startVoiceCall).toHaveBeenCalledTimes(1);
      } finally {
        admission.resolve({ accepted: true });
        controller.dispose();
        realVoice.close();
      }
    }
  );
});
