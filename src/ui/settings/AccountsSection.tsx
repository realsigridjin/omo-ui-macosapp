import { useCallback, useEffect, useState } from "react";
import { Button, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AccountUsage, UsageWindow } from "../../../shared/ipc";
import type { ProviderAccount } from "../../../shared/protocol";
import { useLocale, useT } from "../../i18n";
import type { AccountsSnapshot } from "../../state";
import { useActions } from "../app-context";
import { TESTID } from "../testids";
import { SectionHeading } from "./SectionHeading";
import css from "./SettingsDialog.module.css";
import accountCss from "./AccountsSection.module.css";
import { OpencodexAccounts } from "./OpencodexAccounts";

const PROVIDER_LABELS: Record<string, string> = {
  "anthropic-subscription": "Claude",
  "chatgpt-subscription": "ChatGPT",
  "kimi-coding": "Kimi",
  deepseek: "DeepSeek",
  zai: "Z.ai",
  google: "Google",
  openai: "OpenAI",
};
const SUBSCRIPTIONS = new Set(["anthropic-subscription", "chatgpt-subscription"]);

function resetText(resetsAt: string, locale: string, now: number): string {
  const seconds = Math.round((Date.parse(resetsAt) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 3_600) return format.format(Math.round(seconds / 60), "minute");
  if (Math.abs(seconds) < 86_400) return format.format(Math.round(seconds / 3_600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

function UsageBar({ window }: { window: UsageWindow }) {
  const t = useT();
  const locale = useLocale();
  const percent = window.percent === null ? null : Math.max(0, Math.min(100, window.percent));
  const level = window.limited || (percent ?? 0) >= 90 ? "high" : (percent ?? 0) >= 70 ? "mid" : "low";
  return (
    <div className={accountCss.window} data-testid={TESTID.accountUsageWindow} data-level={level}>
      <span className={accountCss.windowLabel}>{window.label}</span>
      <span className={accountCss.track} role="meter" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <span className={accountCss.fill} style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className={accountCss.windowValue}>
        {window.limited ? t("shell.settings.accounts.usage.limited") : percent === null ? "—" : `${Math.round(percent)}%`}
        {window.resetsAt !== null && (
          <span className={css.muted}> · {t("shell.settings.accounts.usage.resets", { time: resetText(window.resetsAt, locale, Date.now()) })}</span>
        )}
      </span>
    </div>
  );
}

function UsageView({ usage }: { usage: AccountUsage | undefined }) {
  const t = useT();
  if (usage === undefined) return null;
  if (usage.state === "expired") return null;
  if (usage.state === "failed") return <p className={css.muted}>{t("shell.settings.accounts.usage.failed", { message: usage.message ?? "" })}</p>;
  if (usage.windows.length === 0) return <p className={css.muted}>{t("shell.settings.accounts.usage.none")}</p>;
  return <div className={accountCss.windows}>{usage.windows.map((window) => <UsageBar key={window.label} window={window} />)}</div>;
}

interface Row {
  name: string;
  account: ProviderAccount | null;
  usage: AccountUsage | undefined;
}

function AccountRow({ provider, row, onChanged }: { provider: string; row: Row; onChanged(): void }) {
  const t = useT();
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const { account } = row;
  const expired = row.usage?.state === "expired";
  const status = account?.pinned === true ? "pinned" : account?.blocked === true ? "blocked" : expired ? "expired" : account === null ? null : "available";
  const title = account?.displayName === undefined ? row.name : `${account.displayName} (${row.name})`;
  const act = async (run: () => Promise<boolean>): Promise<void> => {
    if (await run()) onChanged();
  };
  return (
    <div className={accountCss.account} data-testid={TESTID.accountRow} data-account={row.name} data-status={status ?? "unlisted"} data-compact={expired || undefined}>
      <div className={accountCss.accountHeader}>
        <span className={accountCss.accountName}>{title}</span>
        {row.usage?.email !== null && row.usage?.email !== undefined && <span className={css.muted}>{row.usage.email}</span>}
        {row.usage?.plan !== null && row.usage?.plan !== undefined && <span className={accountCss.badge}>{row.usage.plan}</span>}
        {status !== null && (
          <span className={accountCss.badge} data-status={status} title={expired ? t("shell.settings.accounts.usage.expired") : undefined}>
            {t(`shell.settings.accounts.status.${status}`)}
          </span>
        )}
        {account !== null && (
          <span className={accountCss.accountActions}>
            {confirming ? (
              <>
                <span className={css.muted}>{t("shell.settings.accounts.confirmRemove", { name: row.name })}</span>
                <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>{t("shell.settings.accounts.cancel")}</Button>
                <Button variant="outline" size="sm" data-testid={TESTID.accountRemoveConfirm}
                  onClick={() => void act(() => actions.removeAccount(provider, row.name))}>{t("shell.settings.accounts.remove")}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" data-testid={TESTID.accountPin}
                  onClick={() => void act(() => actions.pinAccount(provider, account.pinned ? null : row.name))}>
                  {t(account.pinned ? "shell.settings.accounts.unpin" : "shell.settings.accounts.pin")}
                </Button>
                <Button variant="outline" size="sm" data-testid={TESTID.accountRemove} onClick={() => setConfirming(true)}>
                  {t("shell.settings.accounts.remove")}
                </Button>
              </>
            )}
          </span>
        )}
      </div>
      <UsageView usage={row.usage} />
    </div>
  );
}

/** Rows of one provider: omo's listed accounts first, then stored accounts omo did not list but whose usage was read. */
function rowsOf(provider: string, accounts: ProviderAccount[], usage: AccountUsage[]): Row[] {
  const own = usage.filter((entry) => entry.provider === provider);
  const rows: Row[] = accounts.map((account) => ({ name: account.name, account, usage: own.find((entry) => entry.account === account.name) }));
  for (const entry of own) if (!rows.some((row) => row.name === entry.account)) rows.push({ name: entry.account, account: null, usage: entry });
  // Accounts with readable quota first, expired ones last; the sort is stable, so each group keeps omo's order.
  const rank = (row: Row): number => (row.usage?.state === "ok" ? 0 : row.usage?.state === "expired" ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b));
}

export function AccountsSection() {
  const t = useT();
  const actions = useActions();
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loginOpened, setLoginOpened] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setSnapshot(await actions.loadAccounts());
    setLoading(false);
  }, [actions]);
  useEffect(() => {
    void load();
    // Sign-in finishes in Terminal; coming back to the app shows the new account.
    const onFocus = (): void => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);
  const providers = (snapshot?.providers ?? []).filter((entry) =>
    SUBSCRIPTIONS.has(entry.provider) || entry.accounts.length > 0 || entry.error !== null);
  return (
    <section className={css.section} data-testid={TESTID.settingsAccounts} aria-busy={loading}>
      <SectionHeading title={t("shell.settings.nav.accounts")} intro={t("shell.settings.accounts.intro")} />
      <div className={accountCss.toolbar}>
        <Button variant="outline" icon={<IconRefreshOutlineRegular />} disabled={loading} data-testid={TESTID.accountsRefresh} onClick={() => void load()}>
          {loading ? t("shell.settings.accounts.loading") : t("shell.settings.accounts.refresh")}
        </Button>
      </div>
      <OpencodexAccounts refresh={loading} />
      {snapshot?.usageError !== null && snapshot?.usageError !== undefined && (
        <p className={css.error} role="alert">{t("shell.settings.accounts.usageError", { message: snapshot.usageError })}</p>
      )}
      {providers.map(({ provider, accounts, error }) => {
        const rows = rowsOf(provider, accounts, snapshot?.usage ?? []);
        return (
          <article key={provider} className={css.card} data-testid={TESTID.accountProvider} data-provider={provider}>
            <div className={css.cardBody}>
              <div className={accountCss.providerHeader}>
                <h3 className={accountCss.providerName}>{PROVIDER_LABELS[provider] ?? provider}</h3>
                <span className={accountCss.badge}>{t("shell.settings.accounts.count", { count: rows.length })}</span>
                <Button variant="outline" size="sm" className={accountCss.signIn} data-testid={TESTID.accountSignIn}
                  onClick={() => void actions.openAccountLogin(provider).then((opened) => setLoginOpened(opened ? provider : null))}>
                  {rows.length === 0 ? t("shell.settings.accounts.signIn") : t("shell.settings.accounts.add")}
                </Button>
              </div>
              {loginOpened === provider && <p className={css.muted} data-testid={TESTID.accountLoginHint}>{t("shell.settings.accounts.loginHint")}</p>}
              {error !== null && <p className={css.error}>{error}</p>}
              {rows.length === 0 && error === null && <p className={css.muted}>{t("shell.settings.accounts.empty")}</p>}
              {rows.map((row) => <AccountRow key={row.name} provider={provider} row={row} onChanged={() => void load()} />)}
              {rows.some((row) => row.usage?.state === "expired") && <p className={css.muted}>{t("shell.settings.accounts.usage.expired")}</p>}
            </div>
          </article>
        );
      })}
      <p className={css.muted}>{t("shell.settings.accounts.storeHint")} <code className={css.mono}>~/.omo/agent/auth.json</code></p>
    </section>
  );
}
