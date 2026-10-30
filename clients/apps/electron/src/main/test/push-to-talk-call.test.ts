import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommaApiError, createCommaApi, type VoiceCallEvent } from "@comma/app/api";
import {
  GptLiveVoice,
  type PushToTalkCallEvent,
  type PushToTalkVoiceApi,
} from "../push-to-talk/live-voice";
import { FakeClock } from "./support/fake-clock";
import { sessionProductLeaseSchema } from "@comma/session-contract";
import { z } from "zod";
import {
  createCurrentMainSessionApiBinding,
  MainNativeSessionAdmissionGuard,
  MainProductCredentialAuthority,
} from "../modules/session";

const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const target = { workspaceId: "wsp_1", groupId: "grp_1", conversationId: "cnv_1" };
function setup(resolveTarget: () => Promise<typeof target> = async () => target) {
  const clock = new FakeClock();
  const batches: VoiceCallEvent[][] = [];
  let cursor = 0;
  const api = {
    startVoiceCall: vi.fn(async () => ({ call_id: "vc_1", sdp: "answer" })),
    appendVoiceCallContext: vi.fn<PushToTalkVoiceApi["appendVoiceCallContext"]>(
      async () => ({ accepted: true as const })
    ),
    uploadGroupFile: vi.fn<PushToTalkVoiceApi["uploadGroupFile"]>(
      async (_group, input) => ({
        path: `/uploads/abcdefghijklmnopqrstuv-${input.name}`,
        name: input.name,
        size: input.data.size,
      })
    ),
    voiceCallEvents: vi.fn(async () => {
      const events = batches.shift() ?? [];
      cursor += events.length;
      return { events, cursor, truncated: false };
    }),
    endVoiceCall: vi.fn(async () => ({ ending: true })),
  };
  const events: PushToTalkCallEvent[] = [];
  const voice = new GptLiveVoice({
    api: () => api,
    resolveTarget,
    runOwned: async <T>(fn: () => Promise<T>) => fn(),
    host: {
      open: async () => undefined,
      close: () => undefined,
      publish: () => undefined,
    },
    clock,
  });
  voice.onEvent((event) => events.push(event));
  const open = async () => {
    await voice.open();
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });
    return generation;
  };
  return { api, clock, batches, events, voice, open };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    })
  );
});

async function createVoiceHttpServer(
  handler: (
    req: { method: string; url: string },
    res: ServerResponse,
    reqRaw: IncomingMessage
  ) => void | Promise<void>
) {
  const server = createServer(async (req, res) => {
    req.resume();
    await handler({ method: req.method ?? "GET", url: req.url ?? "" }, res, req);
  });
  servers.push(server);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = createCommaApi({
    baseUrl,
    token: "live-voice-token",
  });
  return { baseUrl, api, server };
}

describe("push-to-talk live session transport", () => {
  it("reports microphone denial and local levels while cold target resolution is still pending", async () => {
    const targetGate = Promise.withResolvers<typeof target>();
    const { voice, events, api } = setup(() => targetGate.promise);
    const opening = voice.open();
    void opening.catch(() => undefined);
    voice.setListening(true);
    const { generation } = voice.voiceSession();
    voice.voiceReport({ generation, event: { kind: "level", level: 0.6 } });
    expect(events).toContainEqual({ kind: "level", level: 0.6 });
    voice.voiceReport({ generation, event: "microphone_denied" });
    expect(events).toContainEqual({ kind: "error", code: "microphone_denied" });
    expect(voice.voiceSession()).toMatchObject({ active: false, listening: false });
    targetGate.resolve(target);
    await expect(opening).rejects.toThrow();
    expect(api.startVoiceCall).not.toHaveBeenCalled();
  });

  it("starts local capture before resolving the cold workspace target and closes it on cancellation", async () => {
    const targetGate = Promise.withResolvers<typeof target>();
    const { voice, api } = setup(() => targetGate.promise);
    const opening = voice.open();
    void opening.catch(() => undefined);
    const admission = voice.beginContext(1, 300);
    void admission.catch(() => undefined);
    voice.setListening(true);
    await flush();
    expect(voice.voiceSession()).toMatchObject({
      active: true,
      listening: true,
      contextId: 1,
      admitted: false,
    });
    voice.close();
    expect(voice.voiceSession()).toMatchObject({ active: false, listening: false });
    targetGate.resolve(target);
    await expect(opening).rejects.toThrow();
    await expect(admission).rejects.toThrow();
    expect(api.startVoiceCall).not.toHaveBeenCalled();
  });

  it("qualifies input on Main's hold deadline and revokes a short gesture before a delayed renderer can send it", async () => {
    const { voice, clock, open } = setup();
    await open();
    await voice.beginContext(1, clock.now() + 300);
    voice.setListening(true);
    clock.advance(299);
    expect(voice.voiceSession().qualified).toBe(false);
    clock.advance(1);
    expect(voice.voiceSession().qualified).toBe(true);
    voice.setListening(false);
    await voice.beginContext(2, clock.now() + 300);
    voice.setListening(true);
    clock.advance(299);
    voice.setListening(false);
    expect(voice.voiceSession().qualified).toBe(false);
    voice.cancelContext(2);
    clock.advance(1);
    expect(voice.voiceSession()).toMatchObject({ contextId: null, qualified: false });
    voice.close();
    await flush();
    expect(clock.pending()).toBe(0);
  });

  it("publishes capture intent before admission and admits a released buffer without reopening the mic", async () => {
    const { voice, api, clock } = setup();
    const gate = Promise.withResolvers<{ accepted: true }>();
    api.appendVoiceCallContext.mockReturnValueOnce(gate.promise);
    const opening = voice.open();
    const admission = voice.beginContext(1, 300);
    voice.setListening(true);
    await opening;
    expect(voice.voiceSession()).toMatchObject({
      active: true,
      listening: true,
      contextId: 1,
      admitted: false,
    });
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });
    clock.advance(400);
    voice.setListening(false);
    gate.resolve({ accepted: true });
    await admission;
    expect(voice.voiceSession()).toMatchObject({
      listening: false,
      contextId: 1,
      admitted: true,
      qualified: true,
    });
    voice.cancelContext(1);
    expect(voice.voiceSession()).toMatchObject({
      listening: false,
      contextId: null,
      admitted: false,
    });
    voice.close();
  });

  it("keeps the new account call alive when an old opening rejects after target resolution", async () => {
    const pendingTarget = Promise.withResolvers<typeof target>();
    let attempts = 0;
    const { voice } = setup(() =>
      attempts++ === 0 ? pendingTarget.promise : Promise.resolve(target)
    );
    const obsolete = voice.open();
    void obsolete.catch(() => undefined);
    await flush();
    voice.close();
    await voice.open();
    const generation = voice.voiceSession().generation;
    pendingTarget.resolve(target);
    await expect(obsolete).rejects.toThrow();
    expect(voice.voiceSession()).toMatchObject({ active: true, generation });
    voice.close();
  });

  it("completes teardown after the real session API rejects a stale credential synchronously", async () => {
    const audience = "https://voice.example";
    const authority = new MainProductCredentialAuthority({
      authorityInstanceId: "ptt-authority",
      trustedAudience: audience,
    });
    const snapshot = authority.acceptVerifiedCredential({
      audience,
      email: "owner@example.com",
      expiresAtEpochSeconds: 1_900_000_000,
      sessionId: "session-A",
      token: "account-A",
      userId: "owner",
    });
    if (snapshot.phase !== "signed_in") throw new Error("Expected signed in.");
    const lease = {
      audience,
      authorityInstanceId: snapshot.authority.authorityInstanceId,
      generation: snapshot.generation,
      sessionId: snapshot.session.sessionId,
    };
    const guard = new MainNativeSessionAdmissionGuard(authority);
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Response.json(
        url.pathname.endsWith("/calls")
          ? { call_id: "vc_1", sdp: "answer" }
          : { events: [], cursor: 0, truncated: false }
      );
    });
    let binding: ReturnType<typeof createCurrentMainSessionApiBinding> | undefined;
    await guard.run({
      contract: {
        channel: "comma:test:bind-ptt",
        sessionAdmission: "required",
        input: z.strictObject({ session: sessionProductLeaseSchema }),
        output: z.string(),
      },
      handler: () => {
        binding = createCurrentMainSessionApiBinding({
          fetch: upstream,
          session: { authority, reportUnauthorized: async () => undefined },
        });
        return "bound";
      },
      input: { session: lease },
    });
    if (!binding) throw new Error("Expected a session API.");
    const api = binding.api;
    const clock = new FakeClock();
    const voice = new GptLiveVoice({
      api: () => api,
      clock,
      resolveTarget: async () => target,
      runOwned: (handler) => handler(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
    });
    await voice.open();
    await voice.voiceOffer({
      generation: voice.voiceSession().generation,
      sdp: "offer",
    });
    await flush();
    authority.beginInvalidation({
      authorityInstanceId: lease.authorityInstanceId,
      expectedAudience: audience,
      expectedSessionId: lease.sessionId,
      generation: lease.generation,
    });
    expect(() => voice.close()).not.toThrow();
    expect(voice.voiceSession()).toMatchObject({ active: false, listening: false });
    expect(clock.pending()).toBe(0);
    expect(
      upstream.mock.calls.every(([input]) => !String(input).endsWith("/vc_1"))
    ).toBe(true);
  });
  it("keeps a release effective through a delayed connection and ignores stale media reports", async () => {
    const { voice, events } = setup();
    await voice.open();
    voice.setListening(true);
    const { generation } = voice.voiceSession();
    voice.setListening(false);
    await voice.voiceOffer({ generation, sdp: "offer" });
    voice.voiceReport({ generation, event: "connected" });
    expect(voice.voiceSession()).toMatchObject({ active: true, listening: false });
    voice.close();
    const count = events.length;
    voice.voiceReport({ generation, event: { kind: "level", level: 0.8 } });
    expect(events).toHaveLength(count);
    expect(voice.voiceSession()).toMatchObject({ active: false, listening: false });
  });

  it("uploads actual image bytes before appending scoped context without re-enabling the microphone", async () => {
    const { voice, api, open } = setup();
    await open();
    await voice.beginContext(1, 300);
    expect(api.appendVoiceCallContext).toHaveBeenCalledWith(
      "wsp_1",
      "vc_1",
      { context_id: 1, status: "pending" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const gate = Promise.withResolvers<{ path: string; name: string; size: number }>();
    api.uploadGroupFile.mockReturnValueOnce(gate.promise);
    voice.setListening(true);
    const sending = voice.appendContext({
      contextId: 1,
      text: "Editor; cursor 20,30",
      attachments: [
        { name: "screen.png", mediaType: "image/png", data: Buffer.from([1, 2, 3]) },
      ],
    });
    await flush();
    voice.setListening(false);
    expect(voice.voiceSession().listening).toBe(false);
    expect(api.appendVoiceCallContext).toHaveBeenCalledTimes(1);
    const upload = api.uploadGroupFile.mock.calls[0]!;
    expect(upload[0]).toBe("grp_1");
    expect(Array.from(new Uint8Array(await upload[1].data.arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    gate.resolve({
      path: "/uploads/abcdefghijklmnopqrstuv-screen.png",
      name: "screen.png",
      size: 3,
    });
    await sending;
    expect(api.appendVoiceCallContext).toHaveBeenLastCalledWith(
      "wsp_1",
      "vc_1",
      {
        context_id: 1,
        status: "complete",
        text: "Editor; cursor 20,30",
        attachments: [
          {
            path: "/uploads/abcdefghijklmnopqrstuv-screen.png",
            name: "screen.png",
            mime: "image/png",
          },
        ],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(voice.voiceSession().listening).toBe(false);
    voice.close();
  });

  it.each(["busy", "plan_limit"])(
    "reports %s without switching voice transports",
    async (code) => {
      const { voice, api, events } = setup();
      api.startVoiceCall.mockRejectedValueOnce(
        new CommaApiError(code === "busy" ? 409 : 429, code, { error: code })
      );
      await voice.open();
      const { generation } = voice.voiceSession();
      await expect(voice.voiceOffer({ generation, sdp: "offer" })).resolves.toBeNull();
      expect(events).toContainEqual({ kind: "error", code });
      expect(voice.voiceSession().active).toBe(false);
    }
  );

  it("gates transmission on admission while capturing the start locally", async () => {
    const { voice, api, open } = setup();
    await open();
    const pendingGate = Promise.withResolvers<{ accepted: true }>();
    api.appendVoiceCallContext.mockReturnValueOnce(pendingGate.promise);
    voice.setListening(true);
    const admitting = voice.beginContext(1, 300);
    expect(voice.voiceSession()).toMatchObject({ listening: true, admitted: false });
    pendingGate.resolve({ accepted: true });
    await admitting;
    expect(voice.voiceSession()).toMatchObject({ listening: true, admitted: true });
    voice.setListening(false);
    expect(voice.voiceSession().listening).toBe(false);
    voice.close();
  });
  it("stale control ACK does not unmute if released before admission", async () => {
    const { voice, api, open } = setup();
    await open();
    const pendingGate = Promise.withResolvers<{ accepted: true }>();
    api.appendVoiceCallContext.mockReturnValueOnce(pendingGate.promise);
    voice.setListening(true);
    const admitting = voice.beginContext(1, 300);
    expect(voice.voiceSession()).toMatchObject({ listening: true, admitted: false });
    voice.setListening(false);
    expect(voice.voiceSession().listening).toBe(false);
    pendingGate.resolve({ accepted: true });
    await admitting;
    expect(voice.voiceSession().listening).toBe(false);
    voice.close();
  });
  it("newer gesture cancels previous context and stale older ACK cannot authorize its input", async () => {
    const { voice, api, open } = setup();
    await open();
    const gate1 = Promise.withResolvers<{ accepted: true }>();
    const gate2 = Promise.withResolvers<{ accepted: true }>();
    api.appendVoiceCallContext
      .mockReturnValueOnce(gate1.promise)
      .mockReturnValueOnce(gate2.promise);
    voice.setListening(true);
    const admitting1 = voice.beginContext(1, 300);
    const obsoleteAdmission = expect(admitting1).rejects.toThrow();
    await flush();
    expect(voice.voiceSession().admitted).toBe(false);
    const admitting2 = voice.beginContext(2, 300);
    expect(voice.voiceSession()).toMatchObject({ contextId: 2, admitted: false });
    gate1.resolve({ accepted: true });
    await flush();
    await obsoleteAdmission;
    expect(voice.voiceSession()).toMatchObject({ contextId: 2, admitted: false });
    gate2.resolve({ accepted: true });
    await admitting2;
    expect(voice.voiceSession()).toMatchObject({ contextId: 2, admitted: true });
    voice.close();
  });
  it("aborts upload and rejects context when 30s upload budget expires with no late completion", async () => {
    const { voice, api, clock, open } = setup();
    await open();
    await voice.beginContext(1, 300);
    const uploadGate = Promise.withResolvers<{
      path: string;
      name: string;
      size: number;
    }>();
    api.uploadGroupFile.mockReturnValueOnce(uploadGate.promise);
    const sending = voice.appendContext({
      contextId: 1,
      text: "Editor; cursor 20,30",
      attachments: [
        { name: "screen.png", mediaType: "image/png", data: Buffer.from([1, 2, 3]) },
      ],
    });
    const rejected = expect(sending).rejects.toThrow();
    await flush();
    clock.advance(30_000);
    await rejected;
    expect(api.uploadGroupFile.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    await voice.beginContext(2, 300);
    await voice.appendContext({ contextId: 2, text: "New request", attachments: [] });
    uploadGate.resolve({
      path: "/uploads/late-screen.png",
      name: "screen.png",
      size: 3,
    });
    await flush();
    const completed = api.appendVoiceCallContext.mock.calls.filter(
      ([, , input]) => input.status === "complete"
    );
    expect(completed).toEqual([
      [
        "wsp_1",
        "vc_1",
        {
          context_id: 2,
          status: "complete",
          text: "New request",
          attachments: [],
        },
        expect.any(Object),
      ],
    ]);
    voice.close();
  });

  it("aborts a stalled sibling upload when another image fails, before releasing context ownership", async () => {
    let uploads = 0;
    let siblingAborted = false;
    const bothUploads = Promise.withResolvers<void>();
    const { api } = await createVoiceHttpServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url.endsWith("/voice/calls")) {
        reply(201, { call_id: "vc_1", sdp: "answer" });
      } else if (req.method === "POST" && req.url.endsWith("/context")) {
        reply(200, { accepted: true });
      } else if (req.method === "POST" && req.url.endsWith("/files")) {
        if (++uploads === 1) {
          res.on("close", () => {
            if (!res.writableEnded) siblingAborted = true;
          });
        } else {
          bothUploads.resolve();
          reply(503, { error: "upload_failed" });
        }
      } else if (req.method === "GET") {
        reply(200, { events: [], cursor: 0, truncated: false });
      } else {
        reply(200, {});
      }
    });
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (handler) => handler(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock: new FakeClock(),
    });
    try {
      await voice.open();
      await voice.voiceOffer({
        generation: voice.voiceSession().generation,
        sdp: "offer",
      });
      await voice.beginContext(1, 300);
      const completed = voice.appendContext({
        contextId: 1,
        text: "Screen",
        attachments: ["screen.png", "detail.png"].map((name) => ({
          name,
          mediaType: "image/png",
          data: Buffer.from([1]),
        })),
      });
      const rejected = expect(completed).rejects.toThrow();
      await bothUploads.promise;
      await rejected;
      await vi.waitFor(() => expect(siblingAborted).toBe(true));
    } finally {
      voice.close();
    }
  });

  it("bounds stalled admission before call.ready and never authorizes input from a late ACK", async () => {
    const { voice, clock } = setup();
    await voice.open();
    // call.ready is pending because voiceOffer has not completed
    voice.setListening(true);
    const admitting = voice.beginContext(1, 300);
    const rejected = expect(admitting).rejects.toThrow();
    await flush();
    expect(voice.voiceSession().admitted).toBe(false);

    // Advance 30s admission budget
    clock.advance(30_000);
    await rejected;
    expect(voice.voiceSession().admitted).toBe(false);

    // A late readiness result must not authorize the failed context's buffered audio.
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });
    await flush();
    expect(voice.voiceSession().admitted).toBe(false);

    // Newer context on the same call succeeds without damage
    await voice.beginContext(2, 300);
    expect(voice.voiceSession()).toMatchObject({ contextId: 2, admitted: true });
    voice.close();
  });

  it("rejects and aborts stalled appendVoiceCallContext admission with bounded 30s deadline, without damaging newer calls", async () => {
    const { voice, api, clock, open } = setup();
    await open();
    const stalledAdmission = Promise.withResolvers<{ accepted: true }>();
    api.appendVoiceCallContext.mockReturnValueOnce(stalledAdmission.promise);

    voice.setListening(true);
    const admitting = voice.beginContext(1, 300);
    const rejected = expect(admitting).rejects.toThrow();
    await flush();
    expect(voice.voiceSession().admitted).toBe(false);

    // 30s admission deadline expires
    clock.advance(30_000);
    await rejected;
    expect(api.appendVoiceCallContext.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(voice.voiceSession().admitted).toBe(false);

    // A late ACK must not authorize the failed context's buffered audio.
    stalledAdmission.resolve({ accepted: true });
    await flush();
    expect(voice.voiceSession().admitted).toBe(false);

    // Newer context succeeds normally
    await voice.beginContext(2, 300);
    expect(voice.voiceSession()).toMatchObject({ contextId: 2, admitted: true });
    voice.close();
  });

  it("bounds best-effort failContext and cancelContext without awaiting or hanging on stalled call.ready", async () => {
    const { voice, clock } = setup();
    await voice.open();
    // call.ready is pending. failContext and cancelContext must not hang awaiting it
    const failed = voice.failContext(1);
    await expect(failed).resolves.toBeUndefined();
    expect(voice.voiceSession().listening).toBe(false);

    expect(() => voice.cancelContext(1)).not.toThrow();
    // Pending timers must be bounded and clean up when clock advances or call closes
    voice.close();
    expect(clock.pending()).toBe(0);
  });

  it("bounds stalled event polling response to 30s deadline and terminates with an actionable error after bounded retries", async () => {
    let eventPollCount = 0;
    const pollBarriers: Array<{
      received: Promise<void>;
      resolve: () => void;
      aborted: boolean;
    }> = [];

    const getBarrier = (index: number) => {
      if (!pollBarriers[index]) {
        const { promise: received, resolve } = Promise.withResolvers<void>();
        pollBarriers[index] = { received, resolve, aborted: false };
      }
      return pollBarriers[index]!;
    };

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ call_id: "vc_1", sdp: "answer-sdp" }));
        return;
      }
      if (req.url.includes("/events")) {
        const barrier = getBarrier(eventPollCount);
        eventPollCount++;
        res.on("close", () => {
          if (!res.writableEnded) {
            barrier.aborted = true;
          }
        });
        barrier.resolve();
        // Stall the events response completely: do not writeHead or end
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const events: PushToTalkCallEvent[] = [];
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });
    voice.onEvent((event) => events.push(event));

    await voice.open();
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });

    // 1. Explicit arrival barrier: wait for first poll HTTP request to reach the server
    await getBarrier(0).received;
    expect(eventPollCount).toBe(1);

    // 2. Advance clock by 30s control budget: in-flight stalled poll must be aborted by deadline
    clock.advance(30_000);
    await vi.waitFor(() => expect(getBarrier(0).aborted).toBe(true), { timeout: 300 });

    // 3. Retry 1: wait for retry timer to be installed on FakeClock, then advance 500ms
    await vi.waitFor(() => expect(clock.pending()).toBe(1), { timeout: 300 });
    clock.advance(500);
    await getBarrier(1).received;
    expect(eventPollCount).toBe(2);

    // Attempt 2 deadline: advance 30s
    clock.advance(30_000);
    await vi.waitFor(() => expect(getBarrier(1).aborted).toBe(true), { timeout: 300 });

    // 4. Retry 2: wait for retry timer, advance 500ms
    await vi.waitFor(() => expect(clock.pending()).toBe(1), { timeout: 300 });
    clock.advance(500);
    await getBarrier(2).received;
    expect(eventPollCount).toBe(3);

    // Attempt 3 deadline: advance 30s -> reaches maxPollFailures (3) -> terminal error
    clock.advance(30_000);
    await vi.waitFor(
      () =>
        expect(events).toContainEqual({
          kind: "error",
          code: "unreachable",
        }),
      { timeout: 300 }
    );
    expect(voice.voiceSession().active).toBe(false);
    voice.close();
  });

  it("bounds stalled event polling body stream to 30s deadline and terminates with an actionable error after bounded retries", async () => {
    let eventPollCount = 0;
    const pollBarriers: Array<{
      received: Promise<void>;
      resolve: () => void;
      headersSent: boolean;
      aborted: boolean;
    }> = [];

    const getBarrier = (index: number) => {
      if (!pollBarriers[index]) {
        const { promise: received, resolve } = Promise.withResolvers<void>();
        pollBarriers[index] = { received, resolve, headersSent: false, aborted: false };
      }
      return pollBarriers[index]!;
    };

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ call_id: "vc_1", sdp: "answer-sdp" }));
        return;
      }
      if (req.url.includes("/events")) {
        const barrier = getBarrier(eventPollCount);
        eventPollCount++;
        res.on("close", () => {
          if (!res.writableEnded) {
            barrier.aborted = true;
          }
        });
        // Write headers and initial chunk, but stall the body stream
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"events":[');
        barrier.headersSent = res.headersSent;
        barrier.resolve();
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const events: PushToTalkCallEvent[] = [];
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });
    voice.onEvent((event) => events.push(event));

    await voice.open();
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });

    // 1. Explicit arrival barrier: wait for poll request to arrive and headers to be sent
    await getBarrier(0).received;
    expect(eventPollCount).toBe(1);
    expect(getBarrier(0).headersSent).toBe(true);

    // 2. Advance 30s deadline: stalled body stream must be aborted
    clock.advance(30_000);
    await vi.waitFor(() => expect(getBarrier(0).aborted).toBe(true), { timeout: 300 });

    // 3. Retry 1: wait for retry timer on FakeClock, advance 500ms
    await vi.waitFor(() => expect(clock.pending()).toBe(1), { timeout: 300 });
    clock.advance(500);
    await getBarrier(1).received;
    expect(eventPollCount).toBe(2);

    // Attempt 2 deadline: advance 30s
    clock.advance(30_000);
    await vi.waitFor(() => expect(getBarrier(1).aborted).toBe(true), { timeout: 300 });

    // 4. Retry 2: wait for retry timer, advance 500ms
    await vi.waitFor(() => expect(clock.pending()).toBe(1), { timeout: 300 });
    clock.advance(500);
    await getBarrier(2).received;
    expect(eventPollCount).toBe(3);

    // Attempt 3 deadline: advance 30s -> terminal error
    clock.advance(30_000);
    await vi.waitFor(
      () =>
        expect(events).toContainEqual({
          kind: "error",
          code: "unreachable",
        }),
      { timeout: 300 }
    );
    expect(voice.voiceSession().active).toBe(false);
    voice.close();
  });

  it("aborts in-flight event polling HTTP request on close without leaking requests or firing stale callbacks", async () => {
    let eventPollCount = 0;
    let requestAborted = false;
    let serverResponse: ServerResponse | undefined;
    const firstPollBarrier = Promise.withResolvers<void>();

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ call_id: "vc_1", sdp: "answer-sdp" }));
        return;
      }
      if (req.url.includes("/events")) {
        eventPollCount++;
        serverResponse = res;
        res.on("close", () => {
          if (!res.writableEnded) {
            requestAborted = true;
          }
        });
        firstPollBarrier.resolve();
        // Stall the events request
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const events: PushToTalkCallEvent[] = [];
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });
    voice.onEvent((event) => events.push(event));

    await voice.open();
    const { generation } = voice.voiceSession();
    await voice.voiceOffer({ generation, sdp: "offer" });

    // 1. Explicit arrival barrier: wait for HTTP poll request to arrive and stall
    await firstPollBarrier.promise;
    expect(eventPollCount).toBe(1);
    expect(requestAborted).toBe(false);

    // 2. Teardown / close while HTTP poll is in-flight
    voice.close();

    // The in-flight HTTP request MUST be aborted immediately on close
    await vi.waitFor(() => expect(requestAborted).toBe(true), { timeout: 300 });

    // Late server completion must not emit events or fire callbacks
    if (serverResponse && !serverResponse.writableEnded) {
      try {
        serverResponse.writeHead(200, { "content-type": "application/json" });
        serverResponse.end(
          JSON.stringify({
            events: [
              { kind: "caption", role: "agent", turn: 1, text: "late", final: true },
            ],
            cursor: 1,
            truncated: false,
          })
        );
      } catch {
        // Socket already destroyed
      }
    }
    await flush();

    expect(events.filter((e) => e.kind === "caption")).toHaveLength(0);
  });

  it("aborts in-flight event polling HTTP request on account switch without leaking requests or affecting new call", async () => {
    let callAEventsAborted = false;
    let callBEventsReceived = false;

    const callAPollBarrier = Promise.withResolvers<void>();
    const callBPollBarrier = Promise.withResolvers<void>();

    const targetA = { workspaceId: "wsp_A", groupId: "grp_A", conversationId: "cnv_A" };
    const targetB = { workspaceId: "wsp_B", groupId: "grp_B", conversationId: "cnv_B" };
    let currentTarget = targetA;

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        const isCallB = req.url.includes("wsp_B");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ call_id: isCallB ? "vc_B" : "vc_A", sdp: "answer-sdp" })
        );
        return;
      }
      if (req.url.includes("wsp_A") && req.url.includes("/events")) {
        res.on("close", () => {
          if (!res.writableEnded) {
            callAEventsAborted = true;
          }
        });
        callAPollBarrier.resolve();
        // Stall call A events request
        return;
      }
      if (req.url.includes("wsp_B") && req.url.includes("/events")) {
        callBEventsReceived = true;
        callBPollBarrier.resolve();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: [], cursor: 0, truncated: false }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const events: PushToTalkCallEvent[] = [];
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => currentTarget,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });
    voice.onEvent((event) => events.push(event));

    // Open call A
    await voice.open();
    const genA = voice.voiceSession().generation;
    await voice.voiceOffer({ generation: genA, sdp: "offer-A" });

    // 1. Explicit arrival barrier: wait for call A's events request to arrive and stall
    await callAPollBarrier.promise;
    expect(callAEventsAborted).toBe(false);

    // 2. Switch account to target B: voice.open() resolves target B and tears down previous call
    currentTarget = targetB;
    await voice.open();
    const genB = voice.voiceSession().generation;
    await voice.voiceOffer({ generation: genB, sdp: "offer-B" });

    // Call A's in-flight events poll must be aborted on teardown
    await vi.waitFor(() => expect(callAEventsAborted).toBe(true), { timeout: 300 });

    // New call B operates cleanly
    await callBPollBarrier.promise;
    expect(callBEventsReceived).toBe(true);
    expect(voice.voiceSession().active).toBe(true);
    voice.close();
  });

  it("aborts hung startVoiceCall offer after 30s deadline, emitting actionable error without activating call or accepting stale answer", async () => {
    let offerRequestAborted = false;
    let offerResponse: ServerResponse | undefined;
    const offerBarrier = Promise.withResolvers<void>();

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        offerResponse = res;
        res.on("close", () => {
          if (!res.writableEnded) {
            offerRequestAborted = true;
          }
        });
        offerBarrier.resolve();
        // Stall the startVoiceCall response
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const events: PushToTalkCallEvent[] = [];
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => target,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });
    voice.onEvent((event) => events.push(event));

    await voice.open();
    const { generation } = voice.voiceSession();
    const offerPromise = voice.voiceOffer({ generation, sdp: "offer" });

    // 1. Explicit arrival barrier: wait for POST /calls offer request to arrive at the server
    await offerBarrier.promise;
    expect(offerRequestAborted).toBe(false);

    // 2. Advance 30s offer budget: hung offer must be aborted by deadline
    clock.advance(30_000);
    await vi.waitFor(() => expect(offerRequestAborted).toBe(true), { timeout: 300 });

    // Offer returns null and emits actionable error
    await expect(offerPromise).resolves.toBeNull();
    expect(events).toContainEqual({
      kind: "error",
      code: "unreachable",
    });
    expect(voice.voiceSession().active).toBe(false);

    // 3. Stale late answer from server must not activate or revive the call
    if (offerResponse && !offerResponse.writableEnded) {
      try {
        offerResponse.writeHead(201, { "content-type": "application/json" });
        offerResponse.end(JSON.stringify({ call_id: "vc_late", sdp: "late-sdp" }));
      } catch {
        // Socket already destroyed
      }
    }
    await flush();

    expect(voice.voiceSession().active).toBe(false);
    voice.close();
  });

  it("aborts hung DELETE cleanup after 30s deadline on close without affecting replacement call or original account", async () => {
    let deleteRequestAborted = false;
    let deleteWorkspace: string | undefined;
    const deleteBarrier = Promise.withResolvers<void>();
    const callBPollBarrier = Promise.withResolvers<void>();

    const targetA = { workspaceId: "wsp_A", groupId: "grp_A", conversationId: "cnv_A" };
    const targetB = { workspaceId: "wsp_B", groupId: "grp_B", conversationId: "cnv_B" };
    let currentTarget = targetA;

    const { api } = await createVoiceHttpServer((req, res) => {
      if (req.method === "POST" && req.url.includes("/voice/calls")) {
        const isCallB = req.url.includes("wsp_B");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ call_id: isCallB ? "vc_B" : "vc_A", sdp: "answer-sdp" })
        );
        return;
      }
      if (req.url.includes("/events")) {
        if (req.url.includes("wsp_B")) {
          callBPollBarrier.resolve();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: [], cursor: 0, truncated: false }));
        return;
      }
      if (req.method === "DELETE" && req.url.includes("/voice/calls")) {
        const match = req.url.match(/workspaces\/([^/]+)\/voice/);
        deleteWorkspace = match?.[1];
        res.on("close", () => {
          if (!res.writableEnded) {
            deleteRequestAborted = true;
          }
        });
        deleteBarrier.resolve();
        // Stall the DELETE response
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const clock = new FakeClock();
    const voice = new GptLiveVoice({
      api: () => api,
      resolveTarget: async () => currentTarget,
      runOwned: async (fn) => fn(),
      host: {
        open: async () => undefined,
        close: () => undefined,
        publish: () => undefined,
      },
      clock,
    });

    // 1. Open call A and establish connection
    await voice.open();
    const genA = voice.voiceSession().generation;
    await voice.voiceOffer({ generation: genA, sdp: "offer-A" });
    await flush();

    // 2. Local close initiates DELETE cleanup for call A
    voice.close();
    expect(voice.voiceSession().active).toBe(false);

    // Explicit arrival barrier: wait for DELETE request to reach server
    await deleteBarrier.promise;
    expect(deleteWorkspace).toBe("wsp_A");
    expect(deleteRequestAborted).toBe(false);

    // 3. Open replacement call B on Target B while DELETE on Target A is still hung
    currentTarget = targetB;
    await voice.open();
    const genB = voice.voiceSession().generation;
    await voice.voiceOffer({ generation: genB, sdp: "offer-B" });
    await callBPollBarrier.promise;

    // Replacement call B is healthy and active
    expect(voice.voiceSession().active).toBe(true);

    // 4. Advance 30s cleanup budget: hung DELETE on Call A must be aborted
    clock.advance(30_000);
    await vi.waitFor(() => expect(deleteRequestAborted).toBe(true), { timeout: 300 });

    // Replacement call B remains active and unaffected
    expect(voice.voiceSession().active).toBe(true);
    voice.close();
  });
});
