import { useContext, useEffect, useState } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconFolderOpenOutlineRegular,
  Menu,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { OpenTarget, OpenTargetId } from "../../../shared/ipc";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { StoreContext } from "../app-context";
import { EditorGlyph, TerminalGlyph } from "../glyphs";
import { TESTID } from "../testids";
import css from "./OpenButton.module.css";

const TARGET_KEY: Record<OpenTargetId, MessageKey> = {
  vscode: "conversation.open.vscode",
  cursor: "conversation.open.cursor",
  terminal: "conversation.open.terminal",
  finder: "conversation.open.finder",
};

const FINDER_ONLY: readonly OpenTarget[] = [{ id: "finder" }];

function targetKey(id: OpenTargetId): MessageKey {
  return id === "finder" && window.omo.platform === "win32" ? "conversation.open.explorer" : TARGET_KEY[id];
}

function targetIcon(id: OpenTargetId) {
  switch (id) {
    case "vscode":
    case "cursor":
      return <EditorGlyph size={14} />;
    case "terminal":
      return <TerminalGlyph size={14} />;
    case "finder":
      return <IconFolderOpenOutlineRegular size={14} />;
  }
}

/**
 * Split button that opens the thread's workspace: the primary part in the first installed editor (else Finder),
 * the chevron in a menu of every installed target. The target list is read once per mount from the bridge.
 */
export function OpenButton({ cwd }: { cwd: string }) {
  const t = useT();
  const store = useContext(StoreContext);
  const [targets, setTargets] = useState<readonly OpenTarget[]>(FINDER_ONLY);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let current = true;
    window.omo
      .listOpenTargets()
      .then((listed) => {
        if (current && listed.length > 0) setTargets(listed);
      })
      .catch((error: unknown) => {
        void error;
      });
    return () => {
      current = false;
    };
  }, []);

  const primary = targets.find((target) => target.id !== "terminal")?.id ?? "finder";
  const primaryLabel = t(targetKey(primary));

  const open = (target: OpenTargetId | null): void => {
    window.omo.openWorkspace(cwd, target).catch((error: unknown) => {
      store?.dispatch({
        type: "notice/pushed",
        notice: {
          id: crypto.randomUUID(),
          level: "error",
          message: t("conversation.open.failed", { message: error instanceof Error ? error.message : String(error) }),
          threadId: null,
        },
      });
    });
  };

  const items: MenuEntry[] = targets.map((target) => ({ id: target.id, label: t(targetKey(target.id)), icon: targetIcon(target.id) }));

  return (
    <div className={clsx(css.split, menuOpen && css.splitOpen)} data-testid={TESTID.openWorkspace} data-primary={primary}>
      <Tooltip label={t("conversation.open.tooltip", { target: primaryLabel, path: cwd })} side="bottom" align="end" delayMs={500}>
        <button type="button" className={css.primary} aria-label={t("conversation.open.aria", { target: primaryLabel })} onClick={() => open(null)}>
          <span className={css.icon}>{targetIcon(primary)}</span>
          <span className={css.label}>{t("conversation.open.label")}</span>
        </button>
      </Tooltip>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        onSelect={(id) => {
          setMenuOpen(false);
          const target = targets.find((entry) => entry.id === id);
          if (target !== undefined) open(target.id);
        }}
        portal
        anchor={
          <button
            type="button"
            className={css.chevron}
            data-testid={TESTID.openWorkspaceMenu}
            aria-label={t("conversation.open.more")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <IconChevronDownOutlineRegular size={12} />
          </button>
        }
      />
    </div>
  );
}
