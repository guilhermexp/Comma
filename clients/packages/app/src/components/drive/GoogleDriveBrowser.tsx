import { getNativeBridge } from "@comma/native-bridge";
import { Button as AriaButton } from "react-aria-components";
import { GoogleDriveViewer } from "./GoogleDriveViewer";
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
  ScrollAreaLoadMore,
  GoogleDriveProviderLogo,
  GridIcon,
  Filter2Icon,
  XIcon,
  FilePdfIcon,
  TableIcon,
  SlidesIcon,
  FolderSharedIcon,
  ImageIcon,
  VideoIcon,
  FileIcon,
  Menu,
  MenuItem,
  MenuPopover,
  MenuTrigger,
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
  page?: GoogleDrivePage | undefined;
  error?: "reconnect" | "failed";
  loading?: boolean;
  cursor?: string | undefined;
};

const gridClass =
  "grid grid-cols-1 gap-lg @xs:grid-cols-2 @lg:grid-cols-3 @xl:grid-cols-4 @2xl:grid-cols-5 @3xl:grid-cols-6";
function fileIcon(file: GoogleDriveFile, large = false) {
  const mime = file.shortcut?.mime_type ?? file.mime_type;
  const Icon = googleDriveFolder(file)
    ? file.shared
      ? FolderSharedIcon
      : Folder1Icon
    : mime === "application/pdf"
      ? FilePdfIcon
      : mime.includes("spreadsheet")
        ? TableIcon
        : mime.includes("presentation")
          ? SlidesIcon
          : mime.includes("document")
            ? FileTextIcon
            : mime.startsWith("image/")
              ? ImageIcon
              : mime.startsWith("video/")
                ? VideoIcon
                : file.shortcut
                  ? ChainLinkIcon
                  : FileIcon;
  const color =
    mime === "application/pdf"
      ? "text-error-primary"
      : mime.includes("spreadsheet")
        ? "text-success-primary"
        : mime.includes("presentation")
          ? "text-warning-primary"
          : mime.includes("document")
            ? "text-blue-500"
            : "text-tertiary";
  return (
    <Icon aria-hidden className={cx("shrink-0", large ? "size-10" : "size-5", color)} />
  );
}
export function GoogleDriveSkeleton({ label }: { label: string }) {
  return (
    <output aria-label={label} className={cx(gridClass, "px-xl py-lg")}>
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="h-52 rounded-xl bg-tertiary motion-safe:animate-pulse"
        />
      ))}
    </output>
  );
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
  const [view, setView] = useState<"list" | "grid">("grid");
  const [cursor, setCursor] = useState<{ key: string; value: string }>();
  const [pageRetry, setPageRetry] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [viewer, setViewer] = useState<{ url: string; key: string }>();
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
    }),
    [tab, search, sort, folderId]
  );
  const key = JSON.stringify([accountsKey, selectedId, location]);
  const pageCursor = cursor?.key === key ? cursor.value : undefined;
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
    if (draft === search) return;
    const timer = setTimeout(() => {
      setSearch(draft);
      setCursor(undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, search]);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [key]);
  useEffect(() => {
    const request = ++generation.current;
    if (!active || !workspace || !selectedId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    inFlight.current = true;
    setListing((old) => ({
      api,
      key,
      loading: true,
      ...(pageCursor && old?.key === key && old.api === api ? { page: old.page } : {}),
    }));
    void browseGoogleDrive(
      api,
      workspace,
      selectedId,
      { ...location, ...(pageCursor ? { cursor: pageCursor } : {}) },
      controller.signal
    )
      .then((page) => {
        if (request === generation.current && !controller.signal.aborted)
          setListing((old) => {
            const previous =
              pageCursor && old?.key === key && old.api === api ? old.page : undefined;
            const rows = new Map(previous?.files.map((file) => [file.id, file]) ?? []);
            for (const file of page.files) rows.set(file.id, file);
            return {
              api,
              key,
              cursor: pageCursor,
              page: {
                ...page,
                files: [...rows.values()],
                incomplete: Boolean(previous?.incomplete || page.incomplete),
                next_cursor: page.next_cursor === pageCursor ? null : page.next_cursor,
              },
            };
          });
      })
      .catch((error) => {
        if (request === generation.current)
          setListing((old) => ({
            api,
            key,
            ...(pageCursor && old?.key === key ? { page: old.page } : {}),
            error:
              error instanceof CommaApiError &&
              [
                "composio_access_denied",
                "composio_reauthorization_required",
                "composio_account_not_owned",
              ].includes(String(error.body?.error))
                ? "reconnect"
                : "failed",
          }));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (request === generation.current) inFlight.current = false;
      });
    return () => {
      generation.current = request + 1;
      inFlight.current = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [api, workspace, key, active, selectedId, location, pageCursor, pageRetry]);

  function resetPage() {
    setCursor(undefined);

    setOpeningError(false);
    setViewer(undefined);
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
  function date(value: string | null, compact = false) {
    return value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(
          locale,
          compact
            ? {
                day: "numeric",
                month: "short",
                ...(new Date(value).getFullYear() !== new Date().getFullYear()
                  ? { year: "numeric" as const }
                  : {}),
              }
            : { dateStyle: "medium" }
        ).format(new Date(value))
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
    if (!url) return;
    if (getNativeBridge().platform === "electron") setViewer({ url, key });
    else void openNativePlatformExternalUrl(url).catch(() => setOpeningError(true));
  }
  function fileButton(file: GoogleDriveFile, grid = false) {
    const folder = googleDriveFolder(file);
    const viewed =
      tab !== "my_drive" &&
      file.viewed_at &&
      Number.isFinite(Date.parse(file.viewed_at));
    return (
      <button
        type="button"
        aria-label={file.name}
        title={file.name}
        className={cx(
          "min-w-0 text-left text-sm text-primary focus-visible:outline-none focus-visible:shadow-focus-gray-shadow-xs disabled:opacity-50",
          grid
            ? "group flex h-52 w-full flex-col rounded-xl bg-tertiary hover:bg-quaternary"
            : "flex w-full items-center gap-md rounded-md p-sm hover:bg-secondary"
        )}
        disabled={folder ? path.length >= 64 : !safeGoogleDriveUrl(file.url)}
        onClick={() => open(file)}
      >
        {grid ? (
          <>
            <span
              className={cx(
                "flex w-full items-center gap-sm px-lg pt-lg",
                folder && "border-b border-secondary pb-md"
              )}
            >
              {folder && fileIcon(file)}
              <span className="line-clamp-2 break-words">{file.name}</span>
            </span>
            <span className="flex flex-1 items-center justify-center self-stretch">
              {fileIcon(file, true)}
            </span>
            <span className="flex w-full items-center justify-between gap-sm px-lg pb-lg text-xs text-tertiary">
              <span>
                {viewed
                  ? m.online_drive_opened_date({ date: date(file.viewed_at, true) })
                  : file.modified_at
                    ? m.online_drive_modified_date({
                        date: date(file.modified_at, true),
                      })
                    : m.online_drive_no_date()}
              </span>
              <GoogleDriveProviderLogo className="size-4 shrink-0" />
            </span>
          </>
        ) : (
          <>
            {fileIcon(file)}
            <span className="w-full truncate">{file.name}</span>
          </>
        )}
      </button>
    );
  }
  function cards(files: GoogleDriveFile[]) {
    return (
      <ul className={gridClass}>
        {files.map((file) => (
          <li key={file.id} className="min-w-0">
            {fileButton(file, true)}
          </li>
        ))}
      </ul>
    );
  }
  function loadMore() {
    if (inFlight.current || !current?.page?.next_cursor || current.loading) return;
    inFlight.current = true;
    if (pageCursor === current.page.next_cursor) setPageRetry((value) => value + 1);
    else setCursor({ key, value: current.page.next_cursor });
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
      {viewer?.key === key && active && (
        <GoogleDriveViewer url={viewer.url} onBack={() => setViewer(undefined)} />
      )}
      <div
        className={
          viewer?.key === key && active ? "hidden" : "flex min-h-0 flex-1 flex-col"
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-lg px-xl py-xl">
          <h1 className="text-lg font-semibold text-primary">Google Drive</h1>
          <search className="flex items-center gap-sm rounded-full border border-secondary px-md py-sm">
            <SearchIcon aria-hidden className="size-4 text-tertiary" />
            <input
              type="search"
              aria-label={m.online_drive_search()}
              placeholder={m.online_drive_search()}
              maxLength={512}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-40 min-w-0 bg-transparent text-sm text-primary outline-none placeholder:text-tertiary focus-visible:shadow-focus-gray-shadow-xs"
            />
            {draft && (
              <button
                type="button"
                aria-label={m.online_drive_clear_search()}
                className="rounded-full text-tertiary focus-visible:shadow-focus-gray-shadow-xs"
                onClick={() => setDraft("")}
              >
                <XIcon className="size-4" />
              </button>
            )}
          </search>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-md px-xl pb-lg">
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
                  "rounded-full px-lg py-sm text-sm focus-visible:outline-none focus-visible:shadow-focus-gray-shadow-xs",
                  tab === item.value
                    ? "bg-tertiary font-medium text-primary"
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
            <MenuTrigger>
              <AriaButton
                aria-label={m.online_drive_sort()}
                className="rounded-full p-sm text-tertiary hover:bg-secondary focus-visible:shadow-focus-gray-shadow-xs"
              >
                <Filter2Icon className="size-5" />
              </AriaButton>
              <MenuPopover>
                <Menu
                  aria-label={m.online_drive_sort()}
                  selectionMode="single"
                  selectedKeys={[sort]}
                  onAction={(value) => {
                    setSort(value as GoogleDriveSort);
                    resetPage();
                  }}
                >
                  {(
                    [
                      ["recent", m.online_drive_activity()],
                      ["name", m.online_drive_name()],
                      ["name_desc", m.online_drive_name_desc()],
                      ["modified", m.online_drive_modified()],
                      ["viewed", m.online_drive_viewed()],
                    ] as const
                  ).map(([id, label]) => (
                    <MenuItem key={id} id={id}>
                      {label}
                    </MenuItem>
                  ))}
                </Menu>
              </MenuPopover>
            </MenuTrigger>
            <button
              type="button"
              aria-label={m.online_drive_list()}
              aria-pressed={view === "list"}
              className="rounded-full p-sm text-tertiary hover:bg-secondary aria-pressed:bg-tertiary aria-pressed:text-primary focus-visible:shadow-focus-gray-shadow-xs"
              onClick={() => setView("list")}
            >
              <ListBulletsIcon aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              aria-label={m.online_drive_grid()}
              aria-pressed={view === "grid"}
              className="rounded-full p-sm text-tertiary hover:bg-secondary aria-pressed:bg-tertiary aria-pressed:text-primary focus-visible:shadow-focus-gray-shadow-xs"
              onClick={() => setView("grid")}
            >
              <GridIcon aria-hidden className="size-4" />
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
          {currentAccounts && currentAccounts.items.length > 1 && (
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
          aria-busy={
            active &&
            (!currentAccounts || Boolean(selectedId && (!current || current.loading)))
          }
        >
          {!workspace ? (
            <p className="p-xl text-sm text-tertiary">
              {m.online_drive_no_workspace()}
            </p>
          ) : currentAccounts?.error ? (
            <div role="alert" className="p-xl text-sm text-primary">
              {m.online_drive_failed()}{" "}
              <button type="button" className={button} onClick={refresh}>
                {m.online_drive_retry()}
              </button>
            </div>
          ) : !currentAccounts ? (
            <GoogleDriveSkeleton label={m.online_drive_loading()} />
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
          ) : current?.error && (!current.page || current.error === "reconnect") ? (
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
            <GoogleDriveSkeleton label={m.online_drive_loading()} />
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
                ref={viewport}
                className="min-h-0 flex-1"
                edgeEffect="none"
                orientation={view === "grid" ? "vertical" : "both"}
                viewportClassName="h-full"
                contentClassName={cx(
                  "px-xl pb-xl",
                  view === "grid" && "w-full min-w-0"
                )}
              >
                {current.page.files.length === 0 ? (
                  <p className="py-xl text-sm text-tertiary">
                    {m.online_drive_empty()}
                  </p>
                ) : view === "grid" ? (
                  tab === "my_drive" || folderId ? (
                    <div className="space-y-2xl">
                      <section aria-label={m.online_drive_folders()}>
                        <h2 className="mb-lg text-sm font-medium text-primary">
                          {m.online_drive_folders()}
                        </h2>
                        {cards(
                          current.page.files.filter((file) =>
                            Boolean(googleDriveFolder(file))
                          )
                        )}
                      </section>
                      <section aria-label={m.online_drive_items()}>
                        <h2 className="mb-lg text-sm font-medium text-primary">
                          {m.online_drive_items()}
                        </h2>
                        {cards(
                          current.page.files.filter((file) => !googleDriveFolder(file))
                        )}
                      </section>
                    </div>
                  ) : (
                    cards(current.page.files)
                  )
                ) : (
                  <table className="w-full min-w-160 text-left text-sm">
                    <thead>
                      <tr className="border-b border-secondary text-tertiary">
                        <th className="w-full p-sm font-medium">
                          {m.online_drive_name()}
                        </th>
                        <th className="p-sm font-medium">{m.online_drive_type()}</th>
                        <th className="p-sm font-medium">
                          {m.online_drive_modified()}
                        </th>
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
                <ScrollAreaLoadMore
                  hasMore={Boolean(current.page.next_cursor)}
                  loading={Boolean(current.loading)}
                  failed={Boolean(current.error)}
                  onLoadMore={loadMore}
                />
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
