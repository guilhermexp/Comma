import { z } from "zod";

export const voiceCallAnswerSchema = z.object({
  call_id: z.string(),
  sdp: z.string(),
});
/** `read_aloud`: the voice reads only the text it is sent, then stays silent. */
export type VoiceCallMode = "read_aloud";
export const voiceCallSaySchema = z.object({
  queued: z.literal(true),
  chunks: z.number().int(),
});
const callEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started") }),
  z.object({
    kind: z.literal("caption"),
    role: z.enum(["caller", "agent"]),
    turn: z.number().int(),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({ kind: z.literal("closed"), reason: z.string() }),
  z.object({ kind: z.literal("error"), code: z.string() }),
]);
export const voiceCallEventSchema = z.union([
  callEventSchema,
  z.object({
    type: z.literal("delegation"),
    id: z.string(),
    status: z.enum(["pending", "answered"]),
  }),
]);
export const voiceCallEventsSchema = z.object({
  events: z.array(voiceCallEventSchema),
  cursor: z.number().int(),
  truncated: z.boolean(),
});
export type VoiceCallAnswer = z.infer<typeof voiceCallAnswerSchema>;
export type VoiceCallEvents = z.infer<typeof voiceCallEventsSchema>;
export type VoiceCallEvent = z.infer<typeof voiceCallEventSchema>;
export type VoiceCallSay = z.infer<typeof voiceCallSaySchema>;
