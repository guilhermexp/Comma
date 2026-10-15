import type { useCommaMessages } from "@comma/i18n/react";
import { toolActivityLabel } from "./toolActivityLabel";

type CommaMessages = ReturnType<typeof useCommaMessages>;

/** The current action of one Participant, as the indicator shows it. */
export type LiveAction = {
  /** Equal for every frame of one action; a new tool call is a new action. */
  identity: string;
  label: string;
  /** Model-written goal, else the producer-admitted file, program or host. */
  detail?: string | undefined;
  /** Producer start evidence in epoch milliseconds; absent when unknown. */
  startedAtMs?: number | undefined;
};

type ActionFrame = {
  detail?: string | undefined;
  goal?: string | undefined;
  phase?: string | undefined;
  responseKey?: string | undefined;
  startedAt?: number | undefined;
  status?: string | undefined;
  summaryClass?: string | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
};

/**
 * The running tool call in a public execution frame, worded in the reader's
 * language. `scope` names the owner (a Participant), so equal call ids from
 * different owners stay different actions. Time is known only when the frame
 * names its call and that call's start; it is never taken from receipt.
 */
export function liveExecutionAction(
  messages: CommaMessages,
  frame: ActionFrame | undefined,
  scope: string
): LiveAction | undefined {
  if (
    frame?.status !== "running" ||
    frame.phase !== "execution" ||
    frame.summaryClass !== "public"
  ) {
    return undefined;
  }
  const detail = frame.goal?.trim() || frame.detail?.trim() || undefined;
  const startedAtMs =
    frame.toolCallId !== undefined &&
    frame.startedAt !== undefined &&
    Number.isFinite(frame.startedAt) &&
    frame.startedAt > 0
      ? frame.startedAt * 1000
      : undefined;
  return {
    identity: JSON.stringify([
      scope,
      frame.responseKey,
      frame.toolCallId,
      frame.toolName,
    ]),
    label:
      toolActivityLabel(messages, frame.toolName, "running") ??
      messages.chat_activity_working(),
    ...(detail ? { detail } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

/** Whole seconds of an action that started at `startedAtMs`, never negative. */
export function elapsedSeconds(startedAtMs: number, nowMs: number) {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}
