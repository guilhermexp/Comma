import { CommaApiError } from "../../api";

export type AgendaErrorCode =
  | "write_permission"
  | "conflict"
  | "access"
  | "timeout"
  | "unavailable"
  | "read_only"
  | "not_found"
  | "generic";

// C1 (Google) and C2 (Mac) error codes, as the screen tells them apart.
const codes: Record<string, AgendaErrorCode> = {
  calendar_write_permission_required: "write_permission",
  calendar_event_conflict: "conflict",
  composio_access_denied: "access",
  composio_reauthorization_required: "access",
  composio_account_not_owned: "access",
  calendar_access_denied: "access",
  provider_timeout: "timeout",
  provider_unavailable: "unavailable",
  calendar_unavailable: "unavailable",
  calendar_read_only: "read_only",
  calendar_event_not_found: "not_found",
};

function errorName(error: unknown): string | undefined {
  if (error instanceof CommaApiError) return String(error.body?.error ?? error.message);
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code);
  if (error instanceof Error) return error.message;
}

export function agendaErrorCode(error: unknown): AgendaErrorCode {
  const name = errorName(error);
  return (name && codes[name]) || "generic";
}

/** Whether the fix is reconnecting the account in Plugins. */
export function agendaErrorNeedsReconnect(code: AgendaErrorCode) {
  return code === "write_permission" || code === "access";
}
