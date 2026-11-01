import userEvent from "@testing-library/user-event";
import { useCommaI18n } from "@comma/i18n/react";
import {
  appPreferencesSchema,
  commaClientSettingsSchema,
  defaultCommaClientSettings,
  type AppPreferences,
  type AppPreferencesPatch,
  type CommaClientSettings,
} from "@comma/native-bridge";
import {
  createNativeStateBridgeMock,
  installNativeBridgeMock,
} from "@comma/test-utils/native-bridge";
import { act, render, screen, waitFor } from "@comma/test-utils/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommaClientSettingsI18nProvider,
  CommaElectronClientSettingsProvider,
  CommaWebClientSettingsProvider,
  commaClientSettingsStorageKey,
  readWebCommaClientSettings,
  useCommaClientSettings,
  useCommaClientSettingsPending,
} from "../components/commaClientSettings";
import {
  CommaAppearanceProvider,
  useCommaAppearance,
} from "../components/commaAppearance";
import {
  CommaAppShortcutsProvider,
  useCommaAppShortcuts,
} from "../components/shortcuts/commaAppShortcuts";

function PendingConsumer() {
  const pending = useCommaClientSettingsPending();
  return <output aria-label="pending-status">{pending ? "pending" : "idle"}</output>;
}

function SettingsProbe() {
  const appearance = useCommaAppearance();
  const { localePreference, setLocalePreference } = useCommaI18n();
  const shortcuts = useCommaAppShortcuts();
  return (
    <>
      <output aria-label="client settings">
        {localePreference}:{appearance.theme}:
        {shortcuts.bindings["go-settings"] === null ? "off" : "on"}
      </output>
      <button onClick={() => setLocalePreference("en")} type="button">
        English
      </button>
      <button onClick={() => appearance.setTheme("light")} type="button">
        Light
      </button>
      <button onClick={() => shortcuts.setBinding("go-search", null)} type="button">
        Disable search
      </button>
    </>
  );
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "commaNative");
});

describe("CommaElectronClientSettingsProvider", () => {
  it("adopts legacy settings once and routes language, appearance, and shortcuts through Main", async () => {
    const legacySettings = commaClientSettingsSchema.parse({
      ...structuredClone(defaultCommaClientSettings),
      appShortcutOverrides: { "go-settings": null },
      appearance: {
        ...defaultCommaClientSettings.appearance,
        theme: "dark",
      },
      localePreference: "zh-CN",
    });
    let preferences = appPreferencesSchema.parse({
      launchAtLogin: false,
      showInDock: true,
      showInMenuBar: true,
    });
    const initializeClientSettings = vi.fn(async (settings: CommaClientSettings) => {
      if (!preferences.clientSettings) {
        preferences = appPreferencesSchema.parse({
          ...preferences,
          clientSettings: settings,
          revision: preferences.revision + 1,
        });
      }
      return preferences;
    });
    const update = vi.fn(async (patch: AppPreferencesPatch) => {
      const clientPatch = patch.clientSettings;
      const current = preferences.clientSettings ?? defaultCommaClientSettings;
      preferences = appPreferencesSchema.parse({
        ...preferences,
        ...patch,
        ...(clientPatch
          ? {
              clientSettings: commaClientSettingsSchema.parse({
                ...current,
                ...clientPatch,
                appearance: {
                  ...current.appearance,
                  ...clientPatch.appearance,
                },
              }),
            }
          : {}),
        revision: preferences.revision + 1,
      });
      return preferences;
    });
    installNativeBridgeMock({
      appPreferences: {
        initializeClientSettings,
        state: createNativeStateBridgeMock(() => preferences),
        update,
      },
      platform: "electron",
    });

    render(
      <CommaElectronClientSettingsProvider
        initialPreferences={preferences}
        migrationSettings={legacySettings}
      >
        <CommaClientSettingsI18nProvider>
          <CommaAppearanceProvider>
            <CommaAppShortcutsProvider platform="macos">
              <SettingsProbe />
            </CommaAppShortcutsProvider>
          </CommaAppearanceProvider>
        </CommaClientSettingsI18nProvider>
      </CommaElectronClientSettingsProvider>
    );

    await waitFor(() => expect(initializeClientSettings).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("client settings")).toHaveTextContent(
      "zh-CN:dark:off"
    );

    await userEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() =>
      expect(screen.getByLabelText("client settings")).toHaveTextContent("en:dark:off")
    );
    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    await waitFor(() =>
      expect(screen.getByLabelText("client settings")).toHaveTextContent("en:light:off")
    );
    await userEvent.click(screen.getByRole("button", { name: "Disable search" }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith({
        clientSettings: {
          appShortcutOverrides: {
            "go-search": null,
            "go-settings": null,
          },
        },
      })
    );
  });
  it("isolates pending transitions so settings consumers do not re-render on pending changes", async () => {
    let preferences = appPreferencesSchema.parse({
      clientSettings: structuredClone(defaultCommaClientSettings),
      launchAtLogin: false,
      showInDock: true,
      showInMenuBar: true,
    });
    let resolveUpdate: ((prefs: any) => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveUpdate = resolve;
        })
    );
    installNativeBridgeMock({
      appPreferences: {
        initializeClientSettings: vi.fn(async () => preferences),
        state: createNativeStateBridgeMock(() => preferences),
        update,
      },
      platform: "electron",
    });

    let settingsRenderCount = 0;
    function SettingsConsumer() {
      const { settings, update: applyUpdate } = useCommaClientSettings();
      settingsRenderCount++;
      return (
        <button
          onClick={() => void applyUpdate({ sessionHistoryEnabled: true })}
          type="button"
        >
          {settings.sessionHistoryEnabled ? "enabled" : "disabled"}
        </button>
      );
    }

    render(
      <CommaElectronClientSettingsProvider initialPreferences={preferences}>
        <SettingsConsumer />
        <PendingConsumer />
      </CommaElectronClientSettingsProvider>
    );

    expect(screen.getByLabelText("pending-status")).toHaveTextContent("idle");
    expect(settingsRenderCount).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "disabled" }));

    await waitFor(() =>
      expect(screen.getByLabelText("pending-status")).toHaveTextContent("pending")
    );
    expect(settingsRenderCount).toBe(1);

    preferences = appPreferencesSchema.parse({
      ...preferences,
      clientSettings: {
        ...preferences.clientSettings!,
        sessionHistoryEnabled: true,
      },
      revision: preferences.revision + 1,
    });
    resolveUpdate!(preferences);

    await waitFor(() =>
      expect(screen.getByLabelText("pending-status")).toHaveTextContent("idle")
    );
    expect(screen.getByRole("button", { name: "enabled" })).toBeInTheDocument();
    expect(settingsRenderCount).toBe(2);
  });

  it("keeps settings and appearance consumers still when only another preference changes", async () => {
    let preferences = appPreferencesSchema.parse({
      clientSettings: structuredClone(defaultCommaClientSettings),
      launchAtLogin: false,
      showInDock: true,
      showInMenuBar: true,
      showInNotch: true,
    });
    const listeners: Array<(snapshot: AppPreferences) => void> = [];
    const state = createNativeStateBridgeMock(() => preferences);
    state.subscribe = vi.fn((listener: (snapshot: AppPreferences) => void) => {
      listeners.push(listener);
      return () => {};
    }) as typeof state.subscribe;
    installNativeBridgeMock({
      appPreferences: {
        initializeClientSettings: vi.fn(async () => preferences),
        state,
        update: vi.fn(async () => preferences),
      },
      platform: "electron",
    });
    // Main publishes every change as a whole snapshot; IPC delivers a new copy.
    const publish = (next: Partial<AppPreferences>) => {
      preferences = appPreferencesSchema.parse({
        ...preferences,
        ...next,
        revision: preferences.revision + 1,
      });
      act(() => {
        for (const listener of listeners) listener(structuredClone(preferences));
      });
    };

    let settingsRenders = 0;
    let appearanceRenders = 0;
    function SettingsConsumer() {
      const { settings } = useCommaClientSettings();
      settingsRenders += 1;
      return (
        <output aria-label="history">{String(settings.sessionHistoryEnabled)}</output>
      );
    }
    function AppearanceConsumer() {
      useCommaAppearance();
      appearanceRenders += 1;
      return null;
    }

    render(
      <CommaElectronClientSettingsProvider initialPreferences={preferences}>
        <CommaAppearanceProvider>
          <SettingsConsumer />
          <AppearanceConsumer />
        </CommaAppearanceProvider>
      </CommaElectronClientSettingsProvider>
    );
    await waitFor(() => expect(listeners).toHaveLength(1));
    const settledSettings = settingsRenders;
    const settledAppearance = appearanceRenders;

    publish({ showInNotch: false });
    publish({ notchSideWidth: 200 });
    expect(settingsRenders).toBe(settledSettings);
    expect(appearanceRenders).toBe(settledAppearance);

    publish({
      clientSettings: {
        ...preferences.clientSettings!,
        sessionHistoryEnabled: !preferences.clientSettings!.sessionHistoryEnabled,
      },
    });
    expect(screen.getByLabelText("history")).toHaveTextContent(
      String(!defaultCommaClientSettings.sessionHistoryEnabled)
    );
    expect(settingsRenders).toBe(settledSettings + 1);
  });
});

function PersistedWebSettingsProbe() {
  const { settings } = useCommaClientSettings();
  return (
    <div>
      <span aria-label="locale">{settings.localePreference}</span>
      <span aria-label="history">{String(settings.sessionHistoryEnabled)}</span>
      <span aria-label="ptt-enabled">{String(settings.pushToTalkEnabled)}</span>
      <span aria-label="ptt-screen">{String(settings.pushToTalkSendScreen)}</span>
    </div>
  );
}

describe("CommaWebClientSettingsProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("migrates persisted browser settings containing retired pushToTalkSpeakReplies without resetting unrelated preferences", async () => {
    const oldPersistedSettings = {
      ...structuredClone(defaultCommaClientSettings),
      localePreference: "pt-BR",
      sessionHistoryEnabled: true,
      pushToTalkEnabled: true,
      pushToTalkSendScreen: false,
      pushToTalkSpeakReplies: false,
    };
    localStorage.setItem(
      commaClientSettingsStorageKey,
      JSON.stringify(oldPersistedSettings)
    );

    const initial = readWebCommaClientSettings();
    expect(initial.localePreference).toBe("pt-BR");
    expect(initial.sessionHistoryEnabled).toBe(true);
    expect(initial.pushToTalkEnabled).toBe(true);
    expect(initial.pushToTalkSendScreen).toBe(false);
    expect(initial).not.toHaveProperty("pushToTalkSpeakReplies");

    render(
      <CommaWebClientSettingsProvider>
        <PersistedWebSettingsProbe />
      </CommaWebClientSettingsProvider>
    );

    expect(screen.getByLabelText("locale")).toHaveTextContent("pt-BR");
    expect(screen.getByLabelText("history")).toHaveTextContent("true");
    expect(screen.getByLabelText("ptt-enabled")).toHaveTextContent("true");
    expect(screen.getByLabelText("ptt-screen")).toHaveTextContent("false");

    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem(commaClientSettingsStorageKey) ?? "{}"
      );
      expect(stored).not.toHaveProperty("pushToTalkSpeakReplies");
      expect(stored.localePreference).toBe("pt-BR");
      expect(stored.sessionHistoryEnabled).toBe(true);
      expect(stored.pushToTalkEnabled).toBe(true);
      expect(stored.pushToTalkSendScreen).toBe(false);
    });
  });
});
