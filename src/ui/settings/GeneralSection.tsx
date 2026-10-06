import { useState } from "react";
import { IconCloseCircleFillRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Preferences } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { BehaviorSettings } from "./BehaviorSettings";
import { errorMessage } from "./diagnostics";
import { SettingsCard, SettingsGroup, SettingsRow } from "./SettingsCard";
import css from "./SettingsCard.module.css";

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

function baseName(dir: string): string {
  const parts = dir.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? dir;
}

export function GeneralSection() {
  const t = useT();
  const { preferences } = useUiState();
  const [error, setError] = useState<string | null>(null);
  const lastWorkspace = preferences?.lastWorkspace ?? null;
  const recent = preferences?.recentWorkspaces ?? [];

  const save = (patch: Partial<Preferences>): void => {
    savePreferences(patch).then(
      () => setError(null),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  };

  const removeRecent = (dir: string): void => {
    const nextRecent = recent.filter((entry) => entry !== dir);
    const patch: Partial<Preferences> = { recentWorkspaces: nextRecent };
    if (lastWorkspace === dir) patch.lastWorkspace = null;
    save(patch);
  };

  return (
    <section className={css.section}>
      <SettingsGroup title={t("shell.settings.nav.general")} intro={t("shell.settings.general.intro")} />
      <BehaviorSettings />
      <SettingsCard>
        <SettingsRow title={t("shell.settings.general.workspace")} description={t("shell.settings.general.workspaceHint")}>
          <select
            className={css.select}
            data-testid={TESTID.settingsWorkspaceDefault}
            disabled={preferences === null}
            value={lastWorkspace ?? ""}
            onChange={(event) => save({ lastWorkspace: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{t("shell.settings.general.workspaceAsk")}</option>
            {recent.map((dir) => (
              <option key={dir} value={dir}>
                {baseName(dir)}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
      <SettingsCard>
        <div className={css.cardBody}>
          <div className={css.groupLabel}>{t("shell.settings.general.recent")}</div>
          <p className={css.muted}>{t("shell.settings.general.recentHint")}</p>
          {recent.length === 0 ? (
            <p className={css.muted}>{t("shell.settings.general.recentEmpty")}</p>
          ) : (
            recent.map((dir) => (
              <div className={css.listRow} key={dir}>
                <span className={css.listPath} title={dir}>
                  {dir}
                </span>
                <button
                  type="button"
                  className={css.iconButton}
                  data-testid={TESTID.settingsWorkspaceRemove}
                  aria-label={t("shell.settings.general.removeWorkspace", { name: dir })}
                  onClick={() => removeRecent(dir)}
                >
                  <IconCloseCircleFillRegular size={14} />
                </button>
              </div>
            ))
          )}
        </div>
        {recent.length > 0 && (
          <div className={css.cardFooterActions}>
            <button
              type="button"
              className={css.textButton}
              onClick={() => save({ recentWorkspaces: [], ...(lastWorkspace !== null ? { lastWorkspace: null } : {}) })}
            >
              {t("shell.settings.general.clearRecent")}
            </button>
          </div>
        )}
      </SettingsCard>
      {error !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.saveFailed", { message: error })}
        </p>
      )}
    </section>
  );
}
