import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseFillRegular,
  IconDataOutlineRegular,
  IconSparkleRegular,
  Input,
  MenuGroup,
  MenuSurface,
  observeStickyMenuGroups,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { Model, ReasoningEffort } from "../../../shared/protocol";
import type { ModelProfile } from "../../../shared/ipc";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { resolveComposerModel, selectActiveSessionModel } from "../../state";
import { filterGroups, groupModels, resolveEffort } from "./model-groups";
import css from "./ModelPicker.module.css";

import { ProfilePicker } from "./ProfilePicker";
import { resolveProfile } from "./model-profiles";
const MENU_GAP = 8;
const VIEWPORT_MARGIN = 12;

const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

const EFFORT_KEY: Record<ReasoningEffort, MessageKey> = {
  none: "composer.effort.none",
  minimal: "composer.effort.minimal",
  low: "composer.effort.low",
  medium: "composer.effort.medium",
  high: "composer.effort.high",
  xhigh: "composer.effort.xhigh",
  max: "composer.effort.max",
};

const selectModels = (state: { models: Model[] }): Model[] => state.models;

export function ModelPicker({ disabled }: { disabled: boolean }) {
  const t = useT();
  const actions = useActions();
  const { preferences } = useUiState();
  const models = useAppSelector(selectModels);
  const modelId = useAppSelector((state) => state.composer.modelId);
  const effort = useAppSelector((state) => state.composer.effort);
  const session = useAppSelector(selectActiveSessionModel);

  const profile = useAppSelector((state) => state.composer.profile ?? null);
  const [tab, setTab] = useState<"profile" | "specific">("profile");
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const groupsRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const groups = useMemo(() => groupModels(models), [models]);
  const showSearch = true;
  const visibleGroups = useMemo(() => filterGroups(groups, showSearch ? query : ""), [groups, query, showSearch]);
  const visibleModels = useMemo(() => visibleGroups.flatMap((group) => group.models), [visibleGroups]);
  const current = resolveComposerModel(models, modelId, session);
  const configuredModelId = editingProfile === null ? undefined : preferences?.profileModels?.[editingProfile];
  const configuredModelUnavailable = configuredModelId !== undefined && !models.some((model) => !model.hidden && model.id === configuredModelId);
  const currentEffort = current === null && effort === null ? (session?.reasoningEffort ?? null) : resolveEffort(current, effort);
  const efforts = editingProfile === null ? current?.supportedReasoningEfforts ?? [] : [];
  const activeIndex = visibleModels.length === 0 ? -1 : Math.min(highlighted, visibleModels.length - 1);

  const effortLabel = currentEffort === null ? null : t(EFFORT_KEY[currentEffort]);
  const modelLabel = profile ? `${t(profile.startsWith("daily") ? "composer.profile.daily" : "composer.profile.geeky")}${profile.endsWith("heavy") ? ` · ${t("composer.profile.heavy")}` : ""}` : current?.displayName ?? session?.model ?? t("composer.model.none");
  const triggerAria =
    current === null
      ? t("composer.model.select")
      : effortLabel === null
        ? t("composer.model.aria", { model: modelLabel })
        : t("composer.model.ariaEffort", { model: modelLabel, effort: effortLabel });

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

  const focusPending = useRef(false);
  useEffect(() => {
    if (!open || menuPos === null || !focusPending.current) return;
    focusPending.current = false;
    if (tab === "profile") menuRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.profileDot}"]`)?.focus();
    else if (showSearch) searchRef.current?.focus();
    else optionRefs.current[activeIndex]?.focus();
  }, [open, menuPos, showSearch, activeIndex, tab]);

  useEffect(() => {
    const viewport = groupsRef.current;
    if (viewport === null) return;
    return observeStickyMenuGroups(viewport);
  }, [open, visibleGroups]);

  useLayoutEffect(() => {
    if (open && activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, visibleModels]);

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
  }, [open, visibleGroups, query, efforts.length, tab]);

  const show = (): void => {
    const currentIndex = current === null ? -1 : visibleModels.findIndex((model) => model.id === current.id);
    triggerRef.current?.focus();
    setQuery("");
    setEditingProfile(null);
    setSaveError(null);
    setHighlighted(Math.max(0, currentIndex));
    focusPending.current = true;
    setOpen(true);
  };

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  const saveProfileModel = async (modelId: string | null): Promise<void> => {
    if (editingProfile === null || saving) return;
    const profileModels = { ...uiState.get().preferences?.profileModels };
    if (modelId === null) delete profileModels[editingProfile];
    else profileModels[editingProfile] = modelId;
    setSaving(true);
    try {
      await updatePreferences({ profileModels });
      setEditingProfile(null);
      setTab("profile");
      close(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const chooseModel = (model: Model): void => {
    if (editingProfile !== null) {
      void saveProfileModel(model.id);
      return;
    }
    void actions.selectModel(model.id, resolveEffort(model, effort));
    close(true);
  };

  const chooseEffort = (next: ReasoningEffort): void => {
    if (current === null) return;
    void actions.selectModel(current.id, next);
    close(true);
  };

  const moveHighlight = (offset: number): void => {
    if (visibleModels.length === 0) return;
    const next = (activeIndex + offset + visibleModels.length) % visibleModels.length;
    setHighlighted(next);
    if (!showSearch) optionRefs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      close(true);
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        show();
      }
      return;
    }
    if (tab === "profile" || (event.target instanceof HTMLElement && event.target.getAttribute("role") === "tab")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      const target = event.target;
      if (target instanceof HTMLElement && (target.dataset["effort"] !== undefined || target.dataset["profileAutomatic"] !== undefined)) return;
      event.preventDefault();
      const model = visibleModels[activeIndex];
      if (model !== undefined) chooseModel(model);
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && (rootRef.current?.contains(next) === true || menuRef.current?.contains(next) === true)) return;
    setOpen(false);
  };

  const keepRowFocus = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest("button") !== null) event.preventDefault();
  };

  optionRefs.current = [];
  let optionIndex = 0;

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown} onBlur={onBlur} onMouseDown={keepRowFocus}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        data-testid={TESTID.modelPicker}
        aria-label={triggerAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={effortLabel === null ? modelLabel : `${modelLabel} · ${effortLabel}`}
        disabled={disabled}
        onClick={() => (open ? close(true) : show())}
      >
        {profile ? <IconSparkleRegular className={css.triggerIcon} size={14} /> : <IconDataOutlineRegular className={css.triggerIcon} size={14} />}
        {profile && <span className={css.profileIndicator} data-geeky={profile.startsWith("geeky")} aria-hidden="true" />}
        <span className={css.triggerLabel}>{modelLabel}</span>
        {profile === null && effortLabel !== null && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} size={12} />
      </button>

      {open &&
        createPortal(
          <MenuSurface
            ref={menuRef}
            id={`${id}-menu`}
            className={clsx(css.menu, tab === "profile" && css.profileMenu)}
            style={menuPos ?? MEASURE_STYLE}
            role="dialog"
            aria-label={t("composer.model.label")}
          >
            <div className={css.tabs} role="tablist" aria-label={t("composer.model.label")}>
              <button type="button" role="tab" disabled={saving} aria-selected={tab === "profile"} data-testid={TESTID.profileTab} onClick={() => { setEditingProfile(null); setTab("profile"); }}>{t("composer.profile.tab")}</button>
              <button type="button" role="tab" disabled={saving} aria-selected={tab === "specific"} data-testid={TESTID.specificModelTab} onClick={() => { setEditingProfile(null); setTab("specific"); focusPending.current = true; }}>{t("composer.profile.specific")}</button>
            </div>
            {saveError !== null && <div className={css.empty} role="alert">{t("shell.settings.saveFailed", { message: saveError })}</div>}
            {tab === "profile" ? <ProfilePicker models={models} current={profile} profileModels={preferences?.profileModels} onConfigure={(next) => {
              setEditingProfile(next);
              setTab("specific");
              setQuery("");
              setHighlighted(0);
              focusPending.current = true;
              setSaveError(null);
            }} onSelect={(next) => {
              const resolved = resolveProfile(models, next, preferences?.profileModels);
              if (resolved.model) void actions.selectModel(resolved.model.id, resolved.effort, next);
            }} /> : <>
            {editingProfile !== null && <>
              <div className={css.effortHeading}>
                {t(editingProfile.startsWith("daily") ? "composer.profile.daily" : "composer.profile.geeky")} · {t(editingProfile.endsWith("heavy") ? "composer.profile.heavy" : "composer.profile.normal")}
              </div>
              <button type="button" className={css.option} data-profile-automatic={editingProfile} disabled={saving} aria-pressed={preferences?.profileModels?.[editingProfile] === undefined} onClick={() => void saveProfileModel(null)}>
                <span className={css.optionCopy}>{t("composer.profile.automatic")}</span>
                <span className={css.check}>{preferences?.profileModels?.[editingProfile] === undefined && <IconCheckOutlineRegular />}</span>
              </button>
              {configuredModelUnavailable && <div className={css.empty} role="status" data-profile-unavailable={editingProfile}>
                {configuredModelId} · {t("composer.model.searchEmpty")}
              </div>}
            </>}
            {showSearch && (
              <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== "" && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t("composer.model.search")}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeIndex < 0 ? undefined : `${id}-model-${activeIndex}`}
                  placeholder={t("composer.model.search")}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlighted(0);
                  }}
                />
                {query !== "" && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t("composer.model.searchClear")}
                    onClick={() => {
                      setQuery("");
                      setHighlighted(0);
                      searchRef.current?.focus();
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>
            )}
            <div
              ref={groupsRef}
              id={`${id}-models`}
              className={clsx(css.groups, "scrollable")}
              role="menu"
              aria-label={t("composer.model.label")}
              hidden={visibleGroups.length === 0}
            >
              {visibleGroups.map((group) => (
                <MenuGroup key={group.provider} label={group.provider}>
                  {group.models.map((model) => {
                    const index = optionIndex++;
                    const selected = editingProfile === null ? current?.id === model.id : preferences?.profileModels?.[editingProfile] === model.id;
                    return (
                      <button
                        key={model.id}
                        ref={(node) => {
                          optionRefs.current[index] = node;
                        }}
                        type="button"
                        disabled={saving}
                        role="menuitemradio"
                        aria-checked={selected}
                        id={`${id}-model-${index}`}
                        data-testid={TESTID.modelOption}
                        data-model-id={model.id}
                        tabIndex={showSearch ? -1 : 0}
                        className={clsx(css.option, index === activeIndex && css.optionActive)}
                        title={model.id}
                        onFocus={() => setHighlighted(index)}
                        onMouseMove={index === activeIndex ? undefined : () => setHighlighted(index)}
                        onClick={() => chooseModel(model)}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{model.displayName}</span>
                          {model.description !== "" && <span className={css.modelDescription}>{model.description}</span>}
                        </span>
                        <span className={css.check}>{selected && <IconCheckOutlineRegular />}</span>
                      </button>
                    );
                  })}
                </MenuGroup>
              ))}
            </div>
            {visibleGroups.length === 0 && (
              <div className={css.empty} role="status">
                {t(models.length === 0 ? "composer.model.empty" : "composer.model.searchEmpty")}
              </div>
            )}
            {efforts.length > 0 && (
              <div className={css.effortSection}>
                <div className={css.effortHeading} id={`${id}-effort`}>
                  {t("composer.model.effort")}
                </div>
                <div className={css.effortRow} role="radiogroup" aria-labelledby={`${id}-effort`}>
                  {efforts.map((entry) => (
                    <button
                      key={entry.reasoningEffort}
                      type="button"
                      role="radio"
                      aria-checked={entry.reasoningEffort === currentEffort}
                      data-effort={entry.reasoningEffort}
                      className={css.effortChip}
                      title={entry.description === "" ? undefined : entry.description}
                      onClick={() => chooseEffort(entry.reasoningEffort)}
                    >
                      {t(EFFORT_KEY[entry.reasoningEffort])}
                    </button>
                  ))}
                </div>
              </div>
            )}
            </>}
          </MenuSurface>,
          document.body,
        )}
    </div>
  );
}
