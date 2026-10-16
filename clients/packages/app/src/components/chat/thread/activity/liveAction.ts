import type { useCommaMessages } from "@comma/i18n/react";
import { toolActivityLabel } from "./toolActivityLabel";

type CommaMessages = ReturnType<typeof useCommaMessages>;

/** The current action of one Participant, as the indicator shows it. */
export type LiveAction = {
  /** Equal for every frame of one action; a new tool call is a new action. */
  identity: string;
  label: string;
  /**
   * Model-written goal, else the producer-admitted file, program or host,
   * else the public tool identifier when no wording names the tool.
   */
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
  const worded = toolActivityLabel(messages, frame.toolName, "running");
  // A public execution frame names its tool. Without wording for it, the
  // identifier itself is the technical detail, never a guess from prose.
  const identifier = worded ? undefined : toolIdentifier(frame.toolName);
  const detail = frame.goal?.trim() || frame.detail?.trim() || identifier || undefined;
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
      worded ??
      (identifier ? messages.chat_tool_generic() : messages.chat_activity_working()),
    ...(detail ? { detail } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

// Identifier-shaped names only (`env.runtime_targets`, `Bash`,
// `mcp__docs__search`, `commandExecution`); other text is not shown.
function toolIdentifier(toolName: string | undefined) {
  const name = toolName?.trim();
  return name && /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(name) ? name : undefined;
}

/** Whole seconds of an action that started at `startedAtMs`, never negative. */
export function elapsedSeconds(startedAtMs: number, nowMs: number) {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}
