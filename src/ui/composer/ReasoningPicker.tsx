import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular, MenuSurface } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Model, ReasoningEffort } from "../../../shared/protocol";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { resolveComposerModel, selectActiveSessionModel } from "../../state";
import { resolveEffort } from "./model-groups";
import { EFFORT_KEY } from "./effort-labels";
import css from "./ReasoningPicker.module.css";

const MENU_GAP = 8;
const VIEWPORT_MARGIN = 12;
const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

const selectModels = (state: { models: Model[] }): Model[] => state.models;

/**
 * Compact reasoning-effort picker for a specifically chosen model; a profile fixes its own effort,
 * so the picker hides while a profile is active. Selecting an effort writes the composer effort
 * that turn/start already sends.
 */
export function ReasoningPicker({ disabled }: { disabled: boolean }) {
  const t = useT();
  const actions = useActions();
  const models = useAppSelector(selectModels);
  const modelId = useAppSelector((state) => state.composer.modelId);
  const effort = useAppSelector((state) => state.composer.effort);
  const profile = useAppSelector((state) => state.composer.profile ?? null);
  const session = useAppSelector(selectActiveSessionModel);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const current = resolveComposerModel(models, modelId, session);
  const efforts = current?.supportedReasoningEfforts ?? [];
  const currentEffort = current === null && effort === null ? (session?.reasoningEffort ?? null) : resolveEffort(current, effort);
  const visible = profile === null && current !== null && efforts.length > 0;

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
      let x = rect.right - width;
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

  if (!visible) return null;

  const choose = (next: ReasoningEffort): void => {
    void actions.selectModel(current.id, next);
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
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
        data-testid={TESTID.reasoningPicker}
        data-effort={currentEffort ?? undefined}
        aria-label={currentEffort === null ? t("composer.reasoning.label") : t("composer.reasoning.aria", { effort: t(EFFORT_KEY[currentEffort]) })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentEffort === null ? t("composer.reasoning.label") : t("composer.reasoning.aria", { effort: t(EFFORT_KEY[currentEffort]) })}
        disabled={disabled}
        onClick={() => {
          if (open) triggerRef.current?.focus();
          setOpen(!open);
        }}
      >
        <span className={css.triggerLabel}>{currentEffort === null ? t("composer.reasoning.label") : t(EFFORT_KEY[currentEffort])}</span>
        <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} size={12} />
      </button>

      {open &&
        createPortal(
          <MenuSurface
            ref={menuRef}
            className={css.menu}
            style={menuPos ?? MEASURE_STYLE}
            role="menu"
            aria-label={t("composer.reasoning.label")}
          >
            {efforts.map((entry) => {
              const selected = entry.reasoningEffort === currentEffort;
              return (
                <button
                  key={entry.reasoningEffort}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={TESTID.reasoningOption}
                  data-effort={entry.reasoningEffort}
                  className={clsx(css.option, selected && css.optionSelected)}
                  title={entry.description === "" ? undefined : entry.description}
                  onClick={() => choose(entry.reasoningEffort)}
                >
                  <span className={css.optionLabel}>{t(EFFORT_KEY[entry.reasoningEffort])}</span>
                  <span className={css.check}>{selected && <IconCheckOutlineRegular size={14} />}</span>
                </button>
              );
            })}
          </MenuSurface>,
          document.body,
        )}
    </div>
  );
}
