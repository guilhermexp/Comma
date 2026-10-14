import { z } from "zod";
import { composioStatusSchema, composioAccountSchema } from "../../api";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import {
  ArrowLeftIcon,
  ChainLinkIcon,
  FileTextIcon,
  Folder1Icon,
  ListBulletsIcon,
  ReloadIcon,
  ScrollArea,
  SearchIcon,
  cx,
} from "@comma/ui";
import { CommaApiError, type CommaApiClient, type ComposioAccount } from "../../api";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";
import { composioAccountPresentation } from "../plugins/composioAccountPresentation";
import { driveSecondaryButton } from "./driveButtonStyles";
import {
  browseGoogleDrive,
  googleDriveFolder,
  safeGoogleDriveUrl,
  type GoogleDriveFile,
  type GoogleDriveLocation,
  type GoogleDrivePage,
  type GoogleDriveSort,
  type GoogleDriveTab,
} from "./googleDriveBrowserApi";

const control =
  "rounded-md border border-button-secondary-border bg-button-secondary-bg px-md py-sm text-sm text-primary focus-visible:outline-none focus-visible:shadow-focus-gray-shadow-xs disabled:opacity-50";
const button = `${driveSecondaryButton} text-sm disabled:opacity-50`;
type Accounts = {
  key: string;
  api: CommaApiClient;
  items: ComposioAccount[];
  cursor: string | null;
  selected: string;
  error?: boolean;
  candidates?: ComposioAccount[];
};
type Listing = {
  api: CommaApiClient;
  key: string;
  page?: GoogleDrivePage;
  error?: "reconnect" | "failed";
};

function fileIcon(file: GoogleDriveFile) {
  const Icon = file.shortcut
    ? ChainLinkIcon
    : googleDriveFolder(file)
      ? Folder1Icon
      : FileTextIcon;
  return <Icon aria-hidden className="size-5 shrink-0 text-tertiary" />;
}

export function GoogleDriveBrowser({
  api,
  workspaceId,
  active,
  onPlugins,
}: {
  api: CommaApiClient;
  workspaceId?: string | undefined;
  active: boolean;
  onPlugins: () => void;
}) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  const [accounts, setAccounts] = useState<Accounts>();
  const [accountsCursor, setAccountsCursor] = useState<string>();
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<GoogleDriveTab>("recent");
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<GoogleDriveSort>("recent");
  const [view, setView] = useState<"list" | "grid">("list");
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [listing, setListing] = useState<Listing>();
  const [openingError, setOpeningError] = useState(false);
  const workspace = workspaceId ?? "";
  const accountsKey = JSON.stringify([workspace, accountsCursor, reload, active]);
  const currentAccounts =
    accounts?.key === accountsKey && accounts.api === api ? accounts : undefined;
  const selectedId = currentAccounts?.items.find(
    (item) => item.id === currentAccounts.selected
  )?.id;
  const folderId = path.at(-1)?.id;
  const location = useMemo<GoogleDriveLocation>(
    () => ({
      tab,
      search,
      sort,
      ...(folderId ? { folder_id: folderId } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [tab, search, sort, folderId, cursor]
  );
  const key = JSON.stringify([accountsKey, selectedId, location]);
  const current =
    listing?.key === key && listing.api === api && active ? listing : undefined;
  const generation = useRef(0);
  const accountsMode = useRef<string | undefined>(undefined);
  const accountChoice = useRef<{ workspace: string; id: string } | undefined>(
    undefined
  );

  useEffect(() => {
    if (!active || !workspace) return;
    const controller = new AbortController();
    let live = true;
    const timeout = setTimeout(() => controller.abort(), 35_000);
    const choice = accountChoice.current;
    accountChoice.current = undefined;
    const selectedChoice = choice?.workspace === workspace ? choice.id : undefined;
    const load = accountsCursor
      ? api
          .composioCommand(
            workspace,
            "accounts",
            { cursor: accountsCursor },
            { signal: controller.signal }
          )
          .then((result) => ({
            accounts: result.items as ComposioAccount[],
            next_cursor: result.next_cursor as string | null,
            mode: accountsMode.current,
          }))
      : api.getComposio(workspace, { signal: controller.signal });
    void load
      .then(async (loaded) => {
        if (!live || controller.signal.aborted) return;
        let result = loaded;
        let candidates: ComposioAccount[] = [];
        if (
          !accountsCursor &&
          result.mode === "connect" &&
          "status" in result &&
          result.status === "connected" &&
          (selectedChoice ||
            !result.accounts.some(
              (item) =>
                item.toolkit === "googledrive" &&
                item.mode === "connect" &&
                item.status === "ACTIVE" &&
                item.enabled
            ))
        ) {
          const reconciled = composioStatusSchema
            .extend({ remote_accounts: z.array(composioAccountSchema).default([]) })
            .parse(
              await api.composioCommand(
                workspace,
                "reconcile_accounts",
                {
                  toolkit: "googledrive",
                  ...(selectedChoice ? { account_id: selectedChoice } : {}),
                },
                { signal: controller.signal }
              )
            );
          result = reconciled;
          candidates = reconciled.remote_accounts.filter(
            (item) =>
              item.toolkit === "googledrive" &&
              item.mode === "connect" &&
              item.status === "ACTIVE"
          );
        }
        if (!live || controller.signal.aborted) return;
        accountsMode.current = result.mode;
        const items = result.accounts.filter(
          (item) =>
            item.toolkit === "googledrive" &&
            item.status === "ACTIVE" &&
            item.enabled &&
            item.mode === result.mode
        );
        setAccounts((old) => ({
          key: accountsKey,
          api,
          items,
          candidates: items.length === 0 ? candidates : [],
          cursor: result.next_cursor,
          selected:
            items.find((item) => item.id === old?.selected)?.id ?? items[0]?.id ?? "",
        }));
      })
      .catch(() => {
        if (live)
          setAccounts({
            key: accountsKey,
            api,
            items: [],
            cursor: null,
            selected: "",
            error: true,
          });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [api, workspace, accountsKey, accountsCursor, active]);

  useEffect(() => {
    const request = ++generation.current;
    if (!active || !workspace || !selectedId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    void browseGoogleDrive(api, workspace, selectedId, location, controller.signal)
      .then((page) => {
        if (request === generation.current && !controller.signal.aborted)
          setListing({ api, key, page });
      })
      .catch((error) => {
        if (request === generation.current)
          setListing({
            api,
            key,
            error:
              error instanceof CommaApiError &&
              [
                "composio_access_denied",
                "composio_reauthorization_required",
                "composio_account_not_owned",
              ].includes(String(error.body?.error))
                ? "reconnect"
                : "failed",
          });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [api, workspace, key, active, selectedId, location]);

  function resetPage() {
    setCursor(undefined);
    setPrevious([]);
    setOpeningError(false);
  }
  function navigate(next: typeof path) {
    setPath(next);
    setSearch("");
    setDraft("");
    resetPage();
  }
  function switchTab(next: GoogleDriveTab) {
    setTab(next);
    setSort(next === "recent" ? "recent" : "name");
    navigate([]);
  }
  function refresh() {
    setAccountsCursor(undefined);
    setReload((value) => value + 1);
    resetPage();
  }
  function date(value: string | null) {
    return value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value))
      : m.online_drive_no_date();
  }
  function kind(file: GoogleDriveFile) {
    if (file.shortcut) return m.online_drive_shortcut();
    if (googleDriveFolder(file)) return m.online_drive_folder();
    if (file.mime_type === "application/pdf") return "PDF";
    if (file.mime_type.includes("spreadsheet")) return m.online_drive_spreadsheet();
    if (file.mime_type.includes("presentation")) return m.online_drive_presentation();
    if (file.mime_type.includes("document")) return m.online_drive_document();
    if (file.mime_type.startsWith("image/")) return m.online_drive_image();
    return m.online_drive_file();
  }
  function open(file: GoogleDriveFile) {
    const folder = googleDriveFolder(file);
    if (folder) {
      if (path.length < 64) navigate([...path, { id: folder, name: file.name }]);
      return;
    }
    const url = safeGoogleDriveUrl(file.url);
    if (url) void openNativePlatformExternalUrl(url).catch(() => setOpeningError(true));
  }
  function fileButton(file: GoogleDriveFile, grid = false) {
    return (
      <button
        type="button"
        className={cx(
          "flex min-w-0 items-center gap-md rounded-md text-left text-sm text-primary hover:bg-secondary focus-visible:outline-none focus-visible:shadow-focus-gray-shadow-xs disabled:opacity-50",
          grid ? "w-full flex-col items-start p-lg" : "w-full p-sm"
        )}
        disabled={
          googleDriveFolder(file) ? path.length >= 64 : !safeGoogleDriveUrl(file.url)
        }
        onClick={() => open(file)}
        title={file.name}
      >
        {fileIcon(file)}
        <span className="w-full truncate">{file.name}</span>
        {grid && (
          <>
            <span className="text-xs text-tertiary">{kind(file)}</span>
            <span className="text-xs text-tertiary">
              {m.online_drive_modified()}: {date(file.modified_at)}
            </span>
          </>
        )}
      </button>
    );
  }
  const tabs = [
    { value: "recent", label: m.online_drive_recent() },
    { value: "my_drive", label: m.online_drive_my_drive() },
    { value: "shared", label: m.online_drive_shared() },
  ] as const;
  return (
    <section
      className="@container flex min-h-0 min-w-0 flex-1 flex-col bg-main-panel-bg"
      aria-label="Google Drive"
      data-testid="google-drive-browser"
    >
      <div className="flex flex-wrap items-center justify-between gap-lg px-xl py-lg">
        <h1 className="text-lg font-semibold text-primary">Google Drive</h1>
        <search className="flex items-center gap-sm">
          <form
            className="flex items-center gap-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(draft);
              resetPage();
            }}
          >
            <SearchIcon aria-hidden className="size-4 text-tertiary" />
            <input
              type="search"
              aria-label={m.online_drive_search()}
              placeholder={m.online_drive_search()}
              maxLength={512}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className={cx(control, "w-44")}
            />
            <button type="submit" className={button}>
              {m.online_drive_search_submit()}
            </button>
          </form>
        </search>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-md border-b border-secondary px-xl pb-md">
        <div
          role="tablist"
          aria-label={m.online_drive_views()}
          className="flex flex-wrap gap-sm"
        >
          {tabs.map((item, index) => (
            <button
              key={item.value}
              role="tab"
              id={`online-drive-tab-${item.value}`}
              aria-controls="online-drive-content"
              aria-selected={tab === item.value}
              tabIndex={tab === item.value ? 0 : -1}
              type="button"
              className={cx(
                "rounded-md px-md py-sm text-sm focus-visible:shadow-focus-gray-shadow-xs",
                tab === item.value
                  ? "bg-secondary font-medium text-primary"
                  : "text-tertiary hover:bg-secondary"
              )}
              onClick={() => switchTab(item.value)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index + 2) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  const value = tabs[next]!.value;
                  switchTab(value);
                  document.getElementById(`online-drive-tab-${value}`)?.focus();
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <select
            aria-label={m.online_drive_sort()}
            className={control}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as GoogleDriveSort);
              resetPage();
            }}
          >
            <option value="recent">{m.online_drive_activity()}</option>
            <option value="name">{m.online_drive_name()}</option>
            <option value="name_desc">{m.online_drive_name_desc()}</option>
            <option value="modified">{m.online_drive_modified()}</option>
            <option value="viewed">{m.online_drive_viewed()}</option>
          </select>
          <button
            type="button"
            aria-label={m.online_drive_list()}
            aria-pressed={view === "list"}
            className={button}
            onClick={() => setView("list")}
          >
            <ListBulletsIcon aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            aria-label={m.online_drive_grid()}
            aria-pressed={view === "grid"}
            className={button}
            onClick={() => setView("grid")}
          >
            {m.online_drive_grid_short()}
          </button>
          <button
            type="button"
            aria-label={m.online_drive_refresh()}
            className={button}
            onClick={refresh}
          >
            <ReloadIcon aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-md px-xl py-md">
        {currentAccounts && currentAccounts.items.length > 0 && (
          <select
            aria-label={m.online_drive_account()}
            className={cx(control, "max-w-full")}
            value={currentAccounts.selected}
            onChange={(event) => {
              const id = event.target.value;
              setAccounts((old) => (old ? { ...old, selected: id } : old));
              navigate([]);
            }}
          >
            {currentAccounts.items.map((item) => {
              const label = composioAccountPresentation(item, currentAccounts.items);
              return (
                <option key={item.id} value={item.id}>
                  {[
                    label.name,
                    label.email,
                    label.number
                      ? m.online_drive_connection({ number: String(label.number) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </option>
              );
            })}
          </select>
        )}
        {currentAccounts?.cursor && (
          <button
            type="button"
            className={button}
            onClick={() => {
              setAccountsCursor(currentAccounts.cursor!);
              navigate([]);
            }}
          >
            {m.online_drive_more_accounts()}
          </button>
        )}
        <nav
          aria-label={m.online_drive_path()}
          className="flex min-w-0 flex-wrap items-center gap-sm text-sm"
        >
          {path.length > 0 && (
            <button
              type="button"
              className={button}
              aria-label={m.online_drive_back()}
              onClick={() => navigate(path.slice(0, -1))}
            >
              <ArrowLeftIcon aria-hidden className="size-4" />
            </button>
          )}
          <button
            type="button"
            className="rounded-md px-sm py-xs text-tertiary hover:bg-secondary focus-visible:shadow-focus-gray-shadow-xs"
            onClick={() => navigate([])}
          >
            {tabs.find((item) => item.value === tab)?.label}
          </button>
          {path.map((folder, index) => (
            <button
              type="button"
              className="max-w-40 truncate rounded-md px-sm py-xs text-primary hover:bg-secondary focus-visible:shadow-focus-gray-shadow-xs"
              title={folder.name}
              key={`${index}:${folder.id}`}
              onClick={() => navigate(path.slice(0, index + 1))}
            >
              {folder.name}
            </button>
          ))}
        </nav>
      </div>
      <div
        role="tabpanel"
        id="online-drive-content"
        aria-labelledby={`online-drive-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={active && (!currentAccounts || Boolean(selectedId && !current))}
      >
        {!workspace ? (
          <p className="p-xl text-sm text-tertiary">{m.online_drive_no_workspace()}</p>
        ) : currentAccounts?.error ? (
          <div role="alert" className="p-xl text-sm text-primary">
            {m.online_drive_failed()}{" "}
            <button type="button" className={button} onClick={refresh}>
              {m.online_drive_retry()}
            </button>
          </div>
        ) : !currentAccounts ? (
          <output className="p-xl text-sm text-tertiary">
            {m.online_drive_loading()}
          </output>
        ) : !selectedId ? (
          <div className="p-xl text-sm text-tertiary">
            {currentAccounts.candidates?.length ? (
              <>
                <p>{m.composio_empty()}</p>
                {currentAccounts.candidates.map((candidate) => {
                  const identity = composioAccountPresentation(
                    candidate,
                    currentAccounts.candidates!
                  );
                  return (
                    <fieldset
                      key={candidate.id}
                      aria-label={[identity.name, identity.email]
                        .filter(Boolean)
                        .join(" · ")}
                      className="m-0 flex items-center gap-md border-0 py-md"
                    >
                      <span>
                        {identity.name}
                        {identity.email && identity.email !== identity.name
                          ? ` · ${identity.email}`
                          : ""}
                      </span>
                      <button
                        type="button"
                        className={button}
                        onClick={() => {
                          accountChoice.current = { workspace, id: candidate.id };
                          refresh();
                        }}
                      >
                        {m.composio_use_account()}
                      </button>
                    </fieldset>
                  );
                })}
              </>
            ) : (
              <>
                <p>{m.online_drive_connect()}</p>
                <button
                  type="button"
                  className={cx(button, "mt-lg")}
                  onClick={onPlugins}
                >
                  {m.online_drive_plugins()}
                </button>
              </>
            )}
          </div>
        ) : current?.error ? (
          <div role="alert" className="p-xl text-sm text-primary">
            <p>
              {current.error === "reconnect"
                ? m.online_drive_reconnect()
                : m.online_drive_failed()}
            </p>
            <div className="mt-lg flex gap-md">
              <button type="button" className={button} onClick={refresh}>
                {m.online_drive_retry()}
              </button>
              <button type="button" className={button} onClick={onPlugins}>
                {m.online_drive_plugins()}
              </button>
            </div>
          </div>
        ) : !current?.page ? (
          <output className="p-xl text-sm text-tertiary">
            {m.online_drive_loading()}
          </output>
        ) : (
          <>
            {current.page.incomplete && (
              <output className="px-xl py-md text-sm text-primary">
                {m.online_drive_incomplete()}
              </output>
            )}
            {openingError && (
              <p role="alert" className="px-xl py-md text-sm text-primary">
                {m.online_drive_open_failed()}
              </p>
            )}
            <ScrollArea
              className="min-h-0 flex-1"
              edgeEffect="none"
              orientation="both"
              viewportClassName="h-full"
              contentClassName="px-xl pb-xl"
            >
              {current.page.files.length === 0 ? (
                <p className="py-xl text-sm text-tertiary">{m.online_drive_empty()}</p>
              ) : view === "grid" ? (
                <ul className="grid grid-cols-1 gap-md @sm:grid-cols-2 @lg:grid-cols-3 @xl:grid-cols-4">
                  {current.page.files.map((file) => (
                    <li
                      key={file.id}
                      className="min-w-0 rounded-md border border-secondary"
                    >
                      {fileButton(file, true)}
                    </li>
                  ))}
                </ul>
              ) : (
                <table className="w-full min-w-160 text-left text-sm">
                  <thead>
                    <tr className="border-b border-secondary text-tertiary">
                      <th className="w-full p-sm font-medium">
                        {m.online_drive_name()}
                      </th>
                      <th className="p-sm font-medium">{m.online_drive_type()}</th>
                      <th className="p-sm font-medium">{m.online_drive_modified()}</th>
                      <th className="p-sm font-medium">{m.online_drive_viewed()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.page.files.map((file) => (
                      <tr key={file.id} className="border-b border-secondary">
                        <td className="max-w-0">{fileButton(file)}</td>
                        <td className="p-sm text-tertiary">{kind(file)}</td>
                        <td className="whitespace-nowrap p-sm text-tertiary">
                          {date(file.modified_at)}
                        </td>
                        <td className="whitespace-nowrap p-sm text-tertiary">
                          {date(file.viewed_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ScrollArea>
            <div className="flex items-center justify-end gap-sm border-t border-secondary px-xl py-md">
              <button
                type="button"
                className={button}
                disabled={!cursor}
                onClick={() => {
                  setCursor(undefined);
                  setPrevious([]);
                }}
              >
                {m.online_drive_first_page()}
              </button>
              <button
                type="button"
                className={button}
                disabled={previous.length === 0}
                onClick={() => {
                  setCursor(previous.at(-1));
                  setPrevious(previous.slice(0, -1));
                }}
              >
                {m.online_drive_previous_page()}
              </button>
              <button
                type="button"
                className={button}
                disabled={
                  !current.page.next_cursor || current.page.next_cursor === cursor
                }
                onClick={() => {
                  setPrevious((old) => [...old, cursor].slice(-20));
                  setCursor(current.page!.next_cursor!);
                }}
              >
                {m.online_drive_next_page()}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
