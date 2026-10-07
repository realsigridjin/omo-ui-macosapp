import { useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { DeviceOverview } from "../../../shared/device-overview";
import type { AndroidStatus } from "../../../shared/android";
import { useT } from "../../i18n";
import { SectionHeading } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

export function DevicesSection() {
  const t = useT();
  const [overview, setOverview] = useState<DeviceOverview | null>(null);
  const [android, setAndroid] = useState<AndroidStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([window.omo.getDeviceOverview(), window.omo.getAndroidStatus()]).then(([device, phone]) => { if (active) { setOverview(device); setAndroid(phone); } }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    const unsubscribe = window.omo.onAndroidStatus((value) => { if (active) setAndroid(value); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return <section className={css.section} data-testid="settings-devices" aria-busy={overview === null && error === null}>
    <SectionHeading title={t("shell.settings.nav.devices")} intro={t("shell.settings.devices.intro")} />
    {error && <p className={css.error} role="alert">{error}</p>}
    <article className={css.card}><div className={css.cardBody}>
      <h3>{t("shell.settings.devices.thisDevice")}</h3>
      <dl className={css.facts}>
        <dt>{t("shell.settings.devices.name")}</dt><dd>{overview?.hostname ?? "—"}</dd>
        <dt>OS</dt><dd>{overview?.platform === "win32" ? "Windows" : overview?.platform ?? "—"}</dd>
        <dt>OmO UI</dt><dd>{overview?.appVersion ?? "—"}</dd>
        <dt>omo</dt><dd>{overview?.omoVersion ?? "—"}</dd>
      </dl>
      <h3>Android</h3>
      <p>{android?.selectedSerial ?? t("shell.settings.devices.noPhone")}</p>
      <p className={css.muted}>{t("shell.settings.devices.phoneHint")}</p>
    </div></article>
    <article className={css.card}><div className={css.cardBody}>
      <h3>{t("shell.settings.devices.memory")}</h3>
      <p className={css.muted}>{t("shell.settings.devices.localHint")}</p>
      {overview?.memory.state === "available" ? <>
        <dl className={css.facts}>
          <dt>{t("shell.settings.devices.branch")}</dt><dd>{overview.memory.branch}</dd>
          <dt>{t("shell.settings.devices.lastCommit")}</dt><dd>{overview.memory.lastCommitAt ? new Date(overview.memory.lastCommitAt).toLocaleString() : "—"}</dd>
          <dt>{t("shell.settings.devices.changes")}</dt><dd>{overview.memory.changedFiles}</dd>
          <dt>{t("shell.settings.devices.remote")}</dt><dd>{t(overview.memory.remoteConfigured ? "shell.settings.devices.configured" : "shell.settings.devices.notConfigured")}</dd>
        </dl>
        {overview.memory.path && <Button variant="outline" onClick={() => void window.omo.revealPath(overview.memory.path ?? "")}>{t("shell.settings.devices.openMemory")}</Button>}
      </> : overview !== null ? <p>{t("shell.settings.devices.noMemory")}</p> : null}
    </div></article>
  </section>;
}
