import { getNativeBridge, type PushToTalkVoiceSession } from "@comma/native-bridge";
import { useEffect } from "react";
import { openReadAloudPeer, type ReadAloudPeerDeps } from "./readAloudPeer";

/**
 * Renderer of the hidden Talk to agent voice window. Main owns the
 * read-aloud call; this holds one WebRTC peer per active generation of
 * Main's replay-last session and drops it when the generation ends.
 */
export function PushToTalkVoiceApp({ deps }: { deps?: ReadAloudPeerDeps }) {
  const bridge = getNativeBridge();
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    let latest = -1;
    let peer: { generation: number; close: () => void } | undefined;
    const apply = (session: PushToTalkVoiceSession) => {
      // A replayed snapshot may arrive after a newer one.
      if (session.generation < latest) return;
      latest = session.generation;
      if (peer && (!session.active || peer.generation !== session.generation)) {
        peer.close();
        peer = undefined;
      }
      if (!session.active || peer) return;
      const { generation } = session;
      peer = {
        generation,
        ...openReadAloudPeer({
          ...(deps ? { deps } : {}),
          offer: (sdp) => bridge.pushToTalkVoice.offer({ generation, sdp }),
          report: (event) => void bridge.pushToTalkVoice.report({ event, generation }),
        }),
      };
    };
    const unsubscribe = bridge.pushToTalkVoice.session.subscribe(apply);
    return () => {
      unsubscribe();
      peer?.close();
    };
  }, [bridge, deps]);
  return null;
}
