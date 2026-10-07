import { useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { selectIsTurnActive, useAppSelector } from "../../state";
import { errorMessage } from "./diagnostics";
import { SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

export function ProxySection() {
  const t = useT();
  const turnActive = useAppSelector((state) => Object.keys(state.threads).some((id) => selectIsTurnActive(state, id)));
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:10100/v1");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.omo.getProxySettings().then((value) => {
      if (!active) return;
      if (value.baseUrl) setBaseUrl(value.baseUrl);
      setConfigured(value.apiKeyConfigured);
      setCount(value.modelCount);
      setLoading(false);
    }, (reason: unknown) => { if (active) { setError(errorMessage(reason)); setLoading(false); } });
    return () => { active = false; };
  }, []);
  const apply = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const value = await window.omo.applyProxySettings({ baseUrl, ...(apiKey.trim() ? { apiKey } : {}) });
      setBaseUrl(value.baseUrl);
      setConfigured(value.apiKeyConfigured);
      setCount(value.modelCount);
      setApiKey("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  return <div className={css.card} data-testid="proxy-settings" aria-busy={loading || saving}>
    <SettingRow title="opencodex" hint={t("shell.settings.proxy.hint")}>
      <Button variant="outline" disabled={loading || saving || turnActive || !baseUrl.trim()} onClick={() => void apply()} data-testid="proxy-apply">
        {t(saving ? "shell.settings.proxy.applying" : "shell.settings.proxy.apply")}
      </Button>
    </SettingRow>
    <div className={css.cardBody}>
      <label className={css.proxyField}>{t("shell.settings.proxy.url")}
        <input className={css.proxyInput} type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={loading || saving} data-testid="proxy-url" spellCheck={false} />
      </label>
      <label className={css.proxyField}>{t("shell.settings.proxy.key")}
        <input className={css.proxyInput} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={loading || saving} autoComplete="off" data-testid="proxy-key" placeholder={t(configured ? "shell.settings.proxy.keepKey" : "shell.settings.proxy.optionalKey")} />
      </label>
      {count !== null && <p role="status" data-testid="proxy-status">{t("shell.settings.proxy.models", { count })}</p>}
      {error && <p className={css.error} role="alert">{error}</p>}
    </div>
  </div>;
}
