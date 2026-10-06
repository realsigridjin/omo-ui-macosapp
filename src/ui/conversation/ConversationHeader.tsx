import { memo, type ReactNode } from "react";
import { IconPanelLeftOutlineRegular, StateDot, TextShimmer, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import type { ThreadSummary } from "../../state";
import { WorkspaceBadge } from "../sidebar/WorkspaceBadge";
import { TESTID } from "../testids";
import { uiState, useUiState } from "../ui-state";
import { threadTitle, workspaceName } from "./format";
import { OpenButton } from "./OpenButton";
import { CommitPushButton } from "./CommitPushButton";
import css from "./ConversationHeader.module.css";

function SidebarToggle() {
  const t = useT();
  return (
    <Tooltip label={t("shell.showSidebar")} side="bottom" align="center" delayMs={500}>
      <button
        type="button"
        className={css.sidebarToggle}
        data-testid={TESTID.headerSidebarToggle}
        aria-label={t("shell.showSidebar")}
        onClick={() => uiState.toggleSidebar()}
      >
        <IconPanelLeftOutlineRegular size={16} />
      </button>
    </Tooltip>
  );
}

/**
 * Window-drag header strip: the breadcrumb (workspace badge, workspace, thread title), the activity chip, the running
 * state, the Open split button and, at the far right, the panel toggles.
 */
export const ConversationHeader = memo(function ConversationHeader({
  active,
  thread,
  running,
  activity,
  panels,
}: {
  active: boolean;
  thread: ThreadSummary | null;
  running: boolean;
  activity?: ReactNode;
  panels?: ReactNode;
}) {
  const t = useT();
  const { sidebarVisible } = useUiState();
  const toggle = sidebarVisible ? null : <SidebarToggle />;
  if (!active) {
    return (
      <header className={css.header} data-blank="" data-testid={TESTID.conversationHeader} data-window-drag>
        {toggle}
      </header>
    );
  }
  const title = threadTitle(thread, t("conversation.header.newSession"));
  const cwd = thread?.cwd ?? "";
  return (
    <header className={css.header} data-testid={TESTID.conversationHeader} data-window-drag>
      {toggle}
      <nav className={css.breadcrumb} aria-label={t("conversation.header.breadcrumb")}>
        {cwd !== "" && (
          <>
            <WorkspaceBadge cwd={cwd} size="sm" />
            <span className={css.workspace} title={cwd}>
              {workspaceName(cwd)}
            </span>
            <span className={css.separator} aria-hidden>
              /
            </span>
          </>
        )}
        <h1 className={css.title} title={title}>
          {title}
        </h1>
      </nav>
      <div className={css.trailing}>
        {activity}
        {running && (
          <span className={css.running} role="status">
            <StateDot state="ongoing" size={12} />
            <TextShimmer active>{t("conversation.header.running")}</TextShimmer>
          </span>
        )}
        {cwd !== "" && <CommitPushButton cwd={cwd} />}
        {cwd !== "" && <OpenButton cwd={cwd} />}
        {panels}
      </div>
    </header>
  );
});
