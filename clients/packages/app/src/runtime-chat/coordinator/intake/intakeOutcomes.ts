import type { ConversationProjection } from "@comma/chat-contract";
import { messages, type CommaLocale } from "@comma/i18n";
import type { ChatAttachmentIntakeOutcome } from "../hostContract";

/** A claimed native intake whose outcome a send may still have to wait for. */
export type ChatEntryAttachmentIntake = {
  dialogOpen: boolean;
  settled: Promise<ChatAttachmentIntakeOutcome>;
};

/**
 * A terminal intake outcome with failed items. It stays on the entry,
 * projected as one failed draft attachment row per item, until each row is
 * removed or retried.
 */
export type ChatAttachmentIntakeFailure = {
  acknowledged: boolean;
  leaseId: string;
  outcome: ChatAttachmentIntakeOutcome;
  resolvedErrorIndexes: Set<number>;
  subscriberId: string;
  surfaceId: string;
};

const INTAKE_FAILURE_ATTACHMENT_PREFIX = "chat-intake-failure:";

/** The failure rows not yet removed or retried. */
export function unresolvedIntakeFailureRows(
  failures: ReadonlyMap<string, ChatAttachmentIntakeFailure>,
  locale: CommaLocale
) {
  return [...failures.entries()].flatMap(([intakeId, failure]) =>
    attachmentIntakeFailureRows(intakeId, failure, locale).filter(
      (_, errorIndex) => !failure.resolvedErrorIndexes.has(errorIndex)
    )
  );
}

/**
 * Resolves the failure row an attachment id names, dropping the failure once
 * every row of it is resolved. False when the id names no failure row.
 */
export function resolveIntakeFailureAttachment(
  failures: Map<string, ChatAttachmentIntakeFailure>,
  attachmentId: string
) {
  const parsed = parseIntakeFailureAttachmentId(attachmentId);
  if (!parsed) return false;
  const failure = failures.get(parsed.intakeId);
  if (!failure) return true;
  const errorCount = failedItemCount(failure);
  if (parsed.errorIndex >= errorCount) return true;
  failure.resolvedErrorIndexes.add(parsed.errorIndex);
  if (failure.resolvedErrorIndexes.size >= errorCount) {
    failures.delete(parsed.intakeId);
  }
  return true;
}

function failedItemCount(failure: ChatAttachmentIntakeFailure) {
  return Math.max(failure.outcome.errorCount, failure.outcome.errors?.length ?? 0);
}

function intakeFailureAttachmentId(intakeId: string, errorIndex: number) {
  return `${INTAKE_FAILURE_ATTACHMENT_PREFIX}${intakeId}:${errorIndex}`;
}

function parseIntakeFailureAttachmentId(id: string) {
  if (!id.startsWith(INTAKE_FAILURE_ATTACHMENT_PREFIX)) return undefined;
  const rest = id.slice(INTAKE_FAILURE_ATTACHMENT_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const errorIndex = Number(rest.slice(separator + 1));
  if (!Number.isSafeInteger(errorIndex) || errorIndex < 0) return undefined;
  return { errorIndex, intakeId: rest.slice(0, separator) };
}

function attachmentIntakeFailureRows(
  intakeId: string,
  failure: ChatAttachmentIntakeFailure,
  locale: CommaLocale
): ConversationProjection["draftAttachments"] {
  const count = failedItemCount(failure);
  return Array.from({ length: count }, (_, errorIndex) => {
    const error = failure.outcome.errors?.[errorIndex];
    return {
      error: error?.message ?? messages.chat_attachment_intake_failed({}, { locale }),
      id: intakeFailureAttachmentId(intakeId, errorIndex),
      isImage: error?.isImage ?? false,
      name: error?.name ?? messages.chat_attachment_selected_file({}, { locale }),
      size: 0,
      status: "failed" as const,
    };
  });
}
