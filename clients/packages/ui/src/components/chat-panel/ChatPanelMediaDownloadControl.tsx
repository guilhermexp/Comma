import type { messages as commaMessages } from "@comma/i18n";
import { useCommaMessages } from "@comma/i18n/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Focusable } from "react-aria-components";
import { motionDuration } from "../../tokens";
import { Tooltip } from "../tooltip";
import { cx } from "../utils";
import {
  type ChatPanelMediaDownloadAction,
  type ChatPanelMediaDownloadKind,
  type ChatPanelMediaDownloadResult,
  formatMediaFileSize,
} from "./ChatPanelMediaDownload";
import { useHoverOnlyTooltip } from "./useHoverOnlyTooltip";
import { usePointerPressFeedback } from "./usePointerPressFeedback";

export type ChatPanelMediaDownloadState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success" }
  | Extract<ChatPanelMediaDownloadResult, { status: "error" }>;

export interface ChatPanelMediaDownloadController {
  canExecute: boolean;
  execute: () => Promise<void>;
  fileSizeLabel?: string;
  state: ChatPanelMediaDownloadState;
}

interface ChatPanelMediaDownloadControlProps {
  buttonClassName: string;
  controller: ChatPanelMediaDownloadController;
  feedbackPlacement: "above" | "below";
  icon: ReactNode;
  kind: ChatPanelMediaDownloadKind;
}

interface UseChatPanelMediaDownloadControllerOptions {
  action: ChatPanelMediaDownloadAction | undefined;
  kind: ChatPanelMediaDownloadKind;
  /** Absent for downloadables the renderer cannot address by URL. */
  source?: string | undefined;
}

const successFeedbackDuration =
  motionDuration.feedbackOut * 8 + motionDuration.stateChange;

const unexpectedDownloadFailure: ChatPanelMediaDownloadResult = {
  code: "unknown",
  retryable: true,
  status: "error",
};

type CommaMessages = typeof commaMessages;

const canExecuteDownload = (state: ChatPanelMediaDownloadState) =>
  state.status === "idle" ||
  state.status === "success" ||
  (state.status === "error" && state.retryable);

const getDownloadCopy = (
  m: CommaMessages,
  kind: ChatPanelMediaDownloadKind,
  state: ChatPanelMediaDownloadState
) => {
  const label = {
    audio: m.ui_media_kind_audio,
    file: m.ui_media_kind_file,
    image: m.ui_media_kind_image,
    video: m.ui_media_kind_video,
  }[kind]();
  switch (state.status) {
    case "pending":
      return {
        feedback: m.ui_media_downloading_feedback({ kind: label }),
        label: m.ui_media_downloading_label({ kind: label }),
      };
    case "success":
      return {
        feedback: {
          audio: m.ui_media_downloaded_audio,
          file: m.ui_file_downloaded_feedback,
          image: m.ui_media_downloaded_image,
          video: m.ui_media_downloaded_video,
        }[kind](),
        label: m.ui_media_downloaded_label({ kind: label }),
      };
    case "error":
      return state.retryable
        ? {
            feedback: m.ui_media_download_failed_retry({ kind: label }),
            label: m.ui_media_download_failed_retry_label({ kind: label }),
          }
        : {
            feedback: m.ui_media_download_failed({ kind: label }),
            label: m.ui_media_download_failed_label({ kind: label }),
          };
    case "idle":
      return {
        feedback: "",
        label: m.ui_media_download_label({ kind: label }),
      };
  }
};

export const useChatPanelMediaDownloadController = ({
  action,
  kind,
  source,
}: UseChatPanelMediaDownloadControllerOptions): ChatPanelMediaDownloadController => {
  const [state, setState] = useState<ChatPanelMediaDownloadState>({
    status: "idle",
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestGenerationRef = useRef(0);
  const requestContextRef = useRef({
    execute: action?.capability.execute,
    fileName: action?.fileName,
    kind,
    source,
  });
  requestContextRef.current = {
    execute: action?.capability.execute,
    fileName: action?.fileName,
    kind,
    source,
  };
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    requestGenerationRef.current += 1;
    const idleState: ChatPanelMediaDownloadState = { status: "idle" };
    stateRef.current = idleState;
    setState(idleState);
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    return () => {
      requestGenerationRef.current += 1;
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, [action?.capability.execute, action?.fileName, kind, source]);

  const execute = async () => {
    const request = requestContextRef.current;
    if (
      !request.execute ||
      request.fileName === undefined ||
      !canExecuteDownload(stateRef.current)
    ) {
      return;
    }

    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
    const pendingState: ChatPanelMediaDownloadState = { status: "pending" };
    stateRef.current = pendingState;
    setState(pendingState);

    let result: ChatPanelMediaDownloadResult;
    try {
      result = await request.execute({
        fileName: request.fileName,
        kind: request.kind,
        ...(request.source === undefined ? {} : { source: request.source }),
      });
    } catch {
      result = unexpectedDownloadFailure;
    }

    const latestRequest = requestContextRef.current;
    if (
      requestGenerationRef.current !== requestGeneration ||
      latestRequest.execute !== request.execute ||
      latestRequest.fileName !== request.fileName ||
      latestRequest.kind !== request.kind ||
      latestRequest.source !== request.source
    ) {
      return;
    }
    if (result.status === "error") {
      stateRef.current = result;
      setState(result);
      return;
    }

    const successState: ChatPanelMediaDownloadState = { status: "success" };
    stateRef.current = successState;
    setState(successState);
    successTimerRef.current = setTimeout(() => {
      if (requestGenerationRef.current === requestGeneration) {
        const idleState: ChatPanelMediaDownloadState = { status: "idle" };
        stateRef.current = idleState;
        setState(idleState);
      }
      successTimerRef.current = null;
    }, successFeedbackDuration);
  };

  return {
    canExecute: Boolean(action) && canExecuteDownload(state),
    execute,
    ...(action?.fileSize === undefined
      ? {}
      : { fileSizeLabel: formatMediaFileSize(action.fileSize) }),
    state,
  };
};

export const ChatPanelMediaDownloadControl = ({
  buttonClassName,
  controller,
  feedbackPlacement,
  icon,
  kind,
}: ChatPanelMediaDownloadControlProps) => {
  const messages = useCommaMessages();
  const feedbackId = useId();
  const buttonPressFeedback = usePointerPressFeedback<HTMLButtonElement>();
  const copy = getDownloadCopy(messages, kind, controller.state);
  const hasFeedback = copy.feedback.length > 0;
  const isPending = controller.state.status === "pending";
  const isIdle = controller.state.status === "idle";
  const tooltip = useHoverOnlyTooltip();

  return (
    <span
      className="chat-panel-media-download-anchor"
      data-error-code={
        controller.state.status === "error" ? controller.state.code : undefined
      }
      data-feedback-placement={feedbackPlacement}
      data-state={controller.state.status}
    >
      <Tooltip
        content={isIdle ? messages.ui_file_download() : copy.label}
        isOpen={tooltip.isOpen}
        onOpenChange={tooltip.onOpenChange}
        placement="top"
        {...(isIdle && controller.fileSizeLabel
          ? { suffix: controller.fileSizeLabel }
          : {})}
      >
        <Focusable>
          <button
            aria-busy={isPending}
            aria-describedby={hasFeedback ? feedbackId : undefined}
            aria-disabled={isPending || undefined}
            aria-label={copy.label}
            className={buttonClassName}
            data-download-state={controller.state.status}
            disabled={!controller.canExecute && !isPending}
            {...(controller.canExecute
              ? buttonPressFeedback
              : { "data-no-press-feedback": true })}
            onClick={() => void controller.execute()}
            type="button"
          >
            {icon}
          </button>
        </Focusable>
      </Tooltip>
      <output
        aria-atomic="true"
        aria-live="polite"
        className={cx(
          "chat-panel-media-download-feedback",
          controller.state.status === "error" && "is-error",
          controller.state.status === "success" && "is-success"
        )}
        data-visible={hasFeedback ? "true" : "false"}
        id={feedbackId}
      >
        {copy.feedback}
      </output>
    </span>
  );
};
