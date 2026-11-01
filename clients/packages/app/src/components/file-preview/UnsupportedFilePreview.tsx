import { useEffect, useRef, useState } from "react";
import { useCommaMessages } from "@comma/i18n/react";
import {
  Button,
  useChatPanelMediaDownloadController,
  type ChatPanelFileOpenInAction,
  type ChatPanelMediaDownloadAction,
} from "@comma/ui";

export function UnsupportedFilePreview({
  download,
  openIn,
}: {
  download: ChatPanelMediaDownloadAction;
  openIn?: ChatPanelFileOpenInAction | undefined;
}) {
  const messages = useCommaMessages();
  const controller = useChatPanelMediaDownloadController({
    action: download,
    kind: "file",
  });
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const operation = useRef<AbortController | null>(null);
  // The preview tab is keyed by its file source; action refreshes keep its operation.
  useEffect(
    () => () => {
      operation.current?.abort();
      operation.current = null;
    },
    []
  );
  const open = async () => {
    if (!openIn?.openDefault || operation.current) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setOpening(true);
    setOpenFailed(false);
    try {
      await openIn.openDefault(attempt.signal);
    } catch {
      if (!attempt.signal.aborted) setOpenFailed(true);
    } finally {
      if (!attempt.signal.aborted) setOpening(false);
      if (operation.current === attempt) operation.current = null;
    }
  };
  const downloading = controller.state.status === "pending";
  const feedback = openFailed
    ? messages.ui_file_open_failed()
    : controller.state.status === "error"
      ? messages.ui_file_download_failed_feedback()
      : controller.state.status === "success"
        ? messages.ui_file_downloaded_feedback()
        : "";
  return (
    <div className="flex max-w-full flex-col items-center gap-xl text-center">
      <p className="text-sm text-secondary">{messages.file_preview_unavailable()}</p>
      <div className="flex flex-wrap justify-center gap-md">
        {openIn?.openDefault ? (
          <Button
            size="sm"
            hierarchy="secondary-gray"
            isDisabled={opening || downloading}
            aria-busy={opening}
            onPress={() => void open()}
          >
            {opening
              ? messages.ui_file_open_in_opening()
              : messages.file_preview_open_default()}
          </Button>
        ) : null}
        <Button
          size="sm"
          hierarchy="secondary-gray"
          isDisabled={opening || !controller.canExecute}
          aria-busy={downloading}
          onPress={() => {
            setOpenFailed(false);
            void controller.execute();
          }}
        >
          {downloading ? messages.ui_file_downloading() : messages.ui_file_download()}
        </Button>
      </div>
      <output aria-live="polite" className="text-sm text-secondary">
        {feedback}
      </output>
    </div>
  );
}
