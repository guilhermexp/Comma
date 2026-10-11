import {
  getNativeBridge,
  type ComputerUsePermissionFlowResult,
} from "@comma/native-bridge";
import { useCommaMessages } from "@comma/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";

export function useComputerUsePermissions(active: boolean) {
  const bridge = getNativeBridge();
  const messages = useCommaMessages();
  const available = bridge.platform === "electron" && bridge.os === "macos";
  const [permissions, setPermissions] =
    useState<ComputerUsePermissionFlowResult["permissions"]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(
    async (open: boolean) => {
      if (!available || inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(undefined);
      // The helper's own error text is a diagnostic in English; the row says
      // which step failed in the app's language.
      let step: "open" | "read" = open ? "open" : "read";
      try {
        if (open) {
          const result = await bridge.computerUse.openPermissionFlow();
          if (!result.ok) throw new Error(result.error);
          step = "read";
        }
        const result = await bridge.computerUse.getPermissions();
        if (!result.ok || !result.permissions) throw new Error(result.error);
        setPermissions(result.permissions);
      } catch {
        setPermissions(undefined);
        setError(
          step === "open"
            ? messages.settings_computer_use_open_failed()
            : messages.settings_computer_use_read_failed()
        );
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [available, bridge, messages]
  );

  useEffect(() => {
    if (!active || !available) return;
    // One helper per Mac: one request on entry/focus, at most one in flight.
    // No timers, per-device fan-out, or persistent permission mirror.
    const refresh = () => {
      void run(false);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active, available, run]);

  return {
    available,
    permissions,
    error,
    pending,
    refresh: () => {
      void run(false);
    },
    open: () => {
      void run(true);
    },
  };
}
