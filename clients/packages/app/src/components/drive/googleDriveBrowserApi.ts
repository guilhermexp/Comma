import { z } from "zod";
import type { CommaApiClient } from "../../api";

const onlineFileSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(4096),
  mime_type: z.string().min(1).max(256),
  modified_at: z.string().nullable(),
  viewed_at: z.string().nullable(),
  url: z.string().nullable(),
  shortcut: z.object({ id: z.string(), mime_type: z.string() }).nullable(),
});
const pageSchema = z.object({
  files: z.array(onlineFileSchema).max(50),
  next_cursor: z.string().min(1).max(8192).nullable(),
  incomplete: z.boolean(),
});
export type GoogleDriveFile = z.infer<typeof onlineFileSchema>;
export type GoogleDrivePage = z.infer<typeof pageSchema>;
export type GoogleDriveTab = "recent" | "my_drive" | "shared";
export type GoogleDriveSort = "recent" | "name" | "name_desc" | "modified" | "viewed";
export type GoogleDriveLocation = {
  tab: GoogleDriveTab;
  folder_id?: string;
  search: string;
  sort: GoogleDriveSort;
  cursor?: string;
};
export function browseGoogleDrive(
  api: CommaApiClient,
  workspace: string,
  account: string,
  location: GoogleDriveLocation,
  signal: AbortSignal
) {
  return api
    .composioCommand(
      workspace,
      "google_drive",
      { account_id: account, ...location },
      { signal }
    )
    .then((value) => pageSchema.parse(value));
}
export function safeGoogleDriveUrl(value: string | null): string | undefined {
  if (!value || value.length > 2083) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ["drive.google.com", "docs.google.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      /^\/(?:file\/d\/|drive\/(?:u\/\d+\/)?folders\/|(?:document|spreadsheets|presentation|drawings|forms)\/d\/)[A-Za-z0-9_-]+(?:\/|$)/.test(
        url.pathname
      )
    )
      return value;
  } catch {
    /* An invalid provider destination stays unavailable. */
  }
}
export function googleDriveFolder(file: GoogleDriveFile): string | undefined {
  if (file.mime_type === "application/vnd.google-apps.folder") return file.id;
  if (file.shortcut?.mime_type === "application/vnd.google-apps.folder")
    return file.shortcut.id;
}
