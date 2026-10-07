import { useEffect } from "react";
import { Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { selectSidesOf, useAppStore } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { SparkIcon } from "./icons";
import css from "./SidePanel.module.css";

/** ⌘E toggles the side chat panel from anywhere in the window (the Aside browser's Ask Aside shortcut). */
export function useSidePanelShortcut(): void {
  const actions = useActions();
  const store = useAppStore();
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const modifier = window.omo.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey || event.isComposing) return;
      if (event.key.toLowerCase() !== "e") return;
      event.preventDefault();
      actions.setSidePanel(!store.getState().btw.open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, store]);
}

export function SideToggle() {
  const t = useT();
  const actions = useActions();
  const open = useAppSelector((state) => state.btw.open);
  const count = useAppSelector((state) => selectSidesOf(state, state.activeThreadId).length);
  return (
    <Tooltip label={t("btw.toggle.hint")} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.toggle}
        data-testid={TESTID.sideToggle}
        aria-pressed={open}
        onClick={() => actions.setSidePanel(!open)}
      >
        <SparkIcon />
        <span>{t("btw.toggle")}</span>
        {count > 0 && <span className={css.toggleCount}>{count}</span>}
      </button>
    </Tooltip>
  );
}
