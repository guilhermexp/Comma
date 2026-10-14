/** The initial destination uses the same closed file-path contract as the Drive API. */
export function isGoogleDriveFileUrl(value: string): boolean {
  if (value.length > 2083) return false;
  try {
    const url = new URL(value);
    return (
      isGoogleNavigationUrl(value) &&
      ["drive.google.com", "docs.google.com"].includes(url.hostname) &&
      /^\/(?:file\/d\/|drive\/(?:u\/\d+\/)?folders\/|(?:document|spreadsheets|presentation|drawings|forms)\/d\/)[A-Za-z0-9_-]+(?:\/|$)/.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}
// Exact document/auth origins, never a google.com suffix wildcard. Static assets
// are subresources; they do not need permission to become the top-level page.
export function isGoogleNavigationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        "drive.google.com",
        "docs.google.com",
        "accounts.google.com",
        "accounts.youtube.com",
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export const GOOGLE_DRIVE_PARTITION = "persist:comma-google-drive";
