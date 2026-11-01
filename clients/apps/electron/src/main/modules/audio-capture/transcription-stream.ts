import { createParser } from "eventsource-parser";
import { z } from "zod";

// The SSE answer of `POST /v1/comma/me/recordings/transcribe`, shared by saved
// recordings and push-to-talk turns.
export const transcriptResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    result: z.object({
      transcript: z.string().max(8_000_000),
      duration_seconds: z.number().int().nonnegative(),
      chunks: z
        .array(
          z.object({
            index: z.number().int().nonnegative(),
            offset_seconds: z.number().nonnegative(),
            transcript: z.string().max(8_000_000),
          })
        )
        .max(48),
      // Contract C7 through the backend (add-cloud-meeting-asr, D6): which
      // provider and model produced it, and why it fell back to this Mac.
      provider: z.enum(["local", "groq", "openai_compatible"]).optional(),
      model: z.string().max(200).optional(),
      fallback: z
        .object({
          from: z.enum(["groq", "openai_compatible"]),
          reason: z.string().max(100),
        })
        .optional(),
    }),
  }),
  z.object({ status: z.literal("error"), reason: z.string().max(500) }),
]);

export type TranscriptResult = z.infer<typeof transcriptResult>;

/**
 * Reads the stream until its `transcription` event; undefined when the stream
 * ends without one. Malformed data rejects.
 */
export async function readTranscriptionStream(
  response: Response
): Promise<TranscriptResult | undefined> {
  if (!response.body) return undefined;
  let result: TranscriptResult | undefined;
  const parser = createParser({
    maxBufferSize: 16 * 1024 * 1024,
    onEvent(event) {
      if (event.event === "transcription")
        result = transcriptResult.parse(JSON.parse(event.data));
    },
    onError(error) {
      throw error;
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (result) break;
    }
    parser.feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return result;
}
