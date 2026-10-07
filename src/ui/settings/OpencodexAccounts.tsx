import { useEffect, useState } from "react";
import type { OpencodexAccounts as Snapshot } from "../../../shared/opencodex";
import { useT } from "../../i18n";
import css from "./SettingsDialog.module.css";

export function OpencodexAccounts({ refresh }: { refresh: boolean }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    void window.omo.readOpencodexAccounts().then((value) => { if (active) setSnapshot(value); }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [refresh]);
  return <article className={css.card} data-testid="opencodex-accounts" aria-busy={snapshot === null && error === null}>
    <div className={css.cardBody}>
      <h3>opencodex</h3>
      <p className={css.muted}>{t("shell.settings.accounts.opencodexHint")}</p>
      {snapshot?.baseUrl && <p className={css.mono}>{snapshot.baseUrl}</p>}
      {(error || snapshot?.error) && <p className={css.error} role="alert">{error || snapshot?.error}</p>}
      {snapshot?.accounts.map((account) => <dl className={css.facts} key={`${account.provider}:${account.id}`} data-testid="opencodex-account">
        <dt>{account.provider}</dt><dd>{account.name}{account.email && account.email !== account.name ? ` · ${account.email}` : ""}</dd>
        <dt>{t("shell.settings.accounts.opencodexState")}</dt><dd>{t(account.needsReauth ? "shell.settings.accounts.status.blocked" : account.paused ? "shell.settings.accounts.opencodexPaused" : account.active ? "shell.settings.accounts.opencodexActive" : "shell.settings.accounts.status.available")}</dd>
      </dl>)}
      {snapshot !== null && !snapshot.error && snapshot.accounts.length === 0 && <p className={css.muted}>{t("shell.settings.accounts.empty")}</p>}
    </div>
  </article>;
}
