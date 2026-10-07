// Ported from DSH ui-workspace rows/Rows.tsx (MIT, Copyright (c) 2026 DeepSeek).
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconTrashOutlineRegular,
  Menu,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ThreadSummary, WorkspaceGroup } from "../../state";
import { useLocale, useT } from "../../i18n";
import { threadTitle } from "../conversation/format";
import { GripGlyph } from "../glyphs";
import { useAppSelector } from "../app-context";
import { compactElapsed, useNowTick } from "../elapsed";
import { TESTID } from "../testids";
import { useUiState } from "../ui-state";
import { isRunning } from "./thread-filter";
import { formatThreadTime } from "./thread-time";
import { WorkspaceBadge } from "./WorkspaceBadge";
import css from "./Rows.module.css";

interface WorkspaceRowProps {
  group: WorkspaceGroup;
  expanded: boolean;
  hidesActiveThread: boolean;
  onToggle(): void;
  onCreate(): void;
}

export function WorkspaceRow({ group, expanded, hidesActiveThread, onToggle, onCreate }: WorkspaceRowProps) {
  const t = useT();
  const createLabel = t("shell.sidebar.newThreadIn", { name: group.label });
  const toggleLabel = t(expanded ? "shell.sidebar.collapseGroup" : "shell.sidebar.expandGroup", { name: group.label });
  return (
    <div className={clsx(css.projectRow, hidesActiveThread && css.projectHoldsActive)}>
      <button type="button" className={css.rowMain} aria-expanded={expanded} aria-label={toggleLabel} title={group.cwd} onClick={onToggle}>
        <span className={clsx(css.slot, css.chevron)}>
          <IconChevronDownOutlineRegular size={12} className={clsx(css.arrow, !expanded && css.arrowClosed)} />
        </span>
        <WorkspaceBadge cwd={group.cwd} size="sm" />
        <span className={css.projectTitle}>{group.label}</span>
        <span className={css.count} aria-label={t("shell.sidebar.threadCount", { count: group.threads.length })}>
          {group.threads.length}
        </span>
      </button>
      <span className={css.rowActions}>
        <Tooltip label={createLabel} side="bottom" align="end" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            data-testid={TESTID.workspaceCompose}
            aria-label={createLabel}
            onClick={onCreate}
          >
            <IconEditOutlineRegular size={14} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

interface RenameInputProps {
  initial: string;
  label: string;
  onCommit(name: string): void;
  onCancel(): void;
}

function RenameInput({ initial, label, onCommit, onCancel }: RenameInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const [value, setValue] = useState(initial);

  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(0, element.value.length, "backward");
    element.scrollLeft = 0;
  }, []);

  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  return (
    <input
      ref={input}
      className={css.renameInput}
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  );
}

interface ThreadRowProps {
  thread: ThreadSummary;
  active: boolean;
  nowMs: number;
  onOpen(threadId: string): void;
  onRename(threadId: string, name: string): void;
  onRequestDelete(threadId: string, title: string): void;
  onReveal(cwd: string): void;
  /** Present (with the current settled state in `settled`) only where the sidebar offers Settle/Unsettle. */
  settled?: boolean;
  onSettle?(threadId: string, settled: boolean): void;
}

/** "Working 12s" for a running thread; the seconds count from its active turn's start when this window saw it. */
function RunningPill({ threadId }: { threadId: string }) {
  const t = useT();
  const startedAt = useAppSelector((state) => {
    const conversation = state.conversations[threadId];
    if (conversation === undefined || conversation.activeTurnId === null) return null;
    return conversation.turns.find((turn) => turn.id === conversation.activeTurnId)?.startedAtMs ?? null;
  });
  const now = useNowTick(startedAt !== null);
  return (
    <span className={css.runningPill} data-testid={TESTID.threadRunning}>
      <StateDot state="ongoing" size={10} />
      <span>{startedAt === null ? t("shell.sidebar.working") : t("shell.sidebar.workingFor", { time: compactElapsed(now - startedAt) })}</span>
    </span>
  );
}

export function ThreadRow({ thread, active, nowMs, onOpen, onRename, onRequestDelete, onReveal, settled = false, onSettle }: ThreadRowProps) {
  const t = useT();
  const locale = useLocale();
  const { preferences } = useUiState();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const title = threadTitle(thread, t("shell.newSession"));
  const running = isRunning(thread);

  const rowProps = {
    "data-testid": TESTID.threadRow,
    "data-thread-id": thread.id,
    "data-title": title,
    "aria-current": active ? ("page" as const) : undefined,
  };

  if (renaming) {
    return (
      <div className={clsx(css.sessionRow, css.renaming)} {...rowProps}>
        <WorkspaceBadge cwd={thread.cwd} className={css.rowBadge} />
        <RenameInput
          initial={thread.name ?? title}
          label={t("shell.sidebar.renameLabel")}
          onCommit={(name) => {
            setRenaming(false);
            if (name !== "" && name !== title) onRename(thread.id, name);
          }}
          onCancel={() => setRenaming(false)}
        />
      </div>
    );
  }

  const items: MenuEntry[] = [
    ...(onSettle === undefined
      ? []
      : [{ id: "settle", label: settled ? t("shell.sidebar.unsettle") : t("shell.sidebar.settle") } as const]),
    { id: "rename", label: t("shell.sidebar.rename"), icon: <IconEditOutlineRegular /> },
    { id: "reveal", label: t("shell.sidebar.revealInFinder"), icon: <IconFolderOpenOutlineRegular /> },
    { type: "separator", id: "danger" },
    { id: "delete", label: t("shell.sidebar.delete"), icon: <IconTrashOutlineRegular />, danger: true },
  ];

  const select = (id: string): void => {
    setMenuOpen(false);
    switch (id) {
      case "settle":
        onSettle?.(thread.id, !settled);
        break;
      case "rename":
        setRenaming(true);
        break;
      case "reveal":
        onReveal(thread.cwd);
        break;
      case "delete":
        onRequestDelete(thread.id, title);
        break;
    }
  };

  return (
    <div className={clsx(css.sessionRow, active && css.selected, menuOpen && css.menuOpen)} {...rowProps}>
      <button type="button" className={css.rowMain} onClick={() => onOpen(thread.id)}>
        <WorkspaceBadge cwd={thread.cwd} className={css.rowBadge} />
        <span className={css.title}>{title}</span>
        {running && <RunningPill threadId={thread.id} />}
        <span className={css.time}>{formatThreadTime(thread.updatedAt, nowMs, t, preferences?.timeFormat ?? "system", locale)}</span>
      </button>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={items}
          onSelect={select}
          portal
          closeOnPointerLeave
          anchor={
            <button
              type="button"
              className={clsx(css.iconButton, css.grip)}
              data-testid={TESTID.threadMenu}
              aria-label={t("shell.sidebar.sessionActions", { name: title })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <GripGlyph />
            </button>
          }
        />
      </span>
    </div>
  );
}
