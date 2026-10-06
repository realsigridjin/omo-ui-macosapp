import { useEffect } from "react";
import { useT } from "../../i18n";
import { selectActiveCwd, selectSkillCatalog } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { SettingsCard, SettingsGroup } from "./SettingsCard";
import css from "./SettingsCard.module.css";

export function SkillsSection() {
  const t = useT();
  const actions = useActions();
  const cwd = useAppSelector(selectActiveCwd);
  const catalog = useAppSelector((state) => (cwd === null ? null : selectSkillCatalog(state, cwd)));
  useEffect(() => {
    if (cwd !== null) void actions.ensureSkills(cwd);
  }, [actions, cwd]);

  if (cwd === null) {
    return (
      <section className={css.section}>
        <SettingsGroup title={t("shell.settings.nav.skills")} intro={t("shell.settings.skills.intro")} />
        <SettingsCard>
          <div className={css.cardBody}>
            <p className={css.muted}>{t("shell.settings.skills.noWorkspace")}</p>
          </div>
        </SettingsCard>
      </section>
    );
  }

  return (
    <section className={css.section} aria-busy={catalog?.status === "loading"}>
      <SettingsGroup title={t("shell.settings.nav.skills")} intro={t("shell.settings.skills.intro")} />
      {catalog?.status === "error" && (
        <p className={css.error} role="alert">
          {t("shell.settings.skills.error", { message: catalog.errors.map((entry) => entry.message).join("; ") })}
        </p>
      )}
      {(catalog === null || catalog.status === "idle" || catalog.status === "loading") && (
        <p className={css.muted}>{t("shell.settings.skills.loading")}</p>
      )}
      {catalog?.status === "ready" && catalog.skills.length === 0 && (
        <SettingsCard>
          <div className={css.cardBody}>
            <p className={css.muted}>{t("shell.settings.skills.empty")}</p>
          </div>
        </SettingsCard>
      )}
      {catalog?.status === "ready" && catalog.skills.length > 0 && (
        <SettingsCard>
          <div className={css.cardBody}>
            {catalog.skills.map((skill) => (
              <div key={skill.name} className={css.listRow} data-testid={TESTID.settingsSkillRow}>
                <div className={css.rowText}>
                  <div className={css.rowTitle}>
                    <code className={css.mono}>{skill.name}</code>
                  </div>
                  <div className={css.rowHint}>{skill.shortDescription ?? skill.description}</div>
                </div>
                <span className={css.badge}>{t(`shell.settings.skills.scope.${skill.scope}`)}</span>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </section>
  );
}
