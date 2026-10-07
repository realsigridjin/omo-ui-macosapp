import { useMemo, useState } from "react";
import clsx from "clsx";
import type { ModelProfile } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { useAppSelector } from "../app-context";
import { groupModels } from "../composer/model-groups";
import { PROFILE_LANES, resolveProfile } from "../composer/model-profiles";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { errorMessage } from "./diagnostics";
import { SectionHeading, SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";
import { ModelRoutingSection } from "./ModelRoutingSection";

/** Rows read Daily before Geeky and Normal before Heavy; the composer's pad lays the same lanes out in 2D. */
const ROW_ORDER: readonly ModelProfile[] = ["daily-normal", "daily-heavy", "geeky-normal", "geeky-heavy"];
const LANES = ROW_ORDER.map((id) => PROFILE_LANES.find((lane) => lane.id === id)!);

/** Stores the model each profile lane runs in `preferences.profileModels`; a lane without an entry resolves automatically. */
export function ModelSection() {
  const t = useT();
  const models = useAppSelector((state) => state.models);
  const { preferences } = useUiState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupModels(models), [models]);
  const profileModels = preferences?.profileModels;

  const choose = (profile: ModelProfile, modelId: string): void => {
    const previous = uiState.get().preferences;
    if (previous === null) return;
    const next = { ...previous.profileModels };
    if (modelId === "") delete next[profile];
    else next[profile] = modelId;
    uiState.setPreferences({ ...previous, profileModels: next });
    setSaving(true);
    setError(null);
    updatePreferences({ profileModels: next }).then(
      () => setSaving(false),
      (reason: unknown) => {
        uiState.setPreferences(previous);
        setSaving(false);
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <section className={css.section} data-testid="settings-model" aria-busy={saving}>
      <SectionHeading title={t("shell.settings.nav.model")} intro={t("shell.settings.model.intro")} />
      <div className={clsx(css.card, css.wrapRows)}>
        {LANES.map((lane) => {
          const title = `${t(`composer.profile.${lane.family}`)} · ${t(`composer.profile.${lane.weight}`)}`;
          const configured = profileModels?.[lane.id];
          const listed = groups.some((group) => group.models.some((model) => model.id === configured));
          const missing = configured !== undefined && !listed ? configured : null;
          const resolved = resolveProfile(models, lane.id, profileModels);
          return (
            <SettingRow
              key={lane.id}
              title={title}
              hint={
                <>
                  {t(`composer.profile.description.${lane.id}`)}
                  <span className={css.rowNote} data-lane-resolved={lane.id}>
                    {t("composer.profile.resolved")}: {resolved.model?.displayName ?? t("composer.model.none")}
                    {resolved.effort !== null && ` · ${t(`composer.effort.${resolved.effort}`)}`}
                  </span>
                  {missing !== null && (
                    <span className={css.rowWarning} role="status" data-lane-unavailable={lane.id}>
                      {t("shell.settings.model.unavailable", { model: missing })}
                    </span>
                  )}
                </>
              }
            >
              <select
                className={css.select}
                value={configured ?? ""}
                disabled={preferences === null || saving}
                aria-label={`${t("composer.profile.model")}: ${title}`}
                data-profile={lane.id}
                onChange={(event) => choose(lane.id, event.target.value)}
              >
                <option value="">{t("composer.profile.automatic")}</option>
                {missing !== null && (
                  <option value={missing} disabled>
                    {missing}
                  </option>
                )}
                {groups.map((group) => (
                  <optgroup key={group.provider} label={group.provider}>
                    {group.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </SettingRow>
          );
        })}
      </div>
      {groups.length === 0 && <p className={css.muted}>{t("composer.model.empty")}</p>}
      <ModelRoutingSection />
      {error !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.saveFailed", { message: error })}
        </p>
      )}
    </section>
  );
}
