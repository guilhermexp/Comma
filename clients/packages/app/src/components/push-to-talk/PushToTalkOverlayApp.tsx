import {
  getNativeBridge,
  hiddenPushToTalkOverlayState,
  pushToTalkStrokeColor,
  type PushToTalkOverlayState,
} from "@comma/native-bridge";
import { PushToTalkCompanion } from "@comma/ui";
import { useCallback, useEffect, useState } from "react";

/**
 * Renderer of the Talk to agent overlay window. Main owns the turn, the
 * window and the pointer; this draws the cursor companion from its
 * replay-last state and reports the stroke and the balloon's clicks.
 */
export function PushToTalkOverlayApp() {
  const bridge = getNativeBridge();
  const [state, setState] = useState<PushToTalkOverlayState>(
    hiddenPushToTalkOverlayState
  );
  const accept = useCallback((next: PushToTalkOverlayState) => {
    setState((current) => (current.revision > next.revision ? current : next));
  }, []);
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    return bridge.pushToTalk.overlayState.subscribe(accept);
  }, [accept, bridge]);

  // Outside a drag the window lets clicks through; Main forwards the pointer
  // so the balloon and its buttons can take clicks while it is over them.
  const clickThrough =
    state.companion !== null && state.companion.kind !== "listening" && !state.hiding;
  useEffect(() => {
    if (!clickThrough) return;
    let interactive = false;
    const update = (target: Element | null) => {
      const next = Boolean(target?.closest("[data-push-to-talk-interactive]"));
      if (next === interactive) return;
      interactive = next;
      void bridge.pushToTalk.setInteractive({ interactive: next });
    };
    const move = (event: MouseEvent) =>
      update(event.target instanceof Element ? event.target : null);
    const leave = () => update(null);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", leave);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseleave", leave);
      if (interactive) void bridge.pushToTalk.setInteractive({ interactive: false });
    };
  }, [bridge, clickThrough]);

  const { surface } = state;
  return (
    <PushToTalkCompanion
      // A new turn or another display starts without the previous stroke.
      key={surface}
      caption={state.caption}
      color={pushToTalkStrokeColor}
      cursor={state.cursor}
      hiding={state.hiding}
      level={state.level}
      onAction={(action) => bridge.pushToTalk.overlayAction({ action })}
      onCaptionClick={() => {
        void bridge.pushToTalk.overlayAction({ action: "caption-click" });
      }}
      onStrokeChange={(points) => {
        void bridge.pushToTalk.setStroke({ points, surface });
      }}
      state={state.companion}
      testId="push-to-talk-overlay"
    />
  );
}
