import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readTranscriptionStream } from "../modules/audio-capture/transcription-stream";
import {
  RemotePushToTalkTranscriber,
  stripTranscriptLabels,
} from "../push-to-talk/remote-transcriber";
import { PushToTalkTranscriptionError } from "../push-to-talk/transcriber";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } }
  );
}

function event(data: unknown) {
  return `event: transcription\ndata: ${JSON.stringify(data)}\n\n`;
}

const ready = (transcript: string) => ({
  status: "ready",
  result: { transcript, duration_seconds: 4, chunks: [] },
});

describe("readTranscriptionStream", () => {
  it("reads the transcription event split across chunks after keep-alives", async () => {
    const body = event(ready("[00:00:01] Speaker 1: oi"));
    const result = await readTranscriptionStream(
      sse([": keep-alive\n\n", body.slice(0, 20), body.slice(20)])
    );
    expect(result).toEqual(ready("[00:00:01] Speaker 1: oi"));
  });

  it("returns the server's error reason", async () => {
    expect(
      await readTranscriptionStream(
        sse([event({ status: "error", reason: "local_asr_model_not_installed" })])
      )
    ).toEqual({ status: "error", reason: "local_asr_model_not_installed" });
  });

  it("returns nothing for a stream that ends without the event", async () => {
    expect(await readTranscriptionStream(sse([": keep-alive\n\n"]))).toBeUndefined();
  });
});

describe("stripTranscriptLabels", () => {
  it("removes the clock and speaker labels and joins the lines", () => {
    expect(
      stripTranscriptLabels(
        "[00:00:01] Speaker 1: o que esse botão\n[00:00:03] faz?\n\n[01:02:03] Speaker 12: ok"
      )
    ).toBe("o que esse botão faz? ok");
  });

  it("keeps a text without labels", () => {
    expect(stripTranscriptLabels("  Speaker notes: no clock here ")).toBe(
      "Speaker notes: no clock here"
    );
  });
});

function remote(response: () => Response) {
  const root = mkdtempSync(join(tmpdir(), "comma-ptt-remote-"));
  roots.push(root);
  const wavPath = join(root, "turn.wav");
  writeFileSync(wavPath, "wav");
  const m4aPath = join(root, "turn.m4a");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  const transcriber = new RemotePushToTalkTranscriber({
    encoder: {
      encode: async (source) => {
        expect(source).toBe(wavPath);
        writeFileSync(m4aPath, "m4a");
        return m4aPath;
      },
    },
    bindSession: () => ({
      fetch,
      url: new URL("https://api.example/v1/comma/me/recordings/transcribe"),
      assertCurrent: () => undefined,
    }),
    runOwned: (handler) => handler(),
  });
  return { transcriber, fetch, wavPath, m4aPath };
}

async function code(promise: Promise<unknown>) {
  const error = await promise.catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(PushToTalkTranscriptionError);
  return (error as PushToTalkTranscriptionError).code;
}

describe("RemotePushToTalkTranscriber", () => {
  it("uploads the M4A, cleans the labels and deletes the M4A", async () => {
    const { transcriber, fetch, wavPath, m4aPath } = remote(() =>
      sse([event(ready("[00:00:00] Speaker 1: abre o relatório"))])
    );
    expect(await transcriber.ready()).toBe(true);
    expect(await transcriber.transcribe(wavPath)).toEqual({
      text: "abre o relatório",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.example/v1/comma/me/recordings/transcribe"),
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "audio/mp4", accept: "text/event-stream" },
      })
    );
    expect(existsSync(m4aPath)).toBe(false);
  });

  it("maps a missing server model to transcription_unavailable", async () => {
    const { transcriber, wavPath, m4aPath } = remote(() =>
      sse([event({ status: "error", reason: "local_asr_model_not_installed" })])
    );
    expect(await code(transcriber.transcribe(wavPath))).toBe(
      "transcription_unavailable"
    );
    expect(existsSync(m4aPath)).toBe(false);
  });

  it("maps a cloud failure and an HTTP error to transcription_failed", async () => {
    const cloud = remote(() =>
      sse([event({ status: "error", reason: "cloud_asr_failed:cloud_quota" })])
    );
    expect(await code(cloud.transcriber.transcribe(cloud.wavPath))).toBe(
      "transcription_failed"
    );
    const http = remote(() => new Response("nope", { status: 503 }));
    expect(await code(http.transcriber.transcribe(http.wavPath))).toBe(
      "transcription_failed"
    );
  });

  it("binds the session inside a Main-owned admission, not the hotkey's context", async () => {
    // The turn starts from the native hotkey, outside any renderer call, so the
    // session can only be bound inside the guard's own admission.
    const admission = new AsyncLocalStorage<true>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      sse([event(ready("abre o relatório"))])
    );
    const root = mkdtempSync(join(tmpdir(), "comma-ptt-remote-"));
    roots.push(root);
    const wavPath = join(root, "turn.wav");
    writeFileSync(wavPath, "wav");
    const transcriber = new RemotePushToTalkTranscriber({
      encoder: {
        encode: async () => {
          writeFileSync(join(root, "turn.m4a"), "m4a");
          return join(root, "turn.m4a");
        },
      },
      bindSession: () => {
        if (!admission.getStore())
          throw new Error("No native Session admission context is active.");
        return {
          fetch,
          url: new URL("https://api.example/v1/comma/me/recordings/transcribe"),
          assertCurrent: () => undefined,
        };
      },
      runOwned: (handler) => admission.run(true, handler),
    });
    expect(await transcriber.transcribe(wavPath)).toEqual({ text: "abre o relatório" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
