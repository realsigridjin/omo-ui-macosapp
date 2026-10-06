/**
 * Full-page Settings view: a nav rail (brand header, search, grouped sections, Back) on the left
 * and the active section's cards on the right under a `Settings / <section>` breadcrumb with
 * `Restore device defaults` in the top-right. Rendered over the app while `settingsOpen` is true;
 * Escape, the Back button and `uiState.setSettingsOpen(false)` close it.
 *
 * Registering an extra section: add its id to `SectionId`, an entry to `SECTIONS` (nav order,
 * group, icon, label key — the nav, search filter, breadcrumb and `data-section` attributes all
 * derive from it), and a case in `SectionBody` returning the section's component.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconCloseCircleFillRegular,
  IconDataOutlineMedium,
  IconInfoOutlineMedium,
  IconLinkOutlineMedium,
  IconListPenOutlineMedium,
  IconPersonalizationOutlineMedium,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineMedium,
  IconSkillOutlineMedium,
  IconThinkOutlineMedium,
  IconUserOutlineMedium,
  IconApiOutlineMedium,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { DEFAULT_PREFERENCES } from "../../../shared/ipc";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { useAppStore } from "../../state";
import { BrandMark } from "../glyphs";
import { APP_VERSION, isPreRelease } from "../app-version";
import { TESTID } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { AboutSection } from "./AboutSection";
import { AccountsSection } from "./AccountsSection";
import { AppearanceSection } from "./AppearanceSection";
import { GeneralSection } from "./GeneralSection";
import { IphoneSection } from "./IphoneSection";
import { KeybindingsSection } from "./KeybindingsSection";
import { McpSection } from "./McpSection";
import { ModelSection } from "./ModelSection";
import { OmoSection } from "./OmoSection";
import { SkillsSection } from "./SkillsSection";
import { errorMessage } from "./diagnostics";
import css from "./SettingsPage.module.css";

export type SectionId =
  | "general"
  | "appearance"
  | "keybindings"
  | "model"
  | "mcp"
  | "skills"
  | "accounts"
  | "iphone"
  | "omo"
  | "about";

interface SectionSpec {
  readonly id: SectionId;
  readonly group: "top" | "omo";
  readonly labelKey: MessageKey;
  readonly icon: ComponentType<{ className?: string; size?: number }>;
}

const SECTIONS: readonly SectionSpec[] = [
  { id: "general", group: "top", labelKey: "shell.settings.nav.general", icon: IconSettingsOutlineMedium },
  { id: "appearance", group: "top", labelKey: "shell.settings.nav.appearance", icon: IconPersonalizationOutlineMedium },
  { id: "keybindings", group: "top", labelKey: "shell.settings.nav.keybindings", icon: IconListPenOutlineMedium },
  { id: "model", group: "omo", labelKey: "shell.settings.nav.model", icon: IconThinkOutlineMedium },
  { id: "mcp", group: "omo", labelKey: "shell.settings.nav.mcp", icon: IconApiOutlineMedium },
  { id: "skills", group: "omo", labelKey: "shell.settings.nav.skills", icon: IconSkillOutlineMedium },
  { id: "accounts", group: "omo", labelKey: "shell.settings.nav.providers", icon: IconUserOutlineMedium },
  { id: "iphone", group: "omo", labelKey: "shell.settings.nav.connections", icon: IconLinkOutlineMedium },
  { id: "omo", group: "omo", labelKey: "shell.settings.nav.omo", icon: IconDataOutlineMedium },
  { id: "about", group: "top", labelKey: "shell.settings.nav.about", icon: IconInfoOutlineMedium },
];

function SectionBody({ id }: { id: SectionId }): ReactNode {
  switch (id) {
    case "general":
      return <GeneralSection />;
    case "appearance":
      return <AppearanceSection />;
    case "keybindings":
      return <KeybindingsSection />;
    case "model":
      return <ModelSection />;
    case "mcp":
      return <McpSection />;
    case "skills":
      return <SkillsSection />;
    case "accounts":
      return <AccountsSection />;
    case "iphone":
      return <IphoneSection />;
    case "omo":
      return <OmoSection />;
    case "about":
      return <AboutSection />;
  }
}

function NavCell({ section, active, onSelect }: {
  section: SectionSpec;
  active: boolean;
  onSelect(id: SectionId): void;
}) {
  const t = useT();
  const Icon = section.icon;
  return (
    <button
      type="button"
      className={clsx(css.navCell, active && css.active)}
      data-testid={TESTID.settingsNavItem}
      data-section={section.id}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(section.id)}
    >
      <Icon className={css.navIcon} size={16} />
      <span className={css.navLabel}>{t(section.labelKey)}</span>
    </button>
  );
}

export function SettingsPage() {
  const t = useT();
  const store = useAppStore();
  const { settingsOpen } = useUiState();
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const label = (id: SectionId): string => t(SECTIONS.find((entry) => entry.id === id)!.labelKey);

  useEffect(() => {
    if (!settingsOpen) return;
    searchRef.current?.focus();
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const appRoot = document.getElementById("root");
    if (appRoot === null) return;
    appRoot.inert = true;
    return () => {
      appRoot.inert = false;
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!event.repeat && document.activeElement === searchRef.current && query !== "") setQuery("");
        else if (!event.repeat) uiState.setSettingsOpen(false);
        return;
      }
      if (event.key !== "/") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target !== null && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [query, settingsOpen]);

  const restoreDefaults = (): void => {
    setConfirming(false);
    updatePreferences({ ...DEFAULT_PREFERENCES, modelProfile: null }).then(
      () => {
        setRestoreError(null);
        store.dispatch({ type: "composer/modelSelected", modelId: null, effort: null, profile: null });
      },
      (reason: unknown) => setRestoreError(errorMessage(reason)),
    );
  };

  if (!settingsOpen) return null;

  const needle = query.trim().toLowerCase();
  const matches = (entry: SectionSpec): boolean =>
    needle === "" || t(entry.labelKey).toLowerCase().includes(needle);
  const visibleSections = SECTIONS.filter(matches);
  const firstOmoIndex = visibleSections.findIndex((entry) => entry.group === "omo");

  return createPortal(
    <div className={css.root} data-testid={TESTID.settingsDialog} role="dialog" aria-modal="true" aria-label={t("shell.settings.title")}>
      <nav className={css.nav} aria-label={t("shell.settings.sections")} data-testid={TESTID.settingsNav}>
        <div className={css.header} data-window-drag>
          <span className={css.brand}>
            <BrandMark size={22} className={css.brandMark} />
            <span className={css.brandName}>{t("app.brand")}</span>
            {isPreRelease(APP_VERSION) && (
              <span className={css.devBadge} title={APP_VERSION}>
                {t("shell.devBadge")}
              </span>
            )}
          </span>
        </div>
        <div className={css.search} role="search">
          <IconSearchOutlineRegular size={14} className={css.searchIcon} />
          <input
            ref={searchRef}
            type="text"
            className={css.searchInput}
            data-testid={TESTID.settingsNavSearch}
            aria-label={t("shell.settings.search.label")}
            placeholder={t("shell.settings.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query === "" ? (
            <kbd className={css.searchHint}>{t("shell.settings.search.hint")}</kbd>
          ) : (
            <button
              type="button"
              className={css.searchClear}
              aria-label={t("shell.settings.search.clear")}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <IconCloseCircleFillRegular size={14} />
            </button>
          )}
        </div>
        <div className={css.navList}>
          {visibleSections.map((entry, index) => (
            <Fragment key={entry.id}>
              {entry.group === "omo" && index === firstOmoIndex && (
                <div className={css.navGroup}>{t("shell.settings.nav.omoGroup")}</div>
              )}
              <NavCell section={entry} active={entry.id === section} onSelect={setSection} />
            </Fragment>
          ))}
          {visibleSections.length === 0 && <p className={css.navEmpty}>{t("shell.settings.search.noMatch")}</p>}
        </div>
        <div className={css.navFoot}>
          <button
            type="button"
            className={css.back}
            data-testid={TESTID.settingsBack}
            onClick={() => uiState.setSettingsOpen(false)}
          >
            <IconChevronLeftOutlineRegular size={16} />
            <span>{t("shell.settings.back")}</span>
          </button>
        </div>
      </nav>
      <div className={css.content}>
        <div className={css.topbar}>
          <div className={css.breadcrumb} data-testid={TESTID.settingsBreadcrumb}>
            <span className={css.breadcrumbRoot}>{t("shell.settings.title")}</span>
            <span aria-hidden="true" className={css.breadcrumbSep}>{" / "}</span>
            <span aria-current="page">{label(section)}</span>
          </div>
          {confirming ? (
            <div className={css.restoreConfirm} role="alertdialog" aria-label={t("shell.settings.restoreConfirm")}>
              <span className={css.restoreText}>{t("shell.settings.restoreConfirm")}</span>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" data-testid={TESTID.settingsRestoreConfirm} onClick={restoreDefaults}>
                {t("shell.settings.restoreConfirmAction")}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              icon={<IconRefreshOutlineRegular />}
              data-testid={TESTID.settingsRestoreDefaults}
              title={t("shell.settings.restoreHint")}
              onClick={() => setConfirming(true)}
            >
              {t("shell.settings.restoreDefaults")}
            </Button>
          )}
        </div>
        <div className={css.options}>
          <SectionBody id={section} />
          {restoreError !== null && (
            <p className={css.restoreError} role="alert">
              {t("shell.settings.restoreFailed", { message: restoreError })}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
