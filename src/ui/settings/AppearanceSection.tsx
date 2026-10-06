import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  IconDarkOutlineRegular,
  IconLightOutlineRegular,
  SegmentedControl,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { COLOR_THEMES } from "../../../shared/ipc";
import type { ColorTheme, LocalePreference, Preferences, ThemePreference } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { applyColorTheme, revealThemeChange, revealThemePreference } from "../theme";
import { updatePreferences, useUiState } from "../ui-state";
import { errorMessage } from "./diagnostics";
import { SettingsCard, SettingsGroup, SettingsRow } from "./SettingsCard";
import css from "./SettingsCard.module.css";
import view from "./AppearanceSection.module.css";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

const THEME_TESTID: Record<ThemePreference, string> = {
  system: TESTID.settingsThemeSystem,
  light: TESTID.settingsThemeLight,
  dark: TESTID.settingsThemeDark,
};

/** Fixed preview surfaces so each card shows its own scheme regardless of the live theme. */
const MOCK: Record<"light" | "dark", { surface: string; panel: string; line: string; bar: string; dot: string }> = {
  light: { surface: "#fbf9ff", panel: "#f4effd", line: "#e6ddf8", bar: "#ffffff", dot: "#4d6bfe" },
  dark: { surface: "#130c1d", panel: "#1a1127", line: "#342a41", bar: "#221a2e", dot: "#8098ff" },
};

const PALETTE_SWATCH: Record<ColorTheme, { light: string; dark: string; accent: string }> = {
  omo: { light: "#f4effd", dark: "#1a1127", accent: "#8b5cf6" },
  classic: { light: "#fbeef1", dark: "#22121b", accent: "#e11d48" },
  mint: { light: "#ecf6f0", dark: "#0f1e17", accent: "#059669" },
  ocean: { light: "#ecf1fa", dark: "#101a2b", accent: "#2563eb" },
};

function SchemeMock({ scheme }: { scheme: "light" | "dark" }) {
  const mock = MOCK[scheme];
  return (
    <span aria-hidden="true" className={view.mock} style={{ background: mock.surface }}>
      <span className={view.mockSidebar} style={{ background: mock.panel }}>
        <span className={view.mockLine} style={{ background: mock.line }} />
        <span className={view.mockLine} style={{ background: mock.line }} />
      </span>
      <span className={view.mockMain}>
        <span className={view.mockLine} style={{ background: mock.line }} />
        <span className={view.mockBar} style={{ background: mock.bar }}>
          <span className={view.mockDot} style={{ background: mock.dot }} />
        </span>
      </span>
    </span>
  );
}

function SchemeCard({ value, selected, onSelect, children }: {
  value: ThemePreference;
  selected: boolean;
  onSelect(next: ThemePreference, control: HTMLButtonElement): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={view.schemeCard}
      data-testid={THEME_TESTID[value]}
      aria-pressed={selected}
      onClick={(event) => {
        if (!selected) onSelect(value, event.currentTarget);
      }}
    >
      {value === "system" ? (
        <span aria-hidden="true" className={view.mockSplit}>
          <SchemeMock scheme="light" />
          <SchemeMock scheme="dark" />
        </span>
      ) : (
        <SchemeMock scheme={value} />
      )}
      <span className={view.cardLabel}>{children}</span>
    </button>
  );
}

function PaletteCard({ theme, active, dark, onSelect }: {
  theme: ColorTheme;
  active: boolean;
  dark: boolean;
  onSelect(next: ColorTheme, control: HTMLButtonElement): void;
}) {
  const t = useT();
  const swatch = PALETTE_SWATCH[theme];
  return (
    <button
      type="button"
      className={view.paletteCard}
      data-testid={TESTID.settingsColorTheme}
      data-theme={theme}
      aria-pressed={active}
      onClick={(event) => onSelect(theme, event.currentTarget)}
    >
      <span className={view.swatchPair}>
        <span
          className={view.swatch}
          data-variant="light"
          data-active={!dark}
          style={{ background: swatch.light }}
          title={t("shell.settings.appearance.lightVariant")}
        >
          <span className={view.swatchBadge} style={{ background: swatch.light }}>
            <IconLightOutlineRegular size={10} />
          </span>
        </span>
        <span
          className={view.swatch}
          data-variant="dark"
          data-active={dark}
          style={{ background: swatch.dark }}
          title={t("shell.settings.appearance.darkVariant")}
        >
          <span className={view.swatchBadge} style={{ background: swatch.dark }}>
            <IconDarkOutlineRegular size={10} />
          </span>
        </span>
      </span>
      <span className={view.cardLabel}>{t(`shell.settings.colorTheme.${theme}`)}</span>
    </button>
  );
}

/** True while the applied scheme resolves to dark; follows the preference and the OS setting. */
function useSchemeIsDark(pref: ThemePreference): boolean {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = (): void => setSystemDark(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return pref === "dark" || (pref === "system" && systemDark);
}

export function AppearanceSection() {
  const t = useT();
  const { preferences } = useUiState();
  const [error, setError] = useState<string | null>(null);
  const theme = preferences?.theme ?? "system";
  const colorTheme = preferences?.colorTheme ?? "omo";
  const locale = preferences?.locale ?? "system";
  const dark = useSchemeIsDark(theme);

  const persist = (patch: Partial<Preferences>): void => {
    updatePreferences(patch).then(
      () => setError(null),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  };

  const selectColorTheme = (next: ColorTheme, control: HTMLButtonElement): void => {
    revealThemeChange(control, () => {
      applyColorTheme(next);
      persist({ colorTheme: next });
    });
  };

  return (
    <section className={css.section}>
      <SettingsGroup title={t("shell.settings.nav.appearance")} intro={t("shell.settings.appearance.intro")} />
      <SettingsGroup title={t("shell.settings.appearance.scheme")} />
      <div className={view.schemeRow} role="group" aria-label={t("shell.settings.theme")}>
        {THEMES.map((value) => (
          <SchemeCard
            key={value}
            value={value}
            selected={theme === value}
            onSelect={(next, control) => revealThemePreference(next, control, () => persist({ theme: next }))}
          >
            {t(`shell.settings.theme.${value}`)}
          </SchemeCard>
        ))}
      </div>
      <SettingsGroup title={t("shell.settings.appearance.palettes")} intro={t("shell.settings.appearance.paletteHint")} />
      <div className={view.paletteGrid} role="group" aria-label={t("shell.settings.appearance.palettes")}>
        {COLOR_THEMES.map((value) => (
          <PaletteCard
            key={value}
            theme={value}
            active={colorTheme === value}
            dark={dark}
            onSelect={selectColorTheme}
          />
        ))}
      </div>
      <SettingsCard>
        <SettingsRow title={t("shell.settings.language")} description={t("shell.settings.language.hint")}>
          <div data-testid={TESTID.settingsLanguage}>
            <SegmentedControl<LocalePreference>
              id="settings-language"
              label={t("shell.settings.language")}
              value={locale}
              options={[
                { value: "system", label: t("shell.settings.language.system") },
                { value: "en", label: t("shell.settings.language.en") },
                { value: "ko", label: t("shell.settings.language.ko") },
              ]}
              onChange={(next) => persist({ locale: next })}
            />
          </div>
        </SettingsRow>
      </SettingsCard>
      {error !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.saveFailed", { message: error })}
        </p>
      )}
    </section>
  );
}
