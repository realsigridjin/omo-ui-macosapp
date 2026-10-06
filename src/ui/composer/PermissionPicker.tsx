import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconChevronDownOutlineRegular, IconEditOutlineRegular, MenuSurface } from "@deepseek-ai/dsh-client-ui-primitives";
import { PERMISSION_PRESETS } from "../../../shared/ipc";
import type { PermissionPreset } from "../../../shared/ipc";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { StoreContext, useAppSelector } from "../app-context";import { TESTID } from "../testids";
import { selectActiveCwd } from "../../state";
import css from "./PermissionPicker.module.css";

const MENU_GAP = 8;
const VIEWPORT_MARGIN = 12;
const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

const LABEL_KEY: Record<PermissionPreset, MessageKey> = {
  "full-access": "composer.fullAccess.label",
  workspace: "composer.permission.workspace",
  ask: "composer.permission.ask",
};

const TOOLTIP_KEY: Record<PermissionPreset, MessageKey> = {
  "full-access": "composer.fullAccess.tooltip",
  workspace: "composer.permission.workspace.tooltip",
  ask: "composer.permission.ask.tooltip",
};

/**
 * Permission-mode picker for the active thread's workspace: choosing a mode writes omo's
 * `permissionPreset` to the workspace project settings file `<cwd>/.omo/settings.json` through the
 * main process (see docs/permissions.md for the probe behind it); omo applies it to every following
 * turn of that workspace. Hidden while no thread is open.
 */
export function PermissionPicker({ disabled }: { disabled: boolean }) {
  const t = useT();
  const store = useContext(StoreContext);
  const cwd = useAppSelector(selectActiveCwd);
  const [preset, setPreset] = useState<PermissionPreset>("full-access");
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (cwd === null) return;
    let current = true;
    window.omo
      .getPermissionPreset(cwd)
      .then((value) => {
        if (current) setPreset(value);
      })
      .catch((error: unknown) => console.warn("could not read the permission preset", error));
    return () => {
      current = false;
    };
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: globalThis.MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const width = menuRef.current?.offsetWidth ?? 0;
      const height = menuRef.current?.offsetHeight ?? 0;
      let x = rect.left;
      let y = rect.top - MENU_GAP - height;
      if (width > 0) x = Math.min(Math.max(x, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN);
      if (height > 0) y = Math.min(Math.max(y, VIEWPORT_MARGIN), window.innerHeight - height - VIEWPORT_MARGIN);
      setMenuPos({ left: x, top: y });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  if (cwd === null) return null;

  const choose = (next: PermissionPreset): void => {
    setPreset(next);
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
    window.omo.setPermissionPreset(cwd, next).catch((error: unknown) => {
      store?.dispatch({
        type: "notice/pushed",
        notice: {
          id: crypto.randomUUID(),
          level: "error",
          message: t("composer.permission.failed", { message: error instanceof Error ? error.message : String(error) }),
          threadId: null,
        },
      });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        data-testid={TESTID.fullAccessChip}
        data-preset={preset}
        aria-label={t("composer.permission.aria", { mode: t(LABEL_KEY[preset]) })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t(TOOLTIP_KEY[preset])}
        disabled={disabled}
        onClick={() => {
          if (open) triggerRef.current?.focus();
          setOpen(!open);
        }}
      >
        <IconEditOutlineRegular size={14} className={css.triggerIcon} />
        <span className={css.triggerLabel}>{t(LABEL_KEY[preset])}</span>
        <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} size={12} />
      </button>

      {open &&
        createPortal(
          <MenuSurface
            ref={menuRef}
            className={css.menu}
            style={menuPos ?? MEASURE_STYLE}
            role="menu"
            aria-label={t("composer.permission.label")}
          >
            {PERMISSION_PRESETS.map((entry) => {
              const selected = entry === preset;
              return (
                <button
                  key={entry}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={TESTID.permissionOption}
                  data-preset={entry}
                  className={clsx(css.option, selected && css.optionSelected)}
                  title={t(TOOLTIP_KEY[entry])}
                  onClick={() => choose(entry)}
                >
                  <span className={css.optionCopy}>
                    <span className={css.optionLabel}>{t(LABEL_KEY[entry])}</span>
                    <span className={css.optionHint}>{t(TOOLTIP_KEY[entry])}</span>
                  </span>
                </button>
              );
            })}
          </MenuSurface>,
          document.body,
        )}
    </div>
  );
}
