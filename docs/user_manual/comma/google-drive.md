# Google Drive in Comma

The **Drive** tab has two sources. **Local Drive** uses Comma's existing
Synchronicity folders and synchronization. **Google Drive** shows online files
from your current workspace's connected Google account. It does not create an
offline mirror or synchronize Google files to local folders.

## Browse online files

1. Open **Drive**.
2. Select **Google Drive** in the source sidebar.
3. If Comma shows account choices, select the Google account. Connections to the
   same identity keep separate connection numbers.
4. Select **Recent**, **My Drive** or **Shared with me**.
5. Select a folder to open it. Use **Back** or a breadcrumb to return.
6. Type in **Search names**. Search runs after you stop typing and applies to
   the current tab or folder. Select **Clear search** to remove the filter.
7. Open the sort menu to change the order. Scroll toward the bottom to load the
   next page. A failed next page keeps the loaded files and offers **Retry**.
8. The browser starts in grid view. **My Drive** and folders separate **Folders**
   from **Items**. List view shows the same loaded files with both timestamps.
9. Select **Refresh** to read the current view again. Returning from Local Drive
   also refreshes the online source and retains its location.
10. In Electron, select a file to open its Google page in the Drive area. Use
    **Back to files** to restore the list and its scroll position. The toolbar
    also provides page back, forward, reload, and **Open in browser**.
    Web builds open the file in the external browser. Unsupported destinations
    remain unavailable.

The account selector appears when more than one connected account is available.
The Electron viewer has a separate persistent Google browser session. Sign in
there with the account that can access the file. Composio authorization does
not sign this browser session in. Google credentials stay separate from Comma's
application session. Foreign page links open in the external browser. Browser
sign-in and file permissions remain controlled by Google.

**Recent** uses Google's recency order. **Modified** and **Last viewed by you**
show distinct provider timestamps. A modified date does not mean that you opened
the file. **Shared with me** shows items shared with your account; it is not a
shared-drive directory.

## Connection and errors

Opening Google Drive detects an already authorized account automatically and
loads its files. This also works after an authorization attempt expires.
Opening the connector detail or Plugins catalog can also detect the account.
If authorized accounts have different identities, choose the account to use.
Comma preserves existing connections and accounts that you disabled. To use a
disabled account again, select **Enable in Comma** in its account menu in Plugins.

If no authorized account is available, select **Open Plugins** and connect Google
Drive. Complete authorization in the browser, then return to Comma. Opening the
Drive tab does not start OAuth or require a new attempt for an authorized account.
If the connection is unavailable, verify or reconnect it in Plugins, then retry.
An incomplete search has a warning. An unsupported or failed provider result has
an error and a retry action. Neither state means that your Drive is empty.

Listing files does not download their contents or write provider files. Opening
a file loads its Google page; actions on that page use your Google browser
session. Neither listing nor opening grants Agents access or enables Routines. Agent permissions and Routine source consent
remain separate settings. This browser does not publish file metadata to a
workspace conversation. Switch to **Local Drive** to use local file operations.
