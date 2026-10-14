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
6. Enter a name in **Search names** and select **Search**. To clear the search,
   clear the field and submit again. Search applies to the current tab or folder.
7. Use the sort selector to change the order. Use **Next page** or
   **Previous page** to browse more results. **First page** returns to the start.
8. Select list or grid view. Both show the same page of files.
9. Select **Refresh** to read the current view again. Returning from Local Drive
   also refreshes the online source and retains its location.
10. Select a file to open its Google destination through Comma's existing opener.
    A file without a supported Google destination cannot be opened here.

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

Online browsing does not download file contents, write provider files, grant
Agents access or enable Routines. Agent permissions and Routine source consent
remain separate settings. This browser does not publish file metadata to a
workspace conversation. Switch to **Local Drive** to use local file operations.
