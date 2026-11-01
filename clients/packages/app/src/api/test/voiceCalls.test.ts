import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createCommaApi } from "../client";

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

async function voiceServer(
  response: (path: string) => { status: number; body: unknown }
) {
  const requests: { method: string | undefined; path: string; body: unknown }[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks).toString();
    const path = request.url ?? "";
    requests.push({
      method: request.method,
      path,
      body: bytes ? JSON.parse(bytes) : null,
    });
    const result = response(path);
    reply.writeHead(result.status, { "content-type": "application/json" });
    reply.end(JSON.stringify(result.body));
  });
  servers.push(server);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    api: createCommaApi({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "fixture-session",
    }),
  };
}

describe("push-to-talk voice HTTP contract", () => {
  it("starts a live call and attaches screen context to the exact escaped call", async () => {
    const { api, requests } = await voiceServer((path) =>
      path.endsWith("/context")
        ? { status: 200, body: { accepted: true } }
        : { status: 201, body: { call_id: "vc/2", sdp: "answer-sdp" } }
    );
    await expect(
      api.startVoiceCall("workspace-1", "offer-sdp", { mode: "push_to_talk" })
    ).resolves.toEqual({ call_id: "vc/2", sdp: "answer-sdp" });
    await expect(
      api.appendVoiceCallContext("workspace-1", "vc/2", {
        context_id: 1,
        status: "pending",
      })
    ).resolves.toEqual({ accepted: true });
    await expect(
      api.appendVoiceCallContext("workspace-1", "vc/2", {
        context_id: 1,
        status: "complete",
        text: "App: Editor; cursor: 20,30; screen.png",
        attachments: [
          {
            path: "/uploads/abcdefghijklmnopqrstuv-screen.png",
            name: "screen.png",
            mime: "image/png",
          },
        ],
      })
    ).resolves.toEqual({ accepted: true });
    await expect(
      api.appendVoiceCallContext("workspace-1", "vc/2", {
        context_id: 2,
        status: "failed",
      })
    ).resolves.toEqual({ accepted: true });
    await expect(
      api.appendVoiceCallContext("workspace-1", "vc/2", {
        context_id: 3,
        status: "cancelled",
      })
    ).resolves.toEqual({ accepted: true });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/comma/workspaces/workspace-1/voice/calls",
        body: { sdp: "offer-sdp", mode: "push_to_talk" },
      },
      {
        method: "POST",
        path: "/v1/comma/workspaces/workspace-1/voice/calls/vc%2F2/context",
        body: {
          context_id: 1,
          status: "pending",
        },
      },
      {
        method: "POST",
        path: "/v1/comma/workspaces/workspace-1/voice/calls/vc%2F2/context",
        body: {
          context_id: 1,
          status: "complete",
          text: "App: Editor; cursor: 20,30; screen.png",
          attachments: [
            {
              path: "/uploads/abcdefghijklmnopqrstuv-screen.png",
              name: "screen.png",
              mime: "image/png",
            },
          ],
        },
      },
      {
        method: "POST",
        path: "/v1/comma/workspaces/workspace-1/voice/calls/vc%2F2/context",
        body: {
          context_id: 2,
          status: "failed",
        },
      },
      {
        method: "POST",
        path: "/v1/comma/workspaces/workspace-1/voice/calls/vc%2F2/context",
        body: {
          context_id: 3,
          status: "cancelled",
        },
      },
    ]);
  });

  it.each([
    { status: 409, error: "busy" },
    { status: 429, error: "plan_limit" },
  ])("preserves $error for the notch", async ({ status, error }) => {
    const { api } = await voiceServer(() => ({
      status,
      body: { error, message: "Voice cannot start." },
    }));
    await expect(
      api.startVoiceCall("workspace-1", "offer-sdp", { mode: "push_to_talk" })
    ).rejects.toMatchObject({ status, body: { error } });
  });

  it("supports AbortSignal to cancel file uploads", async () => {
    const { api, requests } = await voiceServer(() => ({
      status: 200,
      body: { path: "/file.png", name: "file.png", size: 10 },
    }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.uploadGroupFile("group-1", {
        data: new Blob(["test"], { type: "image/png" }),
        name: "test.png",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual([]);
  });

  it("keeps the context failure page readable when its delegation has failed", async () => {
    const { api } = await voiceServer((path) =>
      path.includes("/events")
        ? {
            status: 200,
            body: {
              events: [
                { type: "delegation", id: "del_7", status: "failed" },
                { type: "context_failed", context_id: 7 },
                { kind: "closed", reason: "ended" },
              ],
              cursor: 3,
              truncated: false,
            },
          }
        : { status: 404, body: {} }
    );
    const batch = await api.voiceCallEvents("workspace-1", "vc-1", 0);
    expect(batch.events).toEqual([
      { type: "delegation", id: "del_7", status: "failed" },
      { type: "context_failed", context_id: 7 },
      { kind: "closed", reason: "ended" },
    ]);
  });
});
