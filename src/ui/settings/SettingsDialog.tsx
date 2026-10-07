// Full-window settings: a nav rail (search, grouped sections, Back) beside a breadcrumb header and the section page.
// Section cards and rows are ported from DSH ui-settings-general SettingsRoot.tsx (MIT, Copyright (c) 2026 DeepSeek).
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  IconApiOutlineMedium,
  IconChevronLeftOutlineRegular,
  IconCloseCircleFillRegular,
  IconCordisPluginOutlineMedium,
  IconInfoOutlineMedium,
  IconPanelLeftOutlineRegular,
  IconPersonalizationOutlineMedium,
  IconSearchOutlineRegular,
  IconSettingsOutlineMedium,
  IconSparkleMedium,
  IconUserOutlineMedium,
  Tooltip,
  useModalLayer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { IconProps } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import type { MessageKey, Translate } from "../../i18n";
import { TESTID } from "../testids";
import { uiState, useUiState } from "../ui-state";
import { AboutSection } from "./AboutSection";
import { AccountsSection } from "./AccountsSection";
import { AndroidSection } from "./AndroidSection";
import { GeneralSection } from "./GeneralSection";
import { DevicesSection } from "./DevicesSection";
import { IphoneSection } from "./IphoneSection";
import { KeybindingsSection } from "./KeybindingsSection";
import { McpSection } from "./McpSection";
import { ModelSection } from "./ModelSection";
import { OmoSection } from "./OmoSection";
import css from "./SettingsDialog.module.css";

type SectionId = "general" | "appearance" | "keybindings" | "model" | "omo" | "accounts" | "mcp" | "android" | "iphone" | "devices" | "about";

interface SectionEntry {
  id: SectionId;
  label: MessageKey;
  icon: (props: IconProps) => ReactNode;
  /** Names of the settings on the page; the nav search matches them besides the label. */
  keys: readonly MessageKey[];
  /** Untranslated product names the nav search matches. */
  terms: readonly string[];
  render: () => ReactNode;
}

interface SectionGroup {
  id: string;
  label: MessageKey | null;
  sections: readonly SectionEntry[];
}

/** Keyboard outline in the stroke style of ui/glyphs.tsx; the DSH icon set has none. */
function KeyboardGlyph({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.4 6.5h.01M6.8 6.5h.01M9.2 6.5h.01M11.6 6.5h.01M4.4 9.6h.01M11.6 9.6h.01M6.6 9.6h2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Phone outline for the device sections; the DSH icon set has none. */
function PhoneGlyph({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <rect x="4.25" y="1.5" width="7.5" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.2 12.2h1.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const IPHONE: readonly SectionEntry[] =
  window.omo.platform === "darwin"
    ? [{ id: "iphone", label: "shell.settings.nav.iphone", icon: PhoneGlyph, keys: [], terms: ["USB"], render: () => <IphoneSection /> }]
    : [];

const GROUPS: readonly SectionGroup[] = [
  {
    id: "app",
    label: null,
    sections: [
      {
        id: "general",
        label: "shell.settings.nav.general",
        icon: IconSettingsOutlineMedium,
        keys: ["shell.settings.theme", "shell.settings.language"],
        terms: [],
        render: () => <GeneralSection />,
      },
      // Theme and language live in GeneralSection; Appearance shows the same controls until that section is split.
      {
        id: "appearance",
        label: "shell.settings.nav.appearance",
        icon: IconPersonalizationOutlineMedium,
        keys: ["shell.settings.theme", "shell.settings.theme.light", "shell.settings.theme.dark"],
        terms: [],
        render: () => <GeneralSection />,
      },
      {
        id: "keybindings",
        label: "shell.settings.nav.keybindings",
        icon: KeyboardGlyph,
        keys: ["shell.toggleSidebar", "btw.toggle", "composer.send"],
        terms: [],
        render: () => <KeybindingsSection />,
      },
    ],
  },
  {
    id: "omo",
    label: "app.brand",
    sections: [
      {
        id: "model",
        label: "shell.settings.nav.model",
        icon: IconSparkleMedium,
        keys: ["composer.profile.tab", "composer.profile.daily", "composer.profile.geeky", "composer.profile.automatic"],
        terms: [],
        render: () => <ModelSection />,
      },
      {
        id: "omo",
        label: "shell.settings.nav.runtime",
        icon: IconApiOutlineMedium,
        keys: [
          "shell.settings.omo.autoUpdate",
          "shell.settings.omo.serverTitle",
          "shell.settings.omo.installTitle",
          "shell.settings.proxy.url",
          "shell.settings.proxy.key",
        ],
        terms: ["omo", "opencodex"],
        render: () => <OmoSection />,
      },
      {
        id: "accounts",
        label: "shell.settings.nav.accounts",
        icon: IconUserOutlineMedium,
        keys: ["shell.settings.accounts.signIn"],
        terms: ["opencodex", "Claude", "ChatGPT"],
        render: () => <AccountsSection />,
      },
      {
        id: "mcp",
        label: "shell.settings.nav.mcp",
        icon: IconCordisPluginOutlineMedium,
        keys: ["shell.settings.mcp.import"],
        terms: ["mcp.json"],
        render: () => <McpSection />,
      },
      {
        id: "android",
        label: "shell.settings.nav.android",
        icon: PhoneGlyph,
        keys: ["shell.settings.android.refresh"],
        terms: ["ADB", "USB"],
        render: () => <AndroidSection />,
      },
      ...IPHONE,
      {
        id: "devices",
        label: "shell.settings.nav.devices",
        icon: PhoneGlyph,
        keys: ["shell.settings.devices.memory"],
        terms: ["Windows", "Git"],
        render: () => <DevicesSection />,
      },
    ],
  },
  {
    id: "about",
    label: null,
    sections: [
      {
        id: "about",
        label: "shell.settings.nav.about",
        icon: IconInfoOutlineMedium,
        keys: ["shell.settings.about.appVersion", "shell.settings.about.electronVersion"],
        terms: [],
        render: () => <AboutSection />,
      },
    ],
  },
];

const SECTIONS = GROUPS.flatMap((group) => group.sections);

/** True when the trimmed, case-insensitive `query` is empty or occurs in the section's label, id or search words. */
function sectionMatches(entry: SectionEntry, query: string, t: Translate): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return [t(entry.label), entry.id, ...entry.keys.map((key) => t(key)), ...entry.terms].some((text) =>
    text.toLocaleLowerCase().includes(needle),
  );
}

/** Below this width the nav rail leaves the row and opens over the page from the header toggle. */
const NARROW_QUERY = "(max-width: 720px)";

function subscribeNarrow(notify: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_QUERY).matches);
}

function SettingsPanel({ section, onSelect, onClose }: { section: SectionId; onSelect(section: SectionId): void; onClose(): void }) {
  const t = useT();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const narrow = useNarrow();
  const drawerOpen = narrow && navOpen;
  useModalLayer(panel, true, onClose);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({ ...group, sections: group.sections.filter((entry) => sectionMatches(entry, query, t)) })).filter(
        (group) => group.sections.length > 0,
      ),
    [query, t],
  );
  const firstMatch = groups[0]?.sections[0];
  const current = SECTIONS.find((entry) => entry.id === section)!;
  const toggleLabel = t(navOpen ? "shell.hideSidebar" : "shell.showSidebar");

  // The drawer takes focus when it opens and hands it back to the toggle when it closes.
  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) (panel.current?.querySelector<HTMLElement>("[data-section][aria-current]") ?? search.current)?.focus();
    else if (wasDrawerOpen.current) toggle.current?.focus();
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen]);

  const select = (id: SectionId): void => {
    onSelect(id);
    setNavOpen(false);
  };

  const clearSearch = (): void => {
    setQuery("");
    search.current?.focus();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && query !== "") {
      // The modal layer skips prevented keys, so this Escape clears the search instead of closing settings.
      event.preventDefault();
      setQuery("");
    } else if (event.key === "Enter" && firstMatch !== undefined) {
      event.preventDefault();
      select(firstMatch.id);
    }
  };

  return createPortal(
    <div
      ref={panel}
      tabIndex={-1}
      className={css.panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={TESTID.settingsDialog}
      data-active-section={section}
      data-narrow={narrow || undefined}
    >
      <nav className={css.nav} aria-label={t("shell.settings.sections")} hidden={narrow && !navOpen}>
        <div className={css.dragStrip} data-window-drag />
        <div className={css.search} role="search">
          <IconSearchOutlineRegular size={14} className={css.searchIcon} />
          <input
            ref={search}
            type="text"
            className={css.searchInput}
            data-testid="settings-search"
            aria-label={t("shell.settings.search")}
            placeholder={t("shell.settings.search")}
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query !== "" && (
            <button type="button" className={css.searchClear} aria-label={t("shell.search.clear")} onClick={clearSearch}>
              <IconCloseCircleFillRegular size={14} />
            </button>
          )}
        </div>
        <div className={css.navList}>
          {groups.map((group) => (
            <div
              key={group.id}
              className={css.navGroup}
              role="group"
              aria-labelledby={group.label === null ? undefined : `${titleId}-${group.id}`}
            >
              {group.label !== null && (
                <div className={css.navGroupLabel} id={`${titleId}-${group.id}`}>
                  {t(group.label)}
                </div>
              )}
              {group.sections.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={clsx(css.navCell, entry.id === section && css.active)}
                  aria-current={entry.id === section ? "true" : undefined}
                  data-section={entry.id}
                  data-modal-autofocus={entry.id === section && !narrow ? "" : undefined}
                  onClick={() => select(entry.id)}
                >
                  <entry.icon className={css.navIcon} size={16} />
                  <span className={css.navLabel}>{t(entry.label)}</span>
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className={css.navEmpty} role="status" data-testid="settings-search-empty">
              {t("shell.settings.search.noMatch", { query: query.trim() })}
            </p>
          )}
        </div>
        <div className={css.navFoot}>
          <button type="button" className={css.back} data-testid="settings-back" onClick={onClose}>
            <IconChevronLeftOutlineRegular size={16} />
            <span className={css.navLabel}>{t("shell.settings.back")}</span>
          </button>
        </div>
      </nav>
      {drawerOpen && <div className={css.scrim} aria-hidden="true" onClick={() => setNavOpen(false)} />}
      <div className={css.content}>
        <header className={css.header} data-window-drag>
          <div className={css.headerInner}>
            {narrow && (
              <Tooltip label={toggleLabel} side="bottom" align="center" delayMs={500}>
                <button
                  ref={toggle}
                  type="button"
                  className={css.navToggle}
                  data-testid="settings-nav-toggle"
                  data-modal-autofocus=""
                  aria-label={toggleLabel}
                  aria-expanded={navOpen}
                  onClick={() => setNavOpen((open) => !open)}
                >
                  <IconPanelLeftOutlineRegular size={16} />
                </button>
              </Tooltip>
            )}
            <div className={css.breadcrumb} data-testid="settings-breadcrumb">
              <span className={css.crumbRoot} id={titleId}>
                {t("shell.settings.title")}
              </span>
              <span className={css.crumbSeparator} aria-hidden="true">
                /
              </span>
              <h2 className={css.crumbCurrent}>{t(current.label)}</h2>
            </div>
          </div>
        </header>
        <div className={css.options} key={section}>
          {current.render()}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SettingsDialog() {
  const { settingsOpen } = useUiState();
  const [section, setSection] = useState<SectionId>("general");
  if (!settingsOpen) return null;
  return <SettingsPanel section={section} onSelect={setSection} onClose={() => uiState.setSettingsOpen(false)} />;
}
