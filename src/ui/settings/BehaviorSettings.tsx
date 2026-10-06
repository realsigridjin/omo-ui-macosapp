import { useState } from "react";
import { SegmentedControl } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Preferences, ThreadNotificationPreference, TimeFormatPreference } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { errorMessage } from "./diagnostics";
import { SettingsCard, SettingsGroup, SettingsRow, Toggle } from "./SettingsCard";
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

/**
 * The General settings groups for thread behaviour: "Organization" (auto-settle and its days) and "Behavior"
 * (thread notifications, in-app notifications, time format). Self-contained so a different settings surface
 * can mount it unchanged.
 */
export function BehaviorSettings() {
  const t = useT();
  const { preferences } = useUiState();
  const [error, setError] = useState<string | null>(null);

  const save = (patch: Partial<Preferences>): void => {
    savePreferences(patch).then(
      () => setError(null),
      (reason: unknown) => setError(errorMessage(reason)),
    );
  };

  const autoSettle = preferences?.autoSettle ?? true;
  const autoSettleDays = preferences?.autoSettleDays ?? 3;
  const threadNotifications = preferences?.threadNotifications ?? "background";
  const inAppNotifications = preferences?.inAppNotifications ?? true;
  const timeFormat = preferences?.timeFormat ?? "system";

  return (
    <>
      <SettingsGroup title={t("shell.settings.group.organization")} />
      <SettingsCard>
        <SettingsRow title={t("shell.settings.autoSettle")} description={t("shell.settings.autoSettle.hint")}>
          <Toggle testId={TESTID.settingsAutoSettle} checked={autoSettle} label={t("shell.settings.autoSettle")} disabled={preferences === null} onChange={() => save({ autoSettle: !autoSettle })} />
        </SettingsRow>
        <SettingsRow title={t("shell.settings.autoSettleDays")} description={t("shell.settings.autoSettleDays.hint")}>
          <input
            type="number"
            className={css.numberInput}
            data-testid={TESTID.settingsAutoSettleDays}
            aria-label={t("shell.settings.autoSettleDays")}
            min={1}
            max={365}
            step={1}
            value={autoSettleDays}
            disabled={!autoSettle || preferences === null}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value !== autoSettleDays) save({ autoSettleDays: value });
            }}
          />
        </SettingsRow>
        {error !== null && (
          <p className={css.error} role="alert">
            {t("shell.settings.saveFailed", { message: error })}
          </p>
        )}
      </SettingsCard>
      <SettingsGroup title={t("shell.settings.group.behavior")} />
      <SettingsCard>
        <SettingsRow title={t("shell.settings.threadNotifications")} description={t("shell.settings.threadNotifications.hint")}>
          <div data-testid={TESTID.settingsThreadNotifications}>
            <SegmentedControl<ThreadNotificationPreference>
              id="settings-thread-notifications"
              label={t("shell.settings.threadNotifications")}
              value={threadNotifications}
              options={[
                { value: "off", label: t("shell.settings.threadNotifications.off") },
                { value: "background", label: t("shell.settings.threadNotifications.background") },
                { value: "always", label: t("shell.settings.threadNotifications.always") },
              ]}
              onChange={(next) => save({ threadNotifications: next })}
            />
          </div>
        </SettingsRow>
        <SettingsRow title={t("shell.settings.inAppNotifications")} description={t("shell.settings.inAppNotifications.hint")}>
          <Toggle testId={TESTID.settingsInAppNotifications} checked={inAppNotifications} label={t("shell.settings.inAppNotifications")} disabled={preferences === null} onChange={() => save({ inAppNotifications: !inAppNotifications })} />
        </SettingsRow>
        <SettingsRow title={t("shell.settings.timeFormat")} description={t("shell.settings.timeFormat.hint")}>
          <div data-testid={TESTID.settingsTimeFormat}>
            <SegmentedControl<TimeFormatPreference>
              id="settings-time-format"
              label={t("shell.settings.timeFormat")}
              value={timeFormat}
              options={[
                { value: "system", label: t("shell.settings.timeFormat.system") },
                { value: "12h", label: t("shell.settings.timeFormat.12h") },
                { value: "24h", label: t("shell.settings.timeFormat.24h") },
              ]}
              onChange={(next) => save({ timeFormat: next })}
            />
          </div>
        </SettingsRow>
        {error !== null && (
          <p className={css.error} role="alert">
            {t("shell.settings.saveFailed", { message: error })}
          </p>
        )}
      </SettingsCard>
    </>
  );
}
