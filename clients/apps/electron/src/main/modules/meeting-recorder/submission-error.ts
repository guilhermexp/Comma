import { CommaApiError } from "@comma/app/api";
import { messages, type CommaLocale } from "@comma/i18n";
import { LocalFileRouteRegistrationError } from "../local-files/registration";
import { LocalFileSnapshotError } from "../local-files/snapshot-store";

export type MeetingSubmissionStage =
  | "journal"
  | "prepare"
  | "snapshot"
  | "register"
  | "submit"
  | "confirm";

export function meetingSubmissionError(
  stage: MeetingSubmissionStage,
  error: unknown,
  locale: CommaLocale
): string {
  // Do not expose response bodies, credentials, host paths, or arbitrary exception messages.
  const options = { locale };
  let detail = messages.electron_meeting_submission_unexpected({}, options);
  if (error instanceof CommaApiError)
    detail = messages.electron_meeting_submission_http(
      { status: error.status },
      options
    );
  else if (error instanceof LocalFileRouteRegistrationError)
    detail = error.remediation
      ? messages.electron_meeting_submission_reconnect_connector({}, options)
      : error.retryable
        ? messages.electron_meeting_submission_registration_unavailable({}, options)
        : messages.electron_meeting_submission_registration_rejected({}, options);
  else if (error instanceof LocalFileSnapshotError)
    detail = messages.electron_meeting_submission_local_file(
      { errorClass: error.errorClass },
      options
    );
  else if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    detail = messages.electron_meeting_submission_timeout({}, options);
  else if (error instanceof TypeError)
    detail = messages.electron_meeting_submission_request_failed({}, options);
  else if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["ENOSPC", "EACCES", "EPERM", "EIO", "ENOENT"].includes(String(error.code))
  )
    detail = messages.electron_meeting_submission_local_storage(
      { code: String(error.code) },
      options
    );
  return messages.electron_meeting_submission_failed({ stage, detail }, options);
}

export function canRetryMeetingSubmission(
  stage: MeetingSubmissionStage,
  error: unknown
) {
  if (stage !== "register" && stage !== "submit") return false;
  if (error instanceof LocalFileRouteRegistrationError) return error.retryable;
  if (error instanceof CommaApiError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}
