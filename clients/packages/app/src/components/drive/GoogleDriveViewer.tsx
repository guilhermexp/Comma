import { useCallback, useEffect, useState } from "react";
import { getNativeBridge, type BrowserSidebarState } from "@comma/native-bridge";
import { useCommaMessages } from "@comma/i18n/react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ReloadIcon,
  useNativeSurfaceSuppressed,
} from "@comma/ui";
import { NativeBrowserViewport } from "../chat-sidebar/ChatSidebar";
import { openNativePlatformExternalUrl } from "../../runtime-chat/nativePlatformActions";
import { driveSecondaryButton } from "./driveButtonStyles";

const noSessions: string[] = [];
export function GoogleDriveViewer({
  url,
  onBack,
}: {
  url: string;
  onBack: () => void;
}) {
  const m = useCommaMessages();
  const [sessionId] = useState(() => `google-drive:${crypto.randomUUID()}`);
  const [state, setState] = useState<BrowserSidebarState>({
    active: false,
    available: true,
    sessionId,
    url,
  });
  const [error, setError] = useState<string>();
  const suppressed = useNativeSurfaceSuppressed();
  const changed = useCallback(
    (next: BrowserSidebarState) => {
      if (next.sessionId === sessionId) setState(next);
    },
    [sessionId]
  );
  useEffect(() => getNativeBridge().browserSidebar.onChanged(changed), [changed]);
  useEffect(
    () => () => {
      void getNativeBridge()
        .browserSidebar.close({ sessionId })
        .catch(() => undefined);
    },
    [sessionId]
  );
  function navigate(action: "back" | "forward" | "reload") {
    void getNativeBridge()
      .browserSidebar.navigate({ sessionId, action })
      .then(changed)
      .catch(() => setError(m.online_drive_open_failed()));
  }
  return (
    <section
      aria-label={m.online_drive_document()}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center gap-sm border-b border-secondary px-lg py-md">
        <button type="button" className={driveSecondaryButton} onClick={onBack}>
          {m.online_drive_back_to_files()}
        </button>
        <button
          type="button"
          className={driveSecondaryButton}
          aria-label={m.online_drive_back()}
          disabled={!state.canGoBack}
          onClick={() => navigate("back")}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          className={driveSecondaryButton}
          aria-label={m.online_drive_forward()}
          disabled={!state.canGoForward}
          onClick={() => navigate("forward")}
        >
          <ArrowRightIcon className="size-4" />
        </button>
        <button
          type="button"
          className={driveSecondaryButton}
          aria-label={m.online_drive_refresh()}
          onClick={() => navigate("reload")}
        >
          <ReloadIcon className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate rounded-full bg-secondary px-lg py-sm text-center text-sm text-secondary">
          {new URL(state.url ?? url).hostname}
        </span>
        <button
          type="button"
          className={driveSecondaryButton}
          onClick={() => {
            void openNativePlatformExternalUrl(state.url ?? url).catch(() =>
              setError(m.online_drive_open_failed())
            );
          }}
        >
          {m.online_drive_open_external()}
        </button>
      </div>
      {(error || state.reason) && (
        <p role="alert" className="px-xl py-md text-sm text-primary">
          {error || state.reason}
        </p>
      )}
      <NativeBrowserViewport
        profile="google-drive"
        closeBeforeOpenSessionIds={noSessions}
        nativeCapacityEpoch={0}
        nativeState={state}
        onStateChanged={changed}
        onStateSettled={changed}
        onUnavailable={setError}
        sessionId={sessionId}
        tabId={sessionId}
        suppressed={suppressed}
        navigationRevision={0}
        url={url}
        visible
      />
    </section>
  );
}
