import { useEffect, useState } from "react";
import { Button, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { mcpDisplayStatus } from "../../state/mcp";
import { selectIsTurnActive } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { SectionHeading } from "./SectionHeading";
import css from "./SettingsDialog.module.css";
import mcpCss from "./McpSection.module.css";

export function McpSection() {
  const t = useT();
  const actions = useActions();
  const { servers, loading, error, loadedAt } = useAppSelector((state) => state.mcp);
  const turnActive = useAppSelector((state) => Object.keys(state.threads).some((id) => selectIsTurnActive(state, id)));
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [configured, setConfigured] = useState<Array<{ name: string; enabled: boolean; type: string }>>([]);
  const loadConfigured = async (): Promise<void> => { setConfigured(await window.omo.readConfiguredMcpServers()); };
  const importExisting = async (): Promise<void> => {
    setImporting(true); setImportError(null); setImported(null);
    try {
      const result = await window.omo.importExistingMcpConfigs();
      if (result.sources === 0) setImportError(t("shell.settings.mcp.noSources"));
      setImported(result.imported.length);
      await loadConfigured(); await actions.loadMcpServers();
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setImporting(false); }
  };
  const importConfig = async (): Promise<void> => {
    setImporting(true); setImportError(null); setImported(null);
    try {
      const result = await window.omo.importMcpConfig();
      if (result !== null) { setImported(result.imported.length); await loadConfigured(); await actions.loadMcpServers(); }
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setImporting(false); }
  };
  useEffect(() => {
    actions.setMcpSectionOpen(true);
    void actions.loadMcpServers();
    void loadConfigured().catch((reason: unknown) => setImportError(reason instanceof Error ? reason.message : String(reason)));
    return () => actions.setMcpSectionOpen(false);
  }, [actions]);
  const statusLabel = (status: string): string => {
    switch (status) {
      case "connected": return t("shell.settings.mcp.connected");
      case "needs_auth": return t("shell.settings.mcp.needsLogin");
      case "enabled": return t("shell.settings.mcp.enabled");
      case "unsupported": return t("shell.settings.mcp.unsupported");
      default: return status;
    }
  };
  return (
    <section className={css.section} data-testid={TESTID.settingsMcp} aria-busy={loading}>
      <SectionHeading title={t("shell.settings.nav.mcp")} intro={t("shell.settings.mcp.intro")} />
      <div className={mcpCss.toolbar}>
        <Button variant="primary" disabled={importing || loading || turnActive} data-testid="mcp-import-existing" onClick={() => void importExisting()}>{t("shell.settings.mcp.importExisting")}</Button>
        <Button variant="outline" disabled={importing || loading || turnActive} data-testid="mcp-import" onClick={() => void importConfig()}>
          {t(importing ? "shell.settings.mcp.importing" : "shell.settings.mcp.import")}
        </Button>
        <Button variant="outline" icon={<IconRefreshOutlineRegular />} disabled={loading}
          data-testid={TESTID.mcpRefresh} onClick={() => void actions.loadMcpServers()}>
          {loading ? t("shell.settings.mcp.loading") : t("shell.settings.mcp.refresh")}
        </Button>
      </div>
      <p className={css.muted}>{t("shell.settings.mcp.importHint")}</p>
      {imported !== null && <p role="status" data-testid="mcp-import-status">{t("shell.settings.mcp.imported", { count: imported })}</p>}
      {importError !== null && <p className={css.error} role="alert">{importError}</p>}
      {configured.filter((entry) => !servers.some((server) => server.name === entry.name)).map((entry) => <article key={entry.name} className={css.card} data-testid="mcp-configured-server" data-server-name={entry.name}>
        <div className={css.cardBody}><h3 className={mcpCss.name}>{entry.name}</h3><p className={css.muted}>{entry.type} · {t(entry.enabled ? "shell.settings.mcp.configured" : "shell.settings.mcp.disabled")}</p></div>
      </article>)}
      {error !== null && <p className={css.error} role="alert">{t("shell.settings.mcp.error", { message: error })}</p>}
      {servers.map((server) => {
        const status = mcpDisplayStatus(server);
        return (
          <article key={server.name} className={css.card} data-testid={TESTID.mcpServer} data-server-name={server.name} data-status={status}>
            <div className={css.cardBody}>
              <div className={mcpCss.serverHeader}>
                <h3 className={mcpCss.name}>{server.name}</h3>
                <span className={mcpCss.badge}>{statusLabel(status)}</span>
              </div>
              {server.serverInfo !== null && <p className={css.muted}>{t("shell.settings.mcp.version", { version: server.serverInfo.version })}</p>}
              {status === "needs_auth" && <p className={css.muted}>{t("shell.settings.mcp.loginHint")}</p>}
              {server.tools.length === 0 ? <p className={css.muted}>{t("shell.settings.mcp.tools", { count: 0 })}</p> : (
                <details className={mcpCss.tools} data-testid={TESTID.mcpServerTools}>
                  <summary>{t("shell.settings.mcp.tools", { count: server.tools.length })}</summary>
                  <ul className={mcpCss.toolList}>
                    {server.tools.map((tool) => <li key={tool.name}>
                      <code className={css.mono}>{tool.name}</code>
                      {tool.description !== undefined && <p className={css.muted}>{tool.description}</p>}
                    </li>)}
                  </ul>
                </details>
              )}
            </div>
          </article>
        );
      })}
      {loadedAt !== null && !loading && error === null && servers.length === 0 && configured.length === 0 && (
        <div className={css.card} data-testid={TESTID.mcpEmpty}>
          <div className={css.cardBody}><p className={mcpCss.name}>{t("shell.settings.mcp.empty")}</p></div>
        </div>
      )}
      <p className={css.muted}>{t("shell.settings.mcp.configHint")} <code className={css.mono}>~/.omo/agent/mcp.json</code></p>
    </section>
  );
}
