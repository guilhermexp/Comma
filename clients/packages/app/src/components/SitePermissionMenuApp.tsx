import { useCommaMessages } from "@comma/i18n/react";
import {
  getNativeBridge,
  emptySitePermissionMenuState,
  type SitePermissionMenuState,
  type SitePermissionMenuAction,
  type SitePermissionMenuSnapshot,
} from "@comma/native-bridge";
import {
  ArrowLeftIcon,
  ChevronRightSmallIcon,
  Menu,
  MenuItem,
  MenuSeparator,
  ScrollArea,
} from "@comma/ui";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** The content of a single preloaded native child window. */
export function SitePermissionMenuApp() {
  const bridge = getNativeBridge();
  const [state, setState] = useState(emptySitePermissionMenuState);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    const apply = (value: SitePermissionMenuState) => {
      if (!disposed)
        setState((previous) =>
          value.revision >= previous.revision ? value : previous
        );
    };
    const unsubscribe = bridge.sitePermissionMenu.state.subscribe(apply);
    void bridge.sitePermissionMenu.state
      .get()
      .then((value) => {
        apply(value);
        if (!disposed) setReady(true);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);
  const active = state.menu !== null;
  useLayoutEffect(() => {
    if (!active || !ready) return;
    void bridge.sitePermissionMenu
      .act({ action: "present", generation: state.generation })
      .catch(() => {});
  }, [bridge, state.generation, active, ready]);
  return (
    <div className="h-full" data-site-permission-menu-ready={ready ? "true" : "false"}>
      {state.menu && (
        <SitePermissionMenuContent
          key={state.generation}
          snapshot={state.menu}
          generation={state.generation}
        />
      )}
    </div>
  );
}

type WithoutGeneration<T> = T extends unknown ? Omit<T, "generation"> : never;
function SitePermissionMenuContent({
  snapshot,
  generation,
}: {
  snapshot: SitePermissionMenuSnapshot;
  generation: number;
}) {
  const bridge = getNativeBridge();
  const m = useCommaMessages();
  const [device, setDevice] = useState<"microphone" | "camera">();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const mediaName = (type: "microphone" | "camera") =>
    type === "microphone"
      ? m.site_permissions_microphone()
      : m.site_permissions_camera();
  const choiceName = (choice: "ask" | "allow" | "block") =>
    ({
      ask: m.site_permissions_ask(),
      allow: m.site_permissions_allow(),
      block: m.site_permissions_block(),
    })[choice];
  const close = useCallback(() => {
    void bridge.sitePermissionMenu.act({ action: "close", generation }).catch(() => {});
  }, [bridge, generation]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close]);
  const act = async (action: WithoutGeneration<SitePermissionMenuAction>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await bridge.sitePermissionMenu.act({ ...action, generation });
      if (action.action === "change" || action.action === "reset") {
        setChanged(true);
        setDevice(undefined);
      }
    } catch {
      // The bridge's reason is English diagnostic text; the menu says what to do next.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="h-full p-lg"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        aria-label={m.site_permissions_title()}
        className="flex max-h-full flex-col rounded-xl border-[0.5px] border-primary bg-popup-secondary py-sm text-sm text-secondary shadow-lg"
      >
        <h1
          className="truncate px-[calc(var(--spacing-sm)+var(--spacing-md))] py-md text-sm font-medium text-primary"
          title={snapshot?.origin}
        >
          {snapshot?.origin ?? m.site_permissions_title()}
        </h1>
        <ScrollArea
          className="min-h-0"
          edgeEffect="none"
          viewportProps={{ tabIndex: -1 }}
        >
          {snapshot &&
            (device ? (
              <Menu
                key={device}
                aria-label={mediaName(device)}
                variant="embedded"
                // This dedicated menu window is a user-opened focus scope.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus="first"
                selectionMode="single"
                selectedKeys={[snapshot.choices[device]]}
                disabledKeys={busy ? ["ask", "allow", "block"] : []}
              >
                <MenuItem
                  id="back"
                  icon={<ArrowLeftIcon />}
                  onAction={() => setDevice(undefined)}
                >
                  {m.shell_back()}
                </MenuItem>
                <MenuSeparator />
                {(["ask", "allow", "block"] as const).map((value) => (
                  <MenuItem
                    key={value}
                    id={value}
                    selectionIndicator="check"
                    onAction={() => {
                      void act({ action: "change", media: device, value });
                    }}
                  >
                    {choiceName(value)}
                  </MenuItem>
                ))}
              </Menu>
            ) : (
              <Menu
                aria-label={m.site_permissions_title()}
                variant="embedded"
                // This dedicated menu window is a user-opened focus scope.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus="first"
                disabledKeys={
                  busy
                    ? [
                        "microphone",
                        "camera",
                        "reset",
                        "reload",
                        "system-microphone",
                        "system-camera",
                      ]
                    : []
                }
              >
                {(["microphone", "camera"] as const).map((type) => (
                  <MenuItem
                    key={type}
                    id={type}
                    textValue={mediaName(type)}
                    shortcut={
                      <span className="flex items-center gap-xs">
                        {choiceName(snapshot.choices[type])}
                        <ChevronRightSmallIcon className="size-4" />
                      </span>
                    }
                    onAction={() => setDevice(type)}
                  >
                    {mediaName(type)}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  id="reset"
                  onAction={() => {
                    void act({ action: "reset" });
                  }}
                >
                  {m.site_permissions_reset()}
                </MenuItem>
                <MenuItem
                  id="reload"
                  onAction={() => {
                    void act({ action: "reload" });
                  }}
                >
                  {m.site_permissions_reload()}
                </MenuItem>
                {snapshot.systemSettings && <MenuSeparator />}
                {snapshot.systemSettings &&
                  (["microphone", "camera"] as const).map((type) => (
                    <MenuItem
                      key={`system-${type}`}
                      id={`system-${type}`}
                      onAction={() => {
                        void act({ action: "system-settings", media: type });
                      }}
                    >
                      {type === "microphone"
                        ? m.site_permissions_system_microphone()
                        : m.site_permissions_system_camera()}
                    </MenuItem>
                  ))}
              </Menu>
            ))}
        </ScrollArea>
        <p
          className="px-[calc(var(--spacing-sm)+var(--spacing-md))] py-sm text-xs text-quaternary"
          role={changed ? "status" : undefined}
        >
          {m.site_permissions_reload_hint()}
        </p>
        {failed && (
          <p
            role="alert"
            className="px-[calc(var(--spacing-sm)+var(--spacing-md))] py-sm text-xs text-error-primary"
          >
            {m.site_permissions_action_failed()}
          </p>
        )}
      </section>
    </div>
  );
}
