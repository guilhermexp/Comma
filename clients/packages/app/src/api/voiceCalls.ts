import { z } from "zod";

export const voiceCallAnswerSchema = z.object({
  call_id: z.string(),
  sdp: z.string(),
});
export const voiceCallEventSchema = z.discriminatedUnion("kind", [
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
export const voiceCallEventsSchema = z.object({
  events: z.array(voiceCallEventSchema),
  cursor: z.number().int(),
  truncated: z.boolean(),
});
export type VoiceCallAnswer = z.infer<typeof voiceCallAnswerSchema>;
export type VoiceCallEvents = z.infer<typeof voiceCallEventsSchema>;
export type VoiceCallEvent = z.infer<typeof voiceCallEventSchema>;
