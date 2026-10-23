import {
  CommaApiError,
  type VoiceCallAnswer,
  type VoiceCallEvent,
  type VoiceCallEvents,
} from "@comma/app/api";
import {
  idlePushToTalkVoiceSession,
  type PushToTalkVoiceReport,
  type PushToTalkVoiceSession,
} from "@comma/native-bridge";
import type { PushToTalkClock } from "./clock";
import { splitSentences } from "./message";
import { replyWaitMs } from "./reply-watcher";

/** Events are read like the call bar reads them. */
export const liveVoicePollMs = 500;
/** No audio this long after the text was handed over: the system voice reads it. */
export const liveVoiceNoAudioMs = 8_000;
/** Silence after the final caption that ends the reading. */
export const liveVoiceQuietMs = 1_200;
/** A pre-warmed call hangs up when the reply does not come in this time. */
export const liveVoiceIdleMs = replyWaitMs;
/** The server ends a read-aloud call at 120 s; this guards a stalled poll. */
export const liveVoiceMaxReadMs = 130_000;
/** Consecutive failed event reads that end the call. */
const maxPollFailures = 3;
/** Refusals that stay true until the settings change (D12). */
const rememberedFailures = new Set(["disabled", "codex_account_required"]);

/** The voice routes Main calls with its own Session. */
export interface PushToTalkVoiceApi {
  startVoiceCall(
    workspaceId: string,
    sdp: string,
    options: { mode: "read_aloud" }
  ): Promise<VoiceCallAnswer>;
  sayVoiceCall(workspaceId: string, callId: string, text: string): Promise<unknown>;
  voiceCallEvents(
    workspaceId: string,
    callId: string,
    after: number
  ): Promise<VoiceCallEvents>;
  endVoiceCall(workspaceId: string, callId: string): Promise<unknown>;
}

/** The hidden `push-to-talk-voice` window that holds the WebRTC peer. */
export interface PushToTalkVoiceHost {
  /** Creates and loads the window when it is missing. */
  open(): Promise<void>;
  /** The replay-last session the window follows: a new active generation is a new peer. */
  publish(session: PushToTalkVoiceSession): void;
}

/** The renderer-facing half: generated capabilities call these. */
export interface PushToTalkVoiceProvider {
  voiceSession(_input?: void): PushToTalkVoiceSession;
  /** The peer's offer; resolves with the answer, or `null` when it is not wanted. */
  voiceOffer(input: {
    generation: number;
    sdp: string;
  }): Promise<{ sdp: string } | null>;
  voiceReport(input: { generation: number; event: PushToTalkVoiceReport }): void;
}

/** Without a voice window no peer is ever wanted. */
export const idlePushToTalkVoiceProvider: PushToTalkVoiceProvider = {
  voiceSession: () => idlePushToTalkVoiceSession,
  voiceOffer: async () => null,
  voiceReport: () => undefined,
};

export type PushToTalkVoiceResult =
  | { status: "done" }
  | { status: "stopped" }
  /**
   * The GPT Live voice could not read it; `spokenSentences` of the text were
   * already heard, so the system voice reads only the rest.
   */
  | { status: "unavailable"; reason: string; spokenSentences: number };

export interface PushToTalkLiveVoice {
  /** Opens a read-aloud call ahead of the reply (pre-warm). */
  prepare(workspaceId: string): void;
  speak(input: {
    workspaceId: string;
    text: string;
    /** The sentence being read, from the agent caption. */
    onCaption: (sentence: string) => void;
  }): Promise<PushToTalkVoiceResult>;
  /** Hangs up now; a reading resolves `stopped`. */
  stop(): void;
  /** The settings changed: a remembered refusal is tried again. */
  reset(): void;
}

type Reading = {
  text: string;
  onCaption: (sentence: string) => void;
  resolve: (result: PushToTalkVoiceResult) => void;
  turns: Map<number, { text: string; final: boolean }>;
  caption?: string | undefined;
  /** Audio arrived after the text was handed over. */
  heard: boolean;
  audible: boolean;
  said: boolean;
  timers: (() => void)[];
  stopQuiet?: (() => void) | undefined;
};

type Call = {
  generation: number;
  workspaceId: string;
  state: "offering" | "connecting" | "open" | "failed" | "ended";
  failure?: string | undefined;
  callId?: string | undefined;
  cursor: number;
  pollFailures: number;
  reading?: Reading | undefined;
  stopIdle: () => void;
  stopPoll?: (() => void) | undefined;
};

/**
 * Reads push-to-talk replies with the GPT Live voice of Comma calls (D12):
 * a `read_aloud` call on Main's Session, whose media lives in the hidden
 * voice window. Main signals, sends the text, reads the captions and ends
 * the call after the final caption goes quiet. Any failure resolves
 * `unavailable` so the caller reads the rest with the system voice.
 */
export class GptLiveVoice implements PushToTalkLiveVoice, PushToTalkVoiceProvider {
  readonly #api: () => PushToTalkVoiceApi;
  readonly #runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
  readonly #host: PushToTalkVoiceHost;
  readonly #clock: PushToTalkClock;
  readonly #log: (message: string) => void;
  readonly #trace: (message: string) => void;
  #generation = 0;
  #session: PushToTalkVoiceSession = { generation: 0, active: false };
  #call: Call | undefined;
  #remembered: string | undefined;

  constructor(options: {
    /** Bound to the current Session for each request. */
    api: () => PushToTalkVoiceApi;
    /** The turn starts from the native hotkey, outside any renderer call. */
    runOwned: <T>(handler: () => Promise<T>) => Promise<T>;
    host: PushToTalkVoiceHost;
    clock: PushToTalkClock;
    log?: (message: string) => void;
    trace?: (message: string) => void;
  }) {
    this.#api = options.api;
    this.#runOwned = options.runOwned;
    this.#host = options.host;
    this.#clock = options.clock;
    this.#log = options.log ?? (() => undefined);
    this.#trace = options.trace ?? (() => undefined);
  }

  prepare(workspaceId: string) {
    if (this.#remembered) {
      this.#trace(`push-to-talk voice skipped: ${this.#remembered}`);
      return;
    }
    const current = this.#call;
    if (
      current &&
      current.workspaceId === workspaceId &&
      current.state !== "failed" &&
      current.state !== "ended"
    )
      return;
    if (current) this.#close(current, { status: "stopped" });
    const generation = ++this.#generation;
    const call: Call = {
      generation,
      workspaceId,
      state: "offering",
      cursor: 0,
      pollFailures: 0,
      stopIdle: () => undefined,
    };
    this.#call = call;
    call.stopIdle = this.#clock.setTimeout(() => {
      if (this.#call === call && !call.reading) this.#close(call);
    }, liveVoiceIdleMs);
    this.#publish({ generation, active: true });
    this.#trace(`push-to-talk voice preparing (generation ${generation})`);
    this.#host.open().catch((error: unknown) => {
      this.#log(`Push-to-talk voice window failed: ${message(error)}`);
      this.#fail(call, "window");
    });
  }

  speak(input: {
    workspaceId: string;
    text: string;
    onCaption: (sentence: string) => void;
  }): Promise<PushToTalkVoiceResult> {
    if (this.#remembered) return Promise.resolve(unavailable(this.#remembered, 0));
    if (this.#call?.workspaceId !== input.workspaceId || this.#call.state === "ended")
      this.prepare(input.workspaceId);
    const call = this.#call;
    if (!call) return Promise.resolve(unavailable(this.#remembered ?? "window", 0));
    if (call.state === "failed") {
      this.#call = undefined;
      return Promise.resolve(unavailable(call.failure ?? "failed", 0));
    }
    return new Promise((resolve) => {
      const reading: Reading = {
        text: input.text,
        onCaption: input.onCaption,
        resolve,
        turns: new Map(),
        heard: false,
        audible: false,
        said: false,
        timers: [],
      };
      call.reading = reading;
      call.stopIdle();
      reading.timers.push(
        this.#clock.setTimeout(() => {
          if (!reading.heard) this.#fail(call, "no_audio");
        }, liveVoiceNoAudioMs),
        this.#clock.setTimeout(() => this.#fail(call, "timeout"), liveVoiceMaxReadMs)
      );
      if (call.state === "open") this.#say(call, reading);
    });
  }

  stop() {
    const call = this.#call;
    if (call) this.#close(call, { status: "stopped" });
  }

  reset() {
    this.#remembered = undefined;
  }

  voiceSession(): PushToTalkVoiceSession {
    return this.#session;
  }

  async voiceOffer(input: { generation: number; sdp: string }) {
    const call = this.#call;
    if (!call || call.generation !== input.generation || call.state !== "offering")
      return null;
    call.state = "connecting";
    let answer: VoiceCallAnswer;
    try {
      answer = await this.#owned((api) =>
        api.startVoiceCall(call.workspaceId, input.sdp, { mode: "read_aloud" })
      );
    } catch (error) {
      const code = failureCode(error);
      if (rememberedFailures.has(code)) this.#remembered = code;
      this.#trace(`push-to-talk voice unavailable: ${code}`);
      this.#fail(call, code);
      return null;
    }
    if (this.#call !== call || call.state !== "connecting") {
      // Stopped while signaling: the call exists, so it is ended here.
      this.#hangUp(call.workspaceId, answer.call_id);
      return null;
    }
    call.callId = answer.call_id;
    call.state = "open";
    this.#trace(`push-to-talk voice call ${answer.call_id} open`);
    if (call.reading) this.#say(call, call.reading);
    void this.#poll(call);
    return { sdp: answer.sdp };
  }

  voiceReport(input: { generation: number; event: PushToTalkVoiceReport }) {
    const call = this.#call;
    if (!call || call.generation !== input.generation) return;
    if (input.event === "failed") {
      this.#fail(call, "connection");
      return;
    }
    const reading = call.reading;
    if (!reading) return;
    reading.audible = input.event === "audible";
    if (reading.audible && !reading.heard) {
      reading.heard = true;
      this.#trace("push-to-talk voice audio started");
    }
    this.#checkDone(call, reading);
  }

  #say(call: Call, reading: Reading) {
    if (reading.said || !call.callId) return;
    reading.said = true;
    const callId = call.callId;
    this.#owned((api) =>
      api.sayVoiceCall(call.workspaceId, callId, reading.text)
    ).catch((error: unknown) => this.#fail(call, failureCode(error)));
  }

  async #poll(call: Call) {
    if (this.#call !== call || call.state !== "open" || !call.callId) return;
    const callId = call.callId;
    try {
      const batch = await this.#owned((api) =>
        api.voiceCallEvents(call.workspaceId, callId, call.cursor)
      );
      call.pollFailures = 0;
      if (this.#call !== call) return;
      call.cursor = batch.cursor;
      for (const event of batch.events) {
        if (this.#call !== call) return;
        this.#event(call, event);
      }
    } catch (error) {
      this.#log(`Push-to-talk voice events failed: ${message(error)}`);
      if (++call.pollFailures >= maxPollFailures) {
        this.#fail(call, "events");
        return;
      }
    }
    if (this.#call === call && call.state === "open")
      call.stopPoll = this.#clock.setTimeout(
        () => void this.#poll(call),
        liveVoicePollMs
      );
  }

  #event(call: Call, event: VoiceCallEvent) {
    if (!("kind" in event)) return;
    const reading = call.reading;
    if (event.kind === "caption") {
      if (event.role !== "agent" || !reading) return;
      reading.turns.set(event.turn, { text: event.text, final: event.final });
      const sentence = splitSentences(heardText(reading)).at(-1);
      if (sentence && sentence !== reading.caption) {
        reading.caption = sentence;
        reading.onCaption(sentence);
      }
      this.#checkDone(call, reading);
      return;
    }
    if (event.kind === "closed" || event.kind === "error") {
      call.callId = undefined;
      if (reading?.heard && allFinal(reading)) this.#close(call, { status: "done" });
      else if (reading) this.#fail(call, event.kind);
      // A pre-warmed call that ended by itself is simply opened again.
      else this.#close(call);
    }
  }

  /** Done once the last caption is final and the audio stayed quiet. */
  #checkDone(call: Call, reading: Reading) {
    reading.stopQuiet?.();
    reading.stopQuiet = undefined;
    if (!reading.heard || reading.audible || !allFinal(reading)) return;
    reading.stopQuiet = this.#clock.setTimeout(() => {
      if (this.#call === call && call.reading === reading)
        this.#close(call, { status: "done" });
    }, liveVoiceQuietMs);
  }

  #fail(call: Call, reason: string) {
    if (this.#call !== call) return;
    const reading = call.reading;
    if (reading) {
      this.#trace(`push-to-talk voice fell back: ${reason}`);
      this.#close(call, unavailable(reason, heardSentences(reading)));
      return;
    }
    // Before the reply: the turn's reading falls back at once, without a new wait.
    this.#teardown(call);
    call.state = "failed";
    call.failure = reason;
  }

  #close(call: Call, result: PushToTalkVoiceResult = { status: "stopped" }) {
    if (this.#call === call) this.#call = undefined;
    this.#teardown(call);
    call.state = "ended";
    const reading = call.reading;
    call.reading = undefined;
    if (reading) {
      if (result.status === "done") this.#trace("push-to-talk voice read the reply");
      reading.resolve(result);
    }
  }

  #teardown(call: Call) {
    call.stopIdle();
    call.stopPoll?.();
    call.reading?.stopQuiet?.();
    for (const stop of call.reading?.timers.splice(0) ?? []) stop();
    if (this.#session.active && this.#session.generation === call.generation)
      this.#publish({ generation: ++this.#generation, active: false });
    const callId = call.callId;
    call.callId = undefined;
    if (callId) this.#hangUp(call.workspaceId, callId);
  }

  #hangUp(workspaceId: string, callId: string) {
    this.#owned((api) => api.endVoiceCall(workspaceId, callId)).catch(
      (error: unknown) =>
        this.#log(`Push-to-talk voice hang up failed: ${message(error)}`)
    );
  }

  #publish(session: PushToTalkVoiceSession) {
    this.#session = session;
    this.#host.publish(session);
  }

  #owned<T>(request: (api: PushToTalkVoiceApi) => Promise<T>): Promise<T> {
    return this.#runOwned(() => request(this.#api()));
  }
}

function unavailable(reason: string, spokenSentences: number): PushToTalkVoiceResult {
  return { status: "unavailable", reason, spokenSentences };
}

/** The agent caption so far, across the turns of one reading. */
function heardText(reading: Reading) {
  return [...reading.turns.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, turn]) => turn.text.trim())
    .filter(Boolean)
    .join(" ");
}

function allFinal(reading: Reading) {
  return (
    reading.turns.size > 0 && [...reading.turns.values()].every((turn) => turn.final)
  );
}

/** Whole sentences already heard; a sentence cut off is read again. */
function heardSentences(reading: Reading) {
  if (!reading.heard) return 0;
  const text = heardText(reading);
  const sentences = splitSentences(text);
  const complete =
    allFinal(reading) || /[.!?…。！？]["'”’)\]]*$/u.test(text)
      ? sentences.length
      : sentences.length - 1;
  return Math.max(0, Math.min(complete, splitSentences(reading.text).length));
}

function failureCode(error: unknown) {
  if (error instanceof CommaApiError)
    return error.body?.error ?? `http_${error.status}`;
  return "unreachable";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
