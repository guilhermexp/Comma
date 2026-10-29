import { z } from "zod";

export const voiceCallAnswerSchema = z.object({
  call_id: z.string(),
  sdp: z.string(),
});
/** Opens without a greeting and delegates screen/tool requests to the Router. */
export type VoiceCallMode = "push_to_talk";
export const voiceCallAttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.enum(["image/png", "image/jpeg"]),
});
export type VoiceCallAttachment = z.infer<typeof voiceCallAttachmentSchema>;
export const voiceCallContextSchema = z.discriminatedUnion("status", [
  z.object({
    context_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("pending"),
  }),
  z.object({
    context_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("complete"),
    text: z.string(),
    attachments: z.array(voiceCallAttachmentSchema),
  }),
  z.object({
    context_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("failed"),
  }),
  z.object({
    context_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("cancelled"),
  }),
]);
export type VoiceCallContext = z.infer<typeof voiceCallContextSchema>;
export const voiceCallContextAcceptedSchema = z.object({ accepted: z.literal(true) });
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
    status: z.enum(["pending", "answered", "failed"]),
  }),
  z.object({
    type: z.literal("context_failed"),
    context_id: z.number().int().positive(),
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
export type VoiceCallContextAccepted = z.infer<typeof voiceCallContextAcceptedSchema>;
