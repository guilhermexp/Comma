import { useCommaMessages } from "@comma/i18n/react";
import { useState, type PointerEvent } from "react";
import { Button } from "../Button";
import {
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  ExclamationTriangleIcon,
  LoadingCircleIcon,
} from "../icons";
import { cx } from "../utils";

export type PushToTalkErrorCode =
  | "microphone_denied"
  | "screen_denied"
  | "transcription_unavailable"
  | "transcription_busy"
  | "transcription_failed"
  | "nothing_heard"
  | "send_failed";

export type PushToTalkPill =
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "busy" }
  | { kind: "error"; code: PushToTalkErrorCode; transcriptAvailable: boolean };

export type PushToTalkOverlayAction =
  | "copy-transcript"
  | "open-meeting-settings"
  | "open-microphone-settings"
  | "open-screen-recording-settings";

/** In the overlay's own coordinates (CSS pixels from its top-left corner). */
export type PushToTalkRegion = { height: number; width: number; x: number; y: number };

export interface PushToTalkOverlayProps {
  /** Pointer when the shortcut went down; the pill sits just beside it. */
  anchor: { x: number; y: number };
  className?: string;
  /** Seeds the marked area, e.g. for a story. Remount to start a new turn. */
  defaultRegion?: PushToTalkRegion | null;
  onAction?: (action: PushToTalkOverlayAction) => Promise<void> | void;
  /** The final area after each drag; `null` after a click without a drag. */
  onRegionChange?: (region: PushToTalkRegion | null) => void;
  /** `null` draws nothing at all. */
  pill: PushToTalkPill | null;
  testId?: string;
}

/** Smaller than this, a press without a real drag. */
const MIN_REGION_SIZE = 4;
/** Room the pill needs beside the pointer before it flips to the other side. */
const PILL_ROOM = { x: 400, y: 96 };

const errorAction: Partial<Record<PushToTalkErrorCode, PushToTalkOverlayAction>> = {
  microphone_denied: "open-microphone-settings",
  screen_denied: "open-screen-recording-settings",
  transcription_unavailable: "open-meeting-settings",
  send_failed: "copy-transcript",
};

/**
 * Talk to agent overlay: the state pill near the pointer and, while the
 * shortcut is held, a crosshair surface to mark one area of the display.
 */
export const PushToTalkOverlay = ({
  anchor,
  className,
  defaultRegion = null,
  onAction,
  onRegionChange,
  pill,
  testId,
}: PushToTalkOverlayProps) => {
  const m = useCommaMessages();
  const [region, setRegion] = useState<PushToTalkRegion | null>(defaultRegion);
  const [draft, setDraft] = useState<{
    origin: { x: number; y: number };
    pointerId: number;
    rect: PushToTalkRegion;
  }>();
  const listening = pill?.kind === "listening";

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (!listening || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = { x: event.clientX, y: event.clientY };
    setDraft({
      origin,
      pointerId: event.pointerId,
      rect: { ...origin, height: 0, width: 0 },
    });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!draft || event.pointerId !== draft.pointerId) return;
    setDraft({ ...draft, rect: spanning(draft.origin, event) });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!draft || event.pointerId !== draft.pointerId) return;
    const rect = spanning(draft.origin, event);
    const next =
      rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE ? null : rect;
    setDraft(undefined);
    setRegion(next);
    onRegionChange?.(next);
  };

  if (!pill) return null;
  // Marking belongs to the held shortcut; afterwards only the pill remains.
  const shownRegion = listening ? (draft?.rect ?? region) : null;
  const flipX = anchor.x > window.innerWidth - PILL_ROOM.x;
  const flipY = anchor.y > window.innerHeight - PILL_ROOM.y;

  return (
    <div
      className={cx("comma-push-to-talk-overlay", className)}
      data-listening={listening || undefined}
      data-testid={testId}
      onPointerCancel={() => setDraft(undefined)}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
    >
      {shownRegion ? (
        <div
          aria-label={m.push_to_talk_marked_area()}
          className="comma-push-to-talk-region"
          data-drafting={draft ? "" : undefined}
          // A drawn rectangle over live pixels: there is no element to swap in.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="img"
          style={{
            height: shownRegion.height,
            left: shownRegion.x,
            top: shownRegion.y,
            width: shownRegion.width,
          }}
        />
      ) : null}
      <div
        className="comma-push-to-talk-pill-anchor"
        data-flip-x={flipX || undefined}
        data-flip-y={flipY || undefined}
        style={{ left: anchor.x, top: anchor.y }}
      >
        <PushToTalkPillView
          key={pill.kind === "error" ? `error:${pill.code}` : pill.kind}
          onAction={onAction}
          pill={pill}
        />
      </div>
    </div>
  );
};

const PushToTalkPillView = ({
  onAction,
  pill,
}: {
  onAction: PushToTalkOverlayProps["onAction"];
  pill: PushToTalkPill;
}) => {
  const m = useCommaMessages();
  const [copied, setCopied] = useState(false);

  if (pill.kind !== "error") {
    return (
      <output className="comma-push-to-talk-pill" data-kind={pill.kind}>
        {pill.kind === "listening" ? (
          <>
            <span aria-hidden className="comma-push-to-talk-live-dot" />
            <span className="comma-push-to-talk-label">
              {m.push_to_talk_listening()}
            </span>
            <span className="comma-push-to-talk-hint">
              {m.push_to_talk_listening_hint()}
            </span>
          </>
        ) : pill.kind === "transcribing" ? (
          <>
            <LoadingCircleIcon
              aria-hidden
              className="comma-push-to-talk-spinner size-4"
            />
            <span className="comma-push-to-talk-label comma-shiny-text">
              {m.push_to_talk_transcribing()}
            </span>
          </>
        ) : (
          <>
            <ClockIcon aria-hidden className="comma-push-to-talk-icon size-4" />
            <span className="comma-push-to-talk-label">{m.push_to_talk_busy()}</span>
          </>
        )}
      </output>
    );
  }

  const message = {
    microphone_denied: m.push_to_talk_microphone_denied(),
    nothing_heard: m.push_to_talk_nothing_heard(),
    screen_denied: m.push_to_talk_screen_denied(),
    send_failed: m.push_to_talk_send_failed(),
    transcription_busy: m.push_to_talk_transcription_busy(),
    transcription_failed: m.push_to_talk_transcription_failed(),
    transcription_unavailable: m.push_to_talk_transcription_unavailable(),
  }[pill.code];
  const action =
    pill.code === "send_failed" && !pill.transcriptAvailable
      ? undefined
      : errorAction[pill.code];

  return (
    <div className="comma-push-to-talk-pill" data-kind="error" role="alert">
      <ExclamationTriangleIcon
        aria-hidden
        className="comma-push-to-talk-warning size-4"
      />
      <span className="comma-push-to-talk-label">{message}</span>
      {action ? (
        <span className="comma-push-to-talk-action" data-push-to-talk-interactive="">
          <Button
            hierarchy="secondary-gray"
            {...(action === "copy-transcript"
              ? {
                  iconLeading: copied ? (
                    <CircleCheckIcon aria-hidden className="size-4" />
                  ) : (
                    <CopyIcon aria-hidden className="size-4" />
                  ),
                }
              : {})}
            onPress={() => {
              void Promise.resolve(onAction?.(action)).then(() => {
                if (action === "copy-transcript") setCopied(true);
              });
            }}
            size="xs"
          >
            {action === "copy-transcript"
              ? copied
                ? m.push_to_talk_copied()
                : m.push_to_talk_copy_transcript()
              : action === "open-meeting-settings"
                ? m.push_to_talk_open_meeting_settings()
                : m.push_to_talk_open_system_settings()}
          </Button>
        </span>
      ) : null}
    </div>
  );
};

function spanning(
  origin: { x: number; y: number },
  point: { clientX: number; clientY: number }
): PushToTalkRegion {
  return {
    height: Math.abs(point.clientY - origin.y),
    width: Math.abs(point.clientX - origin.x),
    x: Math.min(origin.x, point.clientX),
    y: Math.min(origin.y, point.clientY),
  };
}
