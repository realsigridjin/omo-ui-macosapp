import { Fragment, useState } from "react";
import { Button, IconDownloadOutlineRegular, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { getOmoInstallCommand } from "../../../shared/ipc";
import type { Diagnostics } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { useAppSelector } from "../../state/store";
import { InstallStatus } from "../onboarding/InstallStatus";
import { useInstaller } from "../onboarding/install";
import { TESTID } from "../testids";
import { updatePreferences, useUiState } from "../ui-state";
import { errorMessage, useDiagnostics } from "./diagnostics";
import { SectionHeading, SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";
import { ProxySection } from "./ProxySection";

type RestartState = { kind: "idle" } | { kind: "running" } | { kind: "failed"; message: string };

function PathValue({ value }: { value: string }) {
  const separator = window.omo.platform === "win32" ? ";" : ":";
  const entries = value.split(separator);
  return (
    <pre className={css.pathValue}>
      {entries.map((entry, index) => (
        <Fragment key={index}>
          {entry}
          {index < entries.length - 1 && (
            <>
              {separator}<wbr />
            </>
          )}
        </Fragment>
      ))}
    </pre>
  );
}

function DiagnosticsFacts({ value }: { value: Diagnostics }) {
  const t = useT();
  const { omo } = value;
  const notFound = t("shell.settings.omo.notFound");
  return (
    <>
      <dl className={css.facts}>
        <dt>{t("shell.settings.omo.binary")}</dt>
        <dd className={omo === null ? undefined : css.mono}>{omo?.path ?? notFound}</dd>
        <dt>{t("shell.settings.omo.version")}</dt>
        <dd className={omo === null ? undefined : css.mono}>{omo?.version ?? notFound}</dd>
        <dt>{t("shell.settings.omo.source")}</dt>
        <dd>{omo === null ? notFound : t(`shell.settings.omo.source.${omo.source}`)}</dd>
        <dt>{t("shell.settings.omo.pid")}</dt>
        <dd className={value.childPid === null ? undefined : css.mono}>
          {value.childPid ?? t("shell.settings.omo.notRunning")}
        </dd>
        <dt>{t("shell.settings.omo.loginEnv")}</dt>
        <dd>{value.loginShellEnv ? t("shell.settings.omo.loginEnv.yes") : t("shell.settings.omo.loginEnv.no")}</dd>
      </dl>
      <div className={css.pathBlock}>
        <div className={css.factLabel}>{t("shell.settings.omo.path")}</div>
        {value.childPath === null ? (
          <p className={css.muted}>{t("shell.settings.omo.notRunning")}</p>
        ) : (
          <PathValue value={value.childPath} />
        )}
      </div>
    </>
  );
}

export function OmoSection() {
  const t = useT();
  const diagnostics = useDiagnostics();
  const installer = useInstaller();
  const update = useAppSelector((state) => state.bridge?.update);
  const { preferences } = useUiState();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restart, setRestart] = useState<RestartState>({ kind: "idle" });
  const installing = installer.phase.kind === "running";
  const updating = update?.state === "checking" || update?.state === "installing";
  const toggleUpdate = (): void => {
    setSaving(true);
    setSaveError(null);
    updatePreferences({ omoAutoUpdate: preferences?.omoAutoUpdate === false }).then(
      () => setSaving(false),
      (error: unknown) => { setSaving(false); setSaveError(errorMessage(error)); },
    );
  };

  const runRestart = (): void => {
    setRestart({ kind: "running" });
    window.omo.restart().then(
      () => setRestart({ kind: "idle" }),
      (error: unknown) => setRestart({ kind: "failed", message: errorMessage(error) }),
    );
  };

  return (
    <section className={css.section}>
      <SectionHeading title={t("shell.settings.nav.omo")} intro={t("shell.settings.omo.intro")} />
      <ProxySection />
      <div className={css.card}>
        <SettingRow title={t("shell.settings.omo.autoUpdate")} hint={t("shell.settings.omo.autoUpdateHint")}>
          <Button
            variant="outline"
            data-testid={TESTID.omoAutoUpdate}
            aria-label={t("shell.settings.omo.autoUpdate")}
            aria-pressed={preferences?.omoAutoUpdate !== false}
            disabled={saving || preferences === null}
            onClick={toggleUpdate}
          >
            {t(preferences?.omoAutoUpdate === false ? "shell.settings.omo.autoUpdateOff" : "shell.settings.omo.autoUpdateOn")}
          </Button>
        </SettingRow>
        {update && (
          <p className={update.state === "failed" ? css.rowError : css.cardFooter} role="status"
            data-testid={TESTID.omoUpdateStatus} data-state={update.state}>
            {update.state === "updated"
              ? t("shell.settings.omo.update.updated", { from: update.from, to: update.to })
              : update.state === "failed"
                ? t("shell.settings.omo.update.failed", { message: update.message })
                : t(`shell.settings.omo.update.${update.state}`)}
          </p>
        )}
        {saveError !== null && <p className={css.rowError} role="alert">{t("shell.settings.saveFailed", { message: saveError })}</p>}
      </div>
      <div className={css.card} data-testid={TESTID.diagnostics} aria-busy={diagnostics.kind === "loading"}>
        <div className={css.cardBody}>
          {diagnostics.kind === "loading" && <p className={css.muted}>{t("shell.settings.omo.loading")}</p>}
          {diagnostics.kind === "failed" && (
            <p className={css.error} role="alert">
              {t("shell.settings.omo.loadFailed", { message: diagnostics.message })}
            </p>
          )}
          {diagnostics.kind === "ready" && <DiagnosticsFacts value={diagnostics.value} />}
        </div>
      </div>
      <div className={css.card}>
        <SettingRow title={t("shell.settings.omo.serverTitle")} hint={t("shell.settings.omo.restartHint")}>
          <Button
            variant="outline"
            icon={<IconRefreshOutlineRegular />}
            data-testid={TESTID.restartOmo}
            disabled={restart.kind === "running" || installing || updating}
            onClick={runRestart}
          >
            {restart.kind === "running" ? t("shell.settings.omo.restarting") : t("shell.settings.omo.restart")}
          </Button>
        </SettingRow>
        {restart.kind === "failed" && (
          <p className={css.rowError} role="alert">
            {t("shell.settings.omo.restartFailed", { message: restart.message })}
          </p>
        )}
        <SettingRow title={t("shell.settings.omo.installTitle")} hint={t("shell.settings.omo.installHint")}>
          <Button
            variant="primary"
            icon={<IconDownloadOutlineRegular />}
            data-testid={TESTID.reinstallOmo}
            disabled={installing || updating}
            onClick={installer.start}
          >
            {installing ? t("shell.onboarding.installing") : t("shell.settings.omo.reinstall")}
          </Button>
        </SettingRow>
        <code className={css.commandLine}>{getOmoInstallCommand(window.omo.platform)}</code>
        {installer.phase.kind !== "idle" && (
          <div className={css.cardFooter}>
            <InstallStatus installer={installer} />
          </div>
        )}
      </div>
    </section>
  );
}
