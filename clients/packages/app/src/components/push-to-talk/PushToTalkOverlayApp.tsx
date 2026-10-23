import {
  getNativeBridge,
  hiddenPushToTalkOverlayState,
  type PushToTalkOverlayState,
} from "@comma/native-bridge";
import { PushToTalkOverlay } from "@comma/ui";
import { useCallback, useEffect, useState } from "react";

/**
 * Renderer of the Talk to agent overlay window. Main owns the turn and the
 * window; this draws its replay-last state and reports the marked area.
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
  // so the pill's own buttons can take clicks while it is over them.
  const clickThrough = state.pill !== null && state.pill.kind !== "listening";
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

  const { turn } = state;
  return (
    <PushToTalkOverlay
      // A new turn starts without the previous area.
      key={turn}
      anchor={state.anchor}
      onAction={(action) => bridge.pushToTalk.overlayAction({ action })}
      onRegionChange={(rect) => {
        void bridge.pushToTalk.setRegion({ rect, turn });
      }}
      pill={state.pill}
      testId="push-to-talk-overlay"
    />
  );
}
