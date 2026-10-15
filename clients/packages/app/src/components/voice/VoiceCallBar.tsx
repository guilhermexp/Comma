import type { ReactNode } from "react";
import {
  Button,
  CallIcon,
  ChatBubbleIcon,
  CommaMascot,
  MicrophoneIcon,
  MicrophoneOffIcon,
  Tooltip,
} from "@comma/ui";
import { useCommaMessages } from "@comma/i18n/react";
import { callClock, type CallPhase } from "./useVoiceCallFeedback";

export function VoiceCallButton({
  label,
  icon,
  pressed,
  disabled,
  onPress,
  hangUp = false,
  entry = false,
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
  onPress: () => void;
  hangUp?: boolean;
  entry?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <Button
        aria-label={label}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        iconOnly
        iconLeading={icon}
        size={entry ? "lg" : "md"}
        hierarchy={hangUp ? "destructive" : "secondary-gray"}
        disabled={disabled ?? false}
        onPress={onPress}
        className={`rounded-full ${entry ? "shadow-md" : "shadow-none border-transparent"}`}
        style={
          pressed
            ? {
                backgroundColor: "var(--color-fg-primary)",
                color: "var(--color-bg-primary)",
              }
            : {}
        }
      />
    </Tooltip>
  );
}

export function VoiceCallBar({
  phase,
  name,
  muted,
  showCaptions,
  working,
  compact,
  seconds,
  levels,
  caption,
  error,
  onMute,
  onCaptions,
  onHangUp,
  onOpen,
}: {
  phase: CallPhase;
  name: string;
  muted: boolean;
  showCaptions: boolean;
  working: boolean;
  compact: boolean;
  seconds: number;
  levels: number[];
  caption?: { role: "caller" | "agent"; text: string } | undefined;
  error?: string | undefined;
  onMute: () => void;
  onCaptions: () => void;
  onHangUp: () => void;
  onOpen?: (() => void) | undefined;
}) {
  const m = useCommaMessages();
  const status =
    phase === "connecting"
      ? m.voice_call_connecting()
      : phase === "live"
        ? working
          ? m.voice_call_working()
          : callClock(seconds)
        : phase === "ending"
          ? m.voice_call_ending()
          : phase === "failed"
            ? m.voice_call_failure_status()
            : m.voice_call_ended();
  const active = ["connecting", "live", "ending"].includes(phase);
  return (
    <section
      aria-label={m.voice_call_title()}
      data-testid="voice-call"
      data-compact={compact}
      className="relative flex flex-col items-center"
    >
      <div className="flex items-center gap-1.5 rounded-full bg-primary p-1.5 ring-1 ring-border-secondary shadow-md">
        <Tooltip content={m.voice_call_return({ agent: name })} isDisabled={!compact}>
          <Button
            aria-label={m.voice_call_return({ agent: name })}
            iconOnly
            iconLeading={<CommaMascot size={28} interactive={false} />}
            size="md"
            hierarchy="tertiary-gray"
            className="rounded-full bg-brand-secondary text-brand-primary [&_.comma-icon-slot]:size-7"
            onPress={() => onOpen?.()}
            disabled={!compact}
          />
        </Tooltip>
        <div className="flex w-28 min-w-0 flex-col px-1">
          <span className="truncate text-sm font-semibold text-primary">{name}</span>
          <output
            aria-live="polite"
            aria-atomic="true"
            className={`font-mono text-xs tabular-nums ${phase === "failed" ? "text-fg-error-primary" : "text-tertiary"}`}
          >
            {status}
          </output>
        </div>
        {!compact && (
          <div
            aria-hidden="true"
            className="flex h-10 w-24 shrink-0 items-center justify-between px-1.5 max-[520px]:hidden"
          >
            {levels.map((level, index) => (
              <span
                key={index}
                className={`w-[3px] rounded-full transition-[height] duration-100 ${phase === "connecting" ? "bg-quaternary motion-safe:animate-pulse" : level > 0.08 ? "bg-fg-primary" : "bg-quaternary"}`}
                style={{
                  height: 3 + Math.round(level * 20),
                  animationDelay: `${index * 70}ms`,
                }}
              />
            ))}
          </div>
        )}
        {!compact && (
          <VoiceCallButton
            label={
              showCaptions ? m.voice_call_hide_captions() : m.voice_call_show_captions()
            }
            icon={<ChatBubbleIcon />}
            pressed={showCaptions}
            onPress={onCaptions}
          />
        )}
        <VoiceCallButton
          label={muted ? m.voice_call_unmute() : m.voice_call_mute()}
          icon={muted ? <MicrophoneOffIcon /> : <MicrophoneIcon />}
          pressed={muted}
          disabled={phase !== "live"}
          onPress={onMute}
        />
        {active && (
          <VoiceCallButton
            label={m.voice_call_hang_up()}
            icon={<CallIcon className="rotate-[135deg]" />}
            hangUp
            disabled={phase === "ending"}
            onPress={onHangUp}
          />
        )}
      </div>
      {(error || (showCaptions && caption && !compact && active)) && (
        <p
          role={error ? "alert" : "status"}
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-bg-primary) 95%, transparent)",
          }}
          className={`absolute ${compact ? "bottom-full mb-2" : "top-full mt-2"} line-clamp-3 w-max max-w-[min(400px,calc(100vw-32px))] rounded-2xl px-3.5 py-2 text-center text-sm shadow-md ring-1 ring-border-secondary ${error ? "text-fg-error-primary" : caption?.role === "caller" ? "italic text-tertiary" : "text-primary"}`}
        >
          {error ?? caption?.text}
        </p>
      )}
    </section>
  );
}
