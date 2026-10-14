# Google Drive online browser: clean-room feature matrix

This implementation extends Comma's existing Drive surface. It does not copy
provider artwork, private filenames, screenshots, or another application's code.
The supplied screenshots establish visible behavior only. Comma's tokens,
Central Icons, controls and ScrollArea establish the visual system.

| Reference behavior | Comma behavior | Boundary |
| --- | --- | --- |
| Source sidebar | Local Drive and Google Drive source buttons | Local Synchronicity remains the local owner. |
| Google Drive heading and compact search | Search names on explicit submission | Search stays in the active tab or folder. |
| Three horizontal tabs | Recent, My Drive, Shared with me | Shared with me does not mean shared drives. |
| Folder and file rows | MIME type labels, folder and shortcut navigation | No recursive crawl or per-file metadata requests. |
| List and grid controls | Two presentations of the same page | A presentation change makes no provider request. |
| Activity dates | Separate modified and last-viewed dates | Modification never means opened. Recent uses provider recency. |
| Online provider content | Explicit refresh and refresh on source re-entry | No polling, offline mirror, download or provider write. |
| File opening | Validated Google destination through the existing opener | HTTPS Drive/Docs file paths only; no new native capability. |

## Provider contract

[Official Composio Google Drive toolkit](https://docs.composio.dev/toolkits/googledrive),
read on 2026-10-13, identifies version `20261001_00`, the current
`GOOGLEDRIVE_FIND_FILE` action and deprecated `GOOGLEDRIVE_LIST_FILES`.
The brief supplies the verified action schema: `q`, `fields`, `folder_id`,
`orderBy`, `pageSize`, `pageToken`, `supportsAllDrives`,
`includeItemsFromAllDrives` and `corpora`. The browser requests 50 items.
My Drive supplies `folder_id: root`; folders supply their exact ID.
Shared with me at the tab root uses `sharedWithMe = true`. Name queries escape
backslashes and quotes. Opaque page tokens are unchanged.

The brief also supplies the earlier live Connect shape:
`data.results[0].response.data.files`, with outer and inner successful results,
`nextPageToken` and `incompleteSearch`. The saved live evidence was lost.
This worker did not call a live provider. HTTP fixture tests exercise the wrapper,
project sessions, failed inner results, incomplete search and unsupported previews.
The existing complete-result reader handles supported offload descriptors;
unsupported envelopes fail visibly.

Connect OAuth uses MCP. Project mode uses a restricted project action session.
Neither mode changes Agent grants or Routine consent. Every content dispatch
rechecks current workspace authority, exact account, mode and active status.
A response cannot restore rows after its account, tab, folder, search or workspace
has changed.

## Proof limits

Component and HTTP integration tests cover navigation and authorization behavior.
They do not prove native opening, real Google account visibility, visual fit or
live provider freshness. Main performs the Electron acceptance steps in the delivery report.
