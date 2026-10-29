import { getNativeBridge, type PushToTalkVoiceSession } from "@comma/native-bridge";
import { useEffect } from "react";
import { openPushToTalkPeer, type PushToTalkPeerDeps } from "./pushToTalkPeer";

/**
 * Renderer of the hidden Talk to agent voice window. Main owns the
 * live voice call; this holds one WebRTC peer per active generation of
 * Main's replay-last session and updates listening without recreation.
 */
export function PushToTalkVoiceApp({ deps }: { deps?: PushToTalkPeerDeps }) {
  const bridge = getNativeBridge();
  useEffect(() => {
    if (bridge.platform !== "electron") return;
    let latestGeneration = -1;
    let latestRevision = -1;
    let peer:
      | {
          generation: number;
          close: () => void;
          update: (input: { listening?: boolean }) => void;
        }
      | undefined;

    const apply = (session: PushToTalkVoiceSession) => {
      // Replay fencing: ignore older generation or older/equal revision in same generation
      if (session.generation < latestGeneration) return;
      if (session.generation === latestGeneration && session.revision <= latestRevision)
        return;

      const isSameGeneration =
        peer !== undefined && peer.generation === session.generation;
      latestGeneration = session.generation;
      latestRevision = session.revision;

      if (!session.active) {
        if (peer) {
          peer.close();
          peer = undefined;
        }
        return;
      }

      if (isSameGeneration) {
        peer!.update({
          listening: session.listening,
        });
        return;
      }

      if (peer) {
        peer.close();
        peer = undefined;
      }

      const { generation } = session;
      const currentPeer = openPushToTalkPeer({
        ...(deps ? { deps } : {}),
        listening: session.listening,
        offer: (sdp) => bridge.pushToTalkVoice.offer({ generation, sdp }),
        report: (event) => void bridge.pushToTalkVoice.report({ event, generation }),
      });

      peer = {
        generation,
        ...currentPeer,
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
