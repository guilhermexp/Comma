import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CommaWebClientSettingsProvider,
  CommaClientSettingsI18nProvider,
  readWebCommaClientSettings,
} from "../../src/components/commaClientSettings";
import { CommaAppearanceProvider } from "../../src/components/commaAppearance";
import {
  CustomThemeStudio,
  ThemePicker,
} from "../../src/components/commaCustomThemeStudio";
import { e2eLocale } from "../../../../e2e/helpers/english-locale";
import "../../src/styles.css";

// The studio's own settings, in the suite's language rather than the default.
const initialSettings = {
  ...readWebCommaClientSettings(),
  localePreference: e2eLocale,
};

function Fixture() {
  const [open, setOpen] = useState(true);
  const picker = new URLSearchParams(location.search).has("picker");
  return (
    <CommaWebClientSettingsProvider initialSettings={initialSettings}>
      <CommaClientSettingsI18nProvider>
        <CommaAppearanceProvider>
          {!picker && (
            <button type="button" onClick={() => setOpen((current) => !current)}>
              {open ? "Close studio" : "Open studio"}
            </button>
          )}
          <div style={{ width: "min(400px, calc(100vw - 80px))", margin: 40 }}>
            {picker ? <ThemePicker /> : open ? <CustomThemeStudio /> : null}
          </div>
        </CommaAppearanceProvider>
      </CommaClientSettingsI18nProvider>
    </CommaWebClientSettingsProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
