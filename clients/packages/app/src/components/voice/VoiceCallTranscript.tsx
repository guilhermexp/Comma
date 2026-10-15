import { useId, useState } from "react";
import {
  Button,
  CallIcon,
  ChevronDownIcon,
  Collapse,
  CollapseContent,
  ScrollArea,
} from "@comma/ui";
import { useCommaMessages } from "@comma/i18n/react";
import { callClock } from "./useVoiceCallFeedback";

export type CallTranscript = {
  callId: string;
  seconds: number;
  captions: { role: "caller" | "agent"; turn: number; text: string }[];
  truncated: boolean;
};

/** A local call record in the conversation. The server does not persist the full transcript. */
export function VoiceCallTranscript({ transcript }: { transcript: CallTranscript }) {
  const m = useCommaMessages();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <article
      aria-label={m.voice_call_transcript()}
      className="my-md max-w-full rounded-2xl bg-secondary p-md text-sm text-primary"
      data-testid="voice-call-transcript"
    >
      <Collapse open={open} onOpenChange={setOpen}>
        <Button
          hierarchy="tertiary-gray"
          className="w-full justify-between rounded-xl px-0"
          onPress={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={id}
          iconLeading={<CallIcon />}
          iconTrailing={<ChevronDownIcon className={open ? "rotate-180" : ""} />}
        >
          {m.voice_call_record({ duration: callClock(transcript.seconds) })}
        </Button>
        <CollapseContent id={id} className="pt-sm">
          {transcript.truncated && (
            <p className="pb-sm text-tertiary">{m.voice_call_truncated()}</p>
          )}
          <ScrollArea className="max-h-64" edgeEffect="none">
            <div className="space-y-sm pr-sm">
              {transcript.captions.map((caption) => (
                <p
                  key={`${caption.role}:${caption.turn}`}
                  className={
                    caption.role === "caller" ? "italic text-tertiary" : "text-primary"
                  }
                >
                  <span className="mr-1 font-medium not-italic">
                    {caption.role === "caller" ? m.voice_call_you() : "Comma"}:
                  </span>{" "}
                  {caption.text}
                </p>
              ))}
            </div>
          </ScrollArea>
        </CollapseContent>
      </Collapse>
    </article>
  );
}
