import { useEffect } from "react";
import { Button, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { mcpDisplayStatus } from "../../state/mcp";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { SettingsGroup } from "./SettingsCard";
import css from "./SettingsCard.module.css";
import mcpCss from "./McpSection.module.css";

export function McpSection() {
  const t = useT();
  const actions = useActions();
  const { servers, loading, error, loadedAt } = useAppSelector((state) => state.mcp);
  useEffect(() => {
    actions.setMcpSectionOpen(true);
    void actions.loadMcpServers();
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
      <SettingsGroup title={t("shell.settings.nav.mcp")} intro={t("shell.settings.mcp.intro")} />
      <div className={mcpCss.toolbar}>
        <Button variant="outline" icon={<IconRefreshOutlineRegular />} disabled={loading}
          data-testid={TESTID.mcpRefresh} onClick={() => void actions.loadMcpServers()}>
          {loading ? t("shell.settings.mcp.loading") : t("shell.settings.mcp.refresh")}
        </Button>
      </div>
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
      {loadedAt !== null && !loading && error === null && servers.length === 0 && (
        <div className={css.card} data-testid={TESTID.mcpEmpty}>
          <div className={css.cardBody}><p className={mcpCss.name}>{t("shell.settings.mcp.empty")}</p></div>
        </div>
      )}
      <p className={css.muted}>{t("shell.settings.mcp.configHint")} <code className={css.mono}>~/.omo/agent/mcp.json</code></p>
    </section>
  );
}
