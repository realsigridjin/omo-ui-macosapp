import { useState } from "react";
import type { CSSProperties } from "react";
import { SegmentedControl } from "@deepseek-ai/dsh-client-ui-primitives";
import type { LocalePreference, Preferences, ThemePreference } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { revealThemePreference } from "../theme";
import type { TestId } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { BehaviorSettings } from "./BehaviorSettings";
import { errorMessage } from "./diagnostics";
import { SectionHeading, SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

const THEME_TESTID: Record<ThemePreference, TestId> = {
  system: TESTID.settingsThemeSystem,
  light: TESTID.settingsThemeLight,
  dark: TESTID.settingsThemeDark,
};

async function savePreferences(patch: Partial<Preferences>): Promise<void> {
  const previous = uiState.get().preferences;
  if (previous !== null) uiState.setPreferences({ ...previous, ...patch });
  try {
    await updatePreferences(patch);
  } catch (error) {
    if (previous !== null) uiState.setPreferences(previous);
    throw error;
  }
}

function ThemeChoice({ value, onChange }: { value: ThemePreference; onChange(next: ThemePreference, control: HTMLButtonElement): void }) {
  const t = useT();
  const indicator = {
    "--dsh-segment-count": String(THEMES.length),
    "--dsh-segment-index": String(THEMES.indexOf(value)),
  } as CSSProperties;
  return (
    <div className={css.segments} role="group" aria-label={t("shell.settings.theme")} style={indicator}>
      <span aria-hidden="true" className={css.segmentIndicator} />
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          className={css.segment}
          data-testid={THEME_TESTID[option]}
          aria-pressed={option === value}
          onClick={(event) => {
            if (option !== value) onChange(option, event.currentTarget);
          }}
        >
          {t(`shell.settings.theme.${option}`)}
        </button>
      ))}
    </div>
  );
}

export function GeneralSection() {
  const t = useT();
  const { preferences } = useUiState();
  const [error, setError] = useState<string | null>(null);
  const theme = preferences?.theme ?? "system";
  const locale = preferences?.locale ?? "system";

  const save = (patch: Partial<Preferences>): void => {
    savePreferences(patch).then(
      () => setError(null),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  };

  return (
    <section className={css.section}>
      <SectionHeading title={t("shell.settings.nav.general")} intro={t("shell.settings.general.intro")} />
      <BehaviorSettings />
      <div className={css.card}>
        <SettingRow title={t("shell.settings.theme")} hint={t("shell.settings.theme.hint")}>
          <ThemeChoice value={theme} onChange={(next, control) => revealThemePreference(next, control, () => save({ theme: next }))} />
        </SettingRow>
        <SettingRow title={t("shell.settings.language")} hint={t("shell.settings.language.hint")}>
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
              onChange={(next) => save({ locale: next })}
            />
          </div>
        </SettingRow>
      </div>
      {error !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.saveFailed", { message: error })}
        </p>
      )}
    </section>
  );
}
