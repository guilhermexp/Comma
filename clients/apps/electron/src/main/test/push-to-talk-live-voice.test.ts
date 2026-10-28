import { describe, expect, it, vi } from "vitest";
import { CommaApiError, type VoiceCallEvents } from "@comma/app/api";
import {
  GptLiveVoice,
  liveVoiceIdleMs,
  liveVoiceNoAudioMs,
  liveVoicePollMs,
  liveVoiceQuietMs,
  type PushToTalkVoiceApi,
} from "../push-to-talk/live-voice";
import { FakeClock } from "./support/fake-clock";

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

type Event = VoiceCallEvents["events"][number];

const agent = (turn: number, text: string, final: boolean): Event => ({
  kind: "caption",
  role: "agent",
  turn,
  text,
  final,
});

function setup(
  options: { start?: () => Promise<{ call_id: string; sdp: string }> } = {}
) {
  const clock = new FakeClock();
  const batches: Event[][] = [];
  let cursor = 0;
  const api = {
    startVoiceCall: vi.fn(
      options.start ?? (async () => ({ call_id: "vc_1", sdp: "answer-sdp" }))
    ),
    sayVoiceCall: vi.fn(async () => ({ queued: true, chunks: 1 })),
    voiceCallEvents: vi.fn(async () => {
      const events = batches.shift() ?? [];
      cursor += events.length;
      return { events, cursor, truncated: false };
    }),
    endVoiceCall: vi.fn(async () => ({ ending: true })),
  } satisfies PushToTalkVoiceApi;
  const host = { open: vi.fn(async () => undefined), publish: vi.fn() };
  const runOwned = { calls: 0 };
  const voice = new GptLiveVoice({
    api: () => api,
    runOwned: (handler) => {
      runOwned.calls += 1;
      return handler();
    },
    host,
    clock,
  });
  const captions: string[] = [];
  /** Prepares and lets the hidden window offer, as the renderer does. */
  const connect = async () => {
    voice.prepare("wsp_1");
    await flush();
    const { generation } = voice.voiceSession();
    const answer = await voice.voiceOffer({ generation, sdp: "offer-sdp" });
    await flush();
    return { answer, generation };
  };
  const speak = (text: string) =>
    voice.speak({ workspaceId: "wsp_1", text, onCaption: (s) => captions.push(s) });
  /** The next events poll returns `events`. */
  const poll = async (...events: Event[]) => {
    batches.push(events);
    clock.advance(liveVoicePollMs);
    await flush();
  };
  return { api, captions, clock, connect, host, poll, runOwned, speak, voice };
}

async function settled<T>(promise: Promise<T>) {
  let value: { result: T } | undefined;
  void promise.then((result) => (value = { result }));
  await flush();
  return value;
}

describe("GptLiveVoice", () => {
  it("opens a read-aloud call on prepare and reads the reply, captioning each sentence", async () => {
    const { api, captions, clock, connect, host, poll, runOwned, speak, voice } =
      setup();
    const { answer, generation } = await connect();

    expect(host.open).toHaveBeenCalledOnce();
    expect(host.publish).toHaveBeenLastCalledWith({ generation, active: true });
    expect(answer).toEqual({ sdp: "answer-sdp" });
    expect(api.startVoiceCall).toHaveBeenCalledWith("wsp_1", "offer-sdp", {
      mode: "read_aloud",
    });

    const result = speak("Olá. Tudo certo por aqui.");
    await flush();
    expect(api.sayVoiceCall).toHaveBeenCalledWith(
      "wsp_1",
      "vc_1",
      "Olá. Tudo certo por aqui."
    );
    voice.voiceReport({ generation, event: "audible" });
    await poll(agent(1, "Olá.", false));
    await poll(agent(1, "Olá. Tudo certo por aqui.", true));
    expect(captions).toEqual(["Olá.", "Tudo certo por aqui."]);

    // The final caption alone does not end it: the audio is still playing.
    clock.advance(liveVoiceQuietMs * 3);
    expect(await settled(result)).toBeUndefined();
    voice.voiceReport({ generation, event: "silent" });
    clock.advance(liveVoiceQuietMs);
    await flush();

    expect(await settled(result)).toEqual({ result: { status: "done" } });
    expect(api.endVoiceCall).toHaveBeenCalledWith("wsp_1", "vc_1");
    expect(host.publish).toHaveBeenLastCalledWith({
      generation: generation + 1,
      active: false,
    });
    // Every HTTP call runs inside Main's session admission.
    expect(runOwned.calls).toBeGreaterThanOrEqual(
      api.startVoiceCall.mock.calls.length +
        api.sayVoiceCall.mock.calls.length +
        api.endVoiceCall.mock.calls.length +
        api.voiceCallEvents.mock.calls.length
    );
  });

  it("remembers that voice is disabled until reset, without opening another call", async () => {
    const { api, connect, host, speak, voice } = setup({
      start: () =>
        Promise.reject(
          new CommaApiError(503, "disabled", { error: "disabled", message: "off" })
        ),
    });
    const { answer } = await connect();
    expect(answer).toBeNull();
    expect(await speak("Olá.")).toEqual({
      status: "unavailable",
      reason: "disabled",
      spokenSentences: 0,
    });

    voice.prepare("wsp_1");
    await flush();
    expect(await speak("De novo.")).toMatchObject({ status: "unavailable" });
    expect(host.open).toHaveBeenCalledOnce();
    expect(api.startVoiceCall).toHaveBeenCalledOnce();

    voice.reset();
    voice.prepare("wsp_1");
    await flush();
    expect(host.open).toHaveBeenCalledTimes(2);
  });

  it("does not remember a busy group: the next turn tries the voice again", async () => {
    const { connect, host, speak } = setup({
      start: () =>
        Promise.reject(
          new CommaApiError(409, "busy", { error: "busy", message: "busy" })
        ),
    });
    await connect();
    expect(await speak("Olá.")).toMatchObject({
      status: "unavailable",
      reason: "busy",
    });
    await connect();
    expect(host.open).toHaveBeenCalledTimes(2);
  });

  it("gives up when no audio arrives within 8 s, with nothing spoken", async () => {
    const { api, clock, connect, poll, speak } = setup();
    await connect();
    const result = speak("Olá. Tudo certo.");
    await flush();
    // A caption without audio was never heard.
    await poll(agent(1, "Olá.", false));
    clock.advance(liveVoiceNoAudioMs);
    await flush();
    expect(await settled(result)).toEqual({
      result: { status: "unavailable", reason: "no_audio", spokenSentences: 0 },
    });
    expect(api.endVoiceCall).toHaveBeenCalledWith("wsp_1", "vc_1");
  });

  it("reports the sentences already heard when the call drops while reading", async () => {
    const { connect, poll, speak, voice } = setup();
    const { generation } = await connect();
    const result = speak("Primeira frase. Segunda frase. Terceira frase.");
    await flush();
    voice.voiceReport({ generation, event: "audible" });
    await poll(agent(1, "Primeira frase. Segunda", false), {
      kind: "closed",
      reason: "model_error",
    });
    expect(await settled(result)).toEqual({
      result: { status: "unavailable", reason: "closed", spokenSentences: 1 },
    });
  });
  it("falls back to system voice when a call closes or fails after a final partial chunk", async () => {
    const { connect, poll, speak, voice } = setup();
    const { generation } = await connect();
    const result = speak("Primeira frase. Segunda frase. Terceira frase.");
    await flush();
    voice.voiceReport({ generation, event: "audible" });
    // Turn 1 is final, but only covers the first sentence of a 3-sentence reply.
    await poll(agent(1, "Primeira frase.", true), {
      kind: "closed",
      reason: "chunk_drop",
    });
    expect(await settled(result)).toEqual({
      result: { status: "unavailable", reason: "closed", spokenSentences: 1 },
    });

    // Same with an error event after the first final chunk
    const second = setup();
    const secondConn = await second.connect();
    const secondResult = second.speak("Primeira frase. Segunda frase. Terceira frase.");
    await flush();
    second.voice.voiceReport({ generation: secondConn.generation, event: "audible" });
    await second.poll(agent(1, "Primeira frase.", true), {
      kind: "error",
      code: "chunk_drop",
    });
    expect(await settled(secondResult)).toEqual({
      result: { status: "unavailable", reason: "error", spokenSentences: 1 },
    });

    // A single long sentence split across chunks that drops before the tail
    const third = setup();
    const thirdConn = await third.connect();
    const thirdResult = third.speak(
      "Esta é uma resposta única longa sem pontuação no meio e parte final."
    );
    await flush();
    third.voice.voiceReport({ generation: thirdConn.generation, event: "audible" });
    await third.poll(agent(1, "Esta é uma resposta única longa sem pontuação", true), {
      kind: "closed",
      reason: "model_error",
    });
    expect(await settled(thirdResult)).toEqual({
      result: { status: "unavailable", reason: "closed", spokenSentences: 0 },
    });
  });

  it("does not conclude during interchunk silence until the entire reply is read", async () => {
    const { clock, connect, poll, speak, voice } = setup();
    const { generation } = await connect();
    const result = speak("Primeira frase. Segunda frase. Terceira frase.");
    await flush();
    voice.voiceReport({ generation, event: "audible" });
    await poll(agent(1, "Primeira frase.", true));

    // Silence after the first final chunk must NOT imply the full reply is done.
    voice.voiceReport({ generation, event: "silent" });
    clock.advance(liveVoiceQuietMs * 2);
    await flush();
    expect(await settled(result)).toBeUndefined();

    // The subsequent chunk arrives and plays to completion.
    voice.voiceReport({ generation, event: "audible" });
    await poll(agent(2, "Segunda frase. Terceira frase.", true));
    voice.voiceReport({ generation, event: "silent" });
    clock.advance(liveVoiceQuietMs);
    await flush();

    expect(await settled(result)).toEqual({ result: { status: "done" } });
  });

  it("does not conclude early when text contains repeated identical sentences", async () => {
    const { clock, connect, poll, speak, voice } = setup();
    const { generation } = await connect();
    const result = speak("Wait for it. Wait for it.");
    await flush();
    voice.voiceReport({ generation, event: "audible" });

    // Chunk 1 matches the first sentence exactly and is final.
    await poll(agent(1, "Wait for it.", true));
    voice.voiceReport({ generation, event: "silent" });
    clock.advance(liveVoiceQuietMs * 2);
    await flush();
    expect(await settled(result)).toBeUndefined();

    // Chunk 2 arrives with the second sentence.
    voice.voiceReport({ generation, event: "audible" });
    await poll(agent(2, "Wait for it.", true));
    voice.voiceReport({ generation, event: "silent" });
    clock.advance(liveVoiceQuietMs);
    await flush();

    expect(await settled(result)).toEqual({ result: { status: "done" } });
  });

  it("stops at once: the window drops its peer and the call hangs up", async () => {
    const { api, connect, host, speak, voice } = setup();
    const { generation } = await connect();
    const result = speak("Olá.");
    await flush();
    voice.stop();
    expect(host.publish).toHaveBeenLastCalledWith({
      generation: generation + 1,
      active: false,
    });
    expect(await settled(result)).toEqual({ result: { status: "stopped" } });
    await flush();
    expect(api.endVoiceCall).toHaveBeenCalledWith("wsp_1", "vc_1");
  });

  it("hangs up a prepared call when no reply comes within 180 s", async () => {
    const { api, clock, connect, host } = setup();
    const { generation } = await connect();
    clock.advance(liveVoiceIdleMs);
    await flush();
    expect(api.endVoiceCall).toHaveBeenCalledWith("wsp_1", "vc_1");
    expect(host.publish).toHaveBeenLastCalledWith({
      generation: generation + 1,
      active: false,
    });
  });

  it("ignores an offer from a peer the voice no longer wants", async () => {
    const { api, connect, voice } = setup();
    const { generation } = await connect();
    voice.stop();
    expect(await voice.voiceOffer({ generation, sdp: "late-offer" })).toBeNull();
    expect(api.startVoiceCall).toHaveBeenCalledOnce();
  });
});
