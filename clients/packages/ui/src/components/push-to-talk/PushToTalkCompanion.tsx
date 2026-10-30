import { useCommaMessages } from "@comma/i18n/react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { Button } from "../Button";
import { ClockIcon, ExclamationTriangleIcon } from "../icons";
import { ScrollArea } from "../scroll-area";
import { cx } from "../utils";

export type PushToTalkErrorCode =
  | "microphone_denied"
  | "screen_denied"
  | "busy"
  | "plan_limit"
  | "context_failed"
  | "call_failed";

export type PushToTalkCompanionState =
  | { kind: "listening" }
  | { kind: "thinking" }
  | { kind: "speaking" }
  | { kind: "ready" }
  | { kind: "error"; code: PushToTalkErrorCode };

export type PushToTalkCompanionAction =
  | "open-microphone-settings"
  | "open-screen-recording-settings";

/** In the overlay's own coordinates (CSS pixels from its top-left corner). */
export type PushToTalkPoint = { x: number; y: number };

export interface PushToTalkCompanionProps {
  /** The sentence being spoken, or the whole reply; `null` shows no balloon. */
  caption: string | null;
  className?: string;
  /** The companion's and the stroke's blue, the colour the capture draws with. */
  color: string;
  /** The pointer; the companion sits just beside it. */
  cursor: PushToTalkPoint;
  /** Seeds the stroke, e.g. for a story. Remount to start a new surface. */
  defaultStroke?: ReadonlyArray<PushToTalkPoint> | null;
  /** Whether drawing freehand annotations is enabled on the current display. */
  drawingEnabled: boolean;
  /** Fading out where it is, before the window hides. */
  hiding?: boolean;
  /** Microphone level 0..1 while listening. */
  level: number;
  onAction?: (action: PushToTalkCompanionAction) => Promise<void> | void;
  onCaptionClick?: () => void;
  /** The stroke while it is drawn and after each drag; `null` after a click. */
  onStrokeChange?: (points: PushToTalkPoint[] | null) => void;
  /** `null` draws nothing at all. */
  state: PushToTalkCompanionState | null;
  testId?: string;
}

/** Points closer than this to the previous one add nothing to the line. */
const MIN_POINT_DISTANCE = 2;
/** Main accepts at most this many points per stroke. */
const MAX_STROKE_POINTS = 2_048;
/** The stroke reaches Main this often while it is drawn. */
const STROKE_REPORT_INTERVAL_MS = 100;
/** Room the balloon needs beside the pointer before it flips to the other side. */
const BALLOON_ROOM = { x: 420, y: 160 };
/** Slack around the way from the companion into its balloon. */
const HOLD_SLACK = 8;
/** How much each level bar answers the voice, outer bars least. */
const BAR_WEIGHTS = [0.5, 0.8, 1, 0.75, 0.45];

const errorAction: Partial<Record<PushToTalkErrorCode, PushToTalkCompanionAction>> = {
  microphone_denied: "open-microphone-settings",
  screen_denied: "open-screen-recording-settings",
};

/**
 * Talk to agent cursor companion: a small blue marker beside the pointer that
 * shows the voice level, a wait, and the reply's caption balloon. While the
 * shortcut is held a drag draws one freehand stroke over the display.
 */
export const PushToTalkCompanion = ({
  caption,
  className,
  color,
  cursor,
  defaultStroke = null,
  drawingEnabled,
  hiding = false,
  level,
  onAction,
  onCaptionClick,
  onStrokeChange,
  state,
  testId,
}: PushToTalkCompanionProps) => {
  const m = useCommaMessages();
  const [stroke, setStroke] = useState<ReadonlyArray<PushToTalkPoint> | null>(
    defaultStroke
  );
  const drawing = useRef<{
    lastReport: number;
    pointerId: number;
    points: PushToTalkPoint[];
  }>(undefined);
  const balloonRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState(cursor);
  const canDraw = drawingEnabled && !hiding;
  // The companion follows the pointer, except on its way into the balloon,
  // which then waits to be clicked. Fading out, it stays where it is.
  useLayoutEffect(() => {
    if (hiding) return;
    const balloon = balloonRef.current?.getBoundingClientRect();
    setAnchor((current) => {
      if (balloon && balloon.width > 0) {
        const holds =
          cursor.x >= Math.min(current.x, balloon.left) - HOLD_SLACK &&
          cursor.x <= Math.max(current.x, balloon.right) + HOLD_SLACK &&
          cursor.y >= Math.min(current.y, balloon.top) - HOLD_SLACK &&
          cursor.y <= Math.max(current.y, balloon.bottom) + HOLD_SLACK;
        if (holds) return current;
      }
      return current.x === cursor.x && current.y === cursor.y ? current : cursor;
    });
  }, [cursor, hiding]);

  const report = (points: PushToTalkPoint[] | null) => onStrokeChange?.(points);
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (!canDraw || event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest("[data-push-to-talk-interactive]")
    )
      return;
    const points = [{ x: event.clientX, y: event.clientY }];
    drawing.current = { lastReport: 0, pointerId: event.pointerId, points };
    // A new drag replaces the previous stroke.
    report(null);
    setStroke(points);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drawing.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!extend(current.points, { x: event.clientX, y: event.clientY })) return;
    setStroke([...current.points]);
    // Reported while drawing too, so a release mid-drag keeps the line.
    if (
      current.points.length >= 2 &&
      event.timeStamp - current.lastReport >= STROKE_REPORT_INTERVAL_MS
    ) {
      current.lastReport = event.timeStamp;
      report([...current.points]);
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drawing.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drawing.current = undefined;
    extend(current.points, { x: event.clientX, y: event.clientY });
    const final = current.points.length >= 2 ? current.points : null;
    setStroke(final);
    report(final ? [...final] : null);
  };

  if (!state) return null;
  const flipX = anchor.x > window.innerWidth - BALLOON_ROOM.x;
  const flipY = anchor.y > window.innerHeight - BALLOON_ROOM.y;
  const waiting = state.kind === "thinking";

  return (
    <div
      className={cx("comma-push-to-talk-overlay", className)}
      data-hiding={hiding || undefined}
      data-listening={canDraw || undefined}
      data-testid={testId}
      onPointerCancel={() => {
        drawing.current = undefined;
      }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      style={{ "--push-to-talk-blue": color } as CSSProperties}
    >
      {stroke && stroke.length >= 2 ? (
        <svg
          aria-label={m.push_to_talk_stroke()}
          className="comma-push-to-talk-stroke"
          data-fading={(!canDraw && !hiding) || undefined}
          // A drawn line over live pixels: there is no element to swap in.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="img"
        >
          <path d={pathOf(stroke)} />
        </svg>
      ) : null}
      <div
        className="comma-push-to-talk-companion"
        data-flip-x={flipX || undefined}
        data-flip-y={flipY || undefined}
        data-testid="push-to-talk-companion"
        style={{ left: anchor.x, top: anchor.y }}
      >
        <div
          className="comma-push-to-talk-glyph"
          data-kind={state.kind}
          key={state.kind}
        >
          {state.kind === "listening" ? (
            <LevelBars level={level} />
          ) : waiting ? (
            <svg
              aria-hidden
              className="comma-push-to-talk-waiting"
              data-testid="push-to-talk-waiting"
              viewBox="0 0 16 16"
            >
              <circle cx="8" cy="8" r="6" />
            </svg>
          ) : (
            <svg aria-hidden className="comma-push-to-talk-marker" viewBox="0 0 16 16">
              <path d="M3.2 2.4 13.6 7.1a1 1 0 0 1 0 1.8L3.2 13.6a.9.9 0 0 1-1.25-1.05L3.4 8 1.95 3.45A.9.9 0 0 1 3.2 2.4Z" />
            </svg>
          )}
        </div>
        {state.kind === "error" ? (
          <ErrorBalloon balloonRef={balloonRef} onAction={onAction} state={state} />
        ) : state.kind === "ready" ? (
          <CaptionBalloon
            balloonRef={balloonRef}
            caption={caption ?? ""}
            kind="ready"
            onClick={onCaptionClick}
          />
        ) : (
          <>
            <output className="sr-only">
              {
                {
                  listening: m.push_to_talk_listening(),
                  speaking: m.push_to_talk_speaking(),
                  thinking: m.push_to_talk_thinking(),
                }[state.kind]
              }
            </output>
            {caption !== null ? (
              <CaptionBalloon
                balloonRef={balloonRef}
                caption={caption}
                kind="speech"
                onClick={onCaptionClick}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};

const LevelBars = ({ level }: { level: number }) => (
  <span
    aria-hidden
    className="comma-push-to-talk-level"
    data-testid="push-to-talk-level"
  >
    {BAR_WEIGHTS.map((weight, index) => (
      <span
        className="comma-push-to-talk-level-bar"
        key={index}
        style={
          {
            "--bar-level": Math.min(1, 0.28 + level * weight).toFixed(3),
          } as CSSProperties
        }
      />
    ))}
  </span>
);

const CaptionBalloon = ({
  balloonRef,
  caption,
  kind,
  onClick,
}: {
  balloonRef: React.RefObject<HTMLDivElement | null>;
  caption: string;
  kind: "ready" | "speech";
  onClick: (() => void) | undefined;
}) => {
  const m = useCommaMessages();
  const hintId = useId();
  return (
    <div
      className="comma-push-to-talk-balloon"
      data-push-to-talk-balloon=""
      data-push-to-talk-interactive=""
      data-tone={kind === "ready" ? "neutral" : "brand"}
      ref={balloonRef}
    >
      <ScrollArea
        className="comma-push-to-talk-balloon-scroll"
        edgeEffect="mask"
        scrollbarVisibility="hover"
        viewportProps={{ tabIndex: -1 }}
      >
        <button
          aria-describedby={hintId}
          className="comma-push-to-talk-caption"
          // A new sentence sweeps in from the left, the way it is spoken.
          key={caption}
          onClick={onClick}
          type="button"
        >
          {kind === "ready" ? (
            <>
              <ClockIcon
                aria-hidden
                className="comma-push-to-talk-balloon-icon size-4"
              />
              <output>{m.push_to_talk_ready()}</output>
              <br />
            </>
          ) : null}
          {caption}
        </button>
      </ScrollArea>
      <span className="sr-only" id={hintId}>
        {m.push_to_talk_open_in_chat()}
      </span>
    </div>
  );
};

const ErrorBalloon = ({
  balloonRef,
  onAction,
  state,
}: {
  balloonRef: React.RefObject<HTMLDivElement | null>;
  onAction: PushToTalkCompanionProps["onAction"];
  state: Extract<PushToTalkCompanionState, { kind: "error" }>;
}) => {
  const m = useCommaMessages();
  const message = {
    busy: m.push_to_talk_call_busy(),
    call_failed: m.push_to_talk_call_failed(),
    context_failed: m.push_to_talk_context_failed(),
    microphone_denied: m.push_to_talk_microphone_denied(),
    plan_limit: m.push_to_talk_plan_limit(),
    screen_denied: m.push_to_talk_screen_denied(),
  }[state.code];
  const action = errorAction[state.code];

  return (
    <div
      className="comma-push-to-talk-balloon"
      data-push-to-talk-balloon=""
      data-tone="neutral"
      key={state.code}
      ref={balloonRef}
      role="alert"
    >
      <ExclamationTriangleIcon
        aria-hidden
        className="comma-push-to-talk-balloon-icon comma-push-to-talk-warning size-4"
      />
      <span className="comma-push-to-talk-balloon-text">{message}</span>
      {action ? (
        <span className="comma-push-to-talk-action" data-push-to-talk-interactive="">
          <Button
            hierarchy="secondary-gray"
            onPress={() => {
              void onAction?.(action);
            }}
            size="xs"
          >
            {m.push_to_talk_open_system_settings()}
          </Button>
        </span>
      ) : null}
    </div>
  );
};

/** Adds the point to the drawn line unless it adds nothing; true when added. */
function extend(points: PushToTalkPoint[], point: PushToTalkPoint) {
  const last = points.at(-1);
  if (points.length >= MAX_STROKE_POINTS) return false;
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE)
    return false;
  points.push(point);
  return true;
}

/** A smooth line through the points: each corner becomes a curve to the next midpoint. */
function pathOf(stroke: ReadonlyArray<PushToTalkPoint>) {
  const point = ({ x, y }: PushToTalkPoint) => `${round(x)} ${round(y)}`;
  let path = `M${point(stroke[0]!)}`;
  for (let index = 1; index < stroke.length - 1; index += 1) {
    const current = stroke[index]!;
    const next = stroke[index + 1]!;
    path += `Q${point(current)} ${point({
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2,
    })}`;
  }
  return `${path}L${point(stroke.at(-1)!)}`;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
