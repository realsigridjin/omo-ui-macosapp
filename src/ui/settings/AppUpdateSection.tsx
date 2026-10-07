import { useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AppUpdateStatus } from "../../../shared/app-update";
import { selectIsTurnActive, useAppSelector } from "../../state";
import { useT } from "../../i18n";
import { SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

export function AppUpdateSection() {
  const t = useT();
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnActive = useAppSelector((state) => Object.keys(state.threads).some((id) => selectIsTurnActive(state, id)));
  useEffect(() => {
    let active = true;
    let updated = false;
    const unsubscribe = window.omo.onAppUpdateStatus((value) => { updated = true; if (active) setStatus(value); });
    void window.omo.getAppUpdateStatus().then((value) => { if (active && !updated) setStatus(value); }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const run = async (action: () => Promise<AppUpdateStatus>): Promise<void> => {
    setError(null);
    try { setStatus(await action()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const busy = status?.state === "checking" || status?.state === "downloading" || status?.state === "installing";
  return <div className={css.card} data-testid="app-update" aria-busy={busy}>
    <SettingRow title={t("shell.settings.appUpdate.title")} hint={t("shell.settings.appUpdate.hint")}>
      <Button variant="outline" disabled={busy || status?.state === "unsupported"} data-testid="app-update-check" onClick={() => void run(() => window.omo.checkAppUpdate())}>{t("shell.settings.appUpdate.check")}</Button>
    </SettingRow>
    <div className={css.cardBody}>
      <p role="status" data-testid="app-update-status" data-state={status?.state ?? "idle"}>{t(`shell.settings.appUpdate.${status?.state ?? "idle"}`)}</p>
      {status?.latestVersion && <p>{t("shell.settings.appUpdate.version", { current: status.currentVersion, latest: status.latestVersion })}</p>}
      {status?.progress !== null && status?.progress !== undefined && status.state === "downloading" && <progress max={100} value={status.progress} aria-label={t("shell.settings.appUpdate.downloading")} />}
      {(status?.state === "available" || status?.state === "ready") && <>
        <p className={css.muted}>{t("shell.settings.appUpdate.installHint")}</p>
        <Button variant="primary" disabled={turnActive || busy} data-testid="app-update-install" onClick={() => void run(() => window.omo.installAppUpdate())}>{t("shell.settings.appUpdate.install")}</Button>
      </>}
      {(error || status?.message) && <p className={css.error} role="alert">{error || status?.message}</p>}
      <Button variant="outline" size="sm" onClick={() => void window.omo.openExternal("https://github.com/JunesuChoi/omo-ui-windows/releases")}>{t("shell.settings.appUpdate.releases")}</Button>
    </div>
  </div>;
}
