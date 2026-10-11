import { messages, type CommaLocale } from "@comma/i18n";

export type DriveBackendErrorCode =
  | "unsafe_path"
  | "node_unavailable"
  | "drive_unavailable"
  | "space_unavailable"
  | "recording_missing"
  | "preview_too_large"
  | "incomplete_file"
  | "import_unsupported"
  | "upload_too_large"
  | "read_only"
  | "invalid_listing";

/**
 * A failure the Drive backend itself detects. The message stays English for
 * logs; what the person reads comes from `driveErrorDescription`.
 */
export class DriveBackendError extends Error {
  readonly code: DriveBackendErrorCode;

  constructor(code: DriveBackendErrorCode, message: string) {
    super(message);
    this.name = "DriveBackendError";
    this.code = code;
  }
}

const driveBackendErrorMessages = {
  unsafe_path: messages.drive_error_unsafe_path,
  node_unavailable: messages.drive_error_node_unavailable,
  drive_unavailable: messages.drive_error_unavailable,
  space_unavailable: messages.drive_error_space_unavailable,
  recording_missing: messages.drive_error_recording_missing,
  preview_too_large: messages.drive_error_preview_too_large,
  incomplete_file: messages.drive_error_incomplete_file,
  import_unsupported: messages.drive_error_import_unsupported,
  upload_too_large: messages.drive_error_upload_too_large,
  read_only: messages.drive_error_read_only,
  invalid_listing: messages.drive_error_invalid_listing,
} satisfies Record<DriveBackendErrorCode, unknown>;

/**
 * The sentence shown for a failed Drive operation: the backend's own failures
 * by code in the app's language, the native node's reason as it sent it, and
 * `fallback` when there is nothing to say.
 */
export function driveErrorDescription(
  error: unknown,
  fallback: string,
  locale: CommaLocale
): string {
  if (error instanceof DriveBackendError) {
    return driveBackendErrorMessages[error.code](undefined, { locale });
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
