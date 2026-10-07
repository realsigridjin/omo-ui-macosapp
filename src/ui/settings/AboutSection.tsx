import { useState } from "react";
import { IconRightUpOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { errorMessage, useDiagnostics } from "./diagnostics";
import { SectionHeading } from "./SectionHeading";
import css from "./SettingsDialog.module.css";
import { AppUpdateSection } from "./AppUpdateSection";

const DSH_REPOSITORY_URL = "https://github.com/deepseek-ai/deepseek-harness";

export function AboutSection() {
  const t = useT();
  const diagnostics = useDiagnostics();
  const [openError, setOpenError] = useState<string | null>(null);
  const pending = diagnostics.kind === "failed" ? t("shell.settings.omo.loadFailed", { message: diagnostics.message }) : t("shell.settings.omo.loading");
  const versions = diagnostics.kind === "ready" ? diagnostics.value : null;

  const openRepository = (): void => {
    window.omo.openExternal(DSH_REPOSITORY_URL).then(
      () => setOpenError(null),
      (error: unknown) => setOpenError(errorMessage(error)),
    );
  };

  return (
    <section className={css.section}>
      <SectionHeading title={t("shell.settings.nav.about")} intro={t("shell.settings.about.intro")} />
      <AppUpdateSection />
      <div className={css.card}>
        <div className={css.cardBody}>
          <dl className={css.facts}>
            <dt>{t("shell.settings.about.appVersion")}</dt>
            <dd className={versions === null ? undefined : css.mono}>{versions?.appVersion ?? pending}</dd>
            <dt>{t("shell.settings.about.electronVersion")}</dt>
            <dd className={versions === null ? undefined : css.mono}>{versions?.electronVersion ?? pending}</dd>
          </dl>
        </div>
      </div>
      <div className={css.card}>
        <div className={css.cardBody}>
          <p className={css.credit}>{t("shell.settings.about.derived")}</p>
          <a
            className={css.link}
            href={DSH_REPOSITORY_URL}
            onClick={(event) => {
              event.preventDefault();
              openRepository();
            }}
          >
            {t("shell.settings.about.repository")}
            <IconRightUpOutlineRegular size={14} />
          </a>
        </div>
      </div>
      {openError !== null && (
        <p className={css.error} role="alert">
          {t("shell.settings.about.openFailed", { message: openError })}
        </p>
      )}
    </section>
  );
}
