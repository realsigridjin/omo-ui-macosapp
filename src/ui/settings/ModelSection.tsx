import { useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state";
import { resolveProfile } from "../composer/model-profiles";
import { useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { updatePreferences, useUiState } from "../ui-state";
import { errorMessage } from "./diagnostics";
import { ModelMappingSettings } from "./ModelMappingSettings";
import { SettingsCard, SettingsGroup, SettingsRow } from "./SettingsCard";
import css from "./SettingsCard.module.css";

export function ModelSection() {
  const t = useT();
  const store = useAppStore();
  const models = useAppSelector((state) => state.models);
  const currentId = useAppSelector((state) => state.composer.modelId);
  const { preferences } = useUiState();
  const [error, setError] = useState<string | null>(null);
  const visible = models.filter((model) => !model.hidden);
  const resolved = preferences?.modelProfile != null && visible.length > 0
    ? resolveProfile(visible, preferences.modelProfile).model
    : null;
  const selected = preferences?.modelId ?? resolved?.id ?? null;

  const choose = (modelId: string): void => {
    const next = modelId === "" ? null : modelId;
    store.dispatch({ type: "composer/modelSelected", modelId: next, effort: null, profile: null });
    updatePreferences({ modelId: next }).then(
      () => setError(null),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  };

  return (
    <section className={css.section}>
      <SettingsGroup title={t("shell.settings.nav.model")} intro={t("shell.settings.model.intro")} />
      <SettingsCard>
        <SettingsRow title={t("shell.settings.model.default")} description={t("shell.settings.model.defaultHint")}>
          <select
            className={css.select}
            data-testid={TESTID.settingsDefaultModel}
            disabled={preferences === null || visible.length === 0}
            value={selected ?? ""}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{t("shell.settings.model.askDefault")}</option>
            {visible.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
      <ModelMappingSettings />
      <SettingsGroup title={t("shell.settings.model.available")} intro={t("shell.settings.model.availableHint")} />
      {visible.length === 0 ? (
        <p className={css.muted}>{t("shell.settings.model.loading")}</p>
      ) : (
        <SettingsCard>
          <div className={css.cardBody}>
            {visible.map((model) => (
              <div
                key={model.id}
                className={css.listRow}
                data-testid={TESTID.settingsModelRow}
                data-current={model.id === currentId || undefined}
              >
                <div className={css.rowText}>
                  <div className={css.rowTitle}>{model.displayName}</div>
                  <div className={css.rowHint}>{model.description}</div>
                </div>
                {model.isDefault && <span className={css.badge}>{t("shell.settings.model.askDefault")}</span>}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
      {error !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.saveFailed", { message: error })}
        </p>
      )}
    </section>
  );
}
