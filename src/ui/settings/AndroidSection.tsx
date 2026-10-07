import { useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AndroidStatus } from "../../../shared/android";
import { useT } from "../../i18n";
import { SectionHeading } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

export function AndroidSection() {
  const t = useT();
  const [status, setStatus] = useState<AndroidStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<AndroidStatus>): Promise<void> => {
    setBusy(true); setError(null);
    try { setStatus(await action()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    const unsubscribe = window.omo.onAndroidStatus((value) => { if (active) setStatus(value); });
    void window.omo.getAndroidStatus().then((value) => { if (active) setStatus(value); }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return <section className={css.section} data-testid="settings-android" aria-busy={busy}>
    <SectionHeading title="Android" intro={t("shell.settings.android.intro")} />
    <div className={css.card}><div className={css.cardBody}>
      <p>{t("shell.settings.android.setup")}</p>
      <Button variant="outline" disabled={busy} data-testid="android-refresh" onClick={() => void run(() => window.omo.refreshAndroid())}>{t("shell.settings.android.refresh")}</Button>
      <p role="status" data-testid="android-status">{t(`shell.settings.android.${status?.state ?? "searching"}`)}</p>
      {(error || status?.message) && <p className={css.error} role="alert">{error || status?.message}</p>}
      {status?.devices.map((device) => <div key={device.serial}>
        <p>{device.name} · <code>{device.serial}</code> · {t(`shell.settings.android.${device.state}`)}</p>
        <Button variant="outline" disabled={busy || device.state !== "ready"} data-testid="android-connect" data-serial={device.serial} onClick={() => void run(() => window.omo.connectAndroid(device.serial))}>{t("shell.settings.android.connect")}</Button>
      </div>)}
      {status?.selectedSerial && <>
        <p>{t("shell.settings.android.opened")}</p>
        <Button variant="outline" disabled={busy} data-testid="android-disconnect" onClick={() => void run(() => window.omo.disconnectAndroid())}>{t("shell.settings.android.disconnect")}</Button>
      </>}
    </div></div>
  </section>;
}
