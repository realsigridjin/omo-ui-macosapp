import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { SettingsCard, SettingsGroup, SettingsRow } from "./SettingsCard";
import css from "./SettingsCard.module.css";

/** Shortcut labels read from electron/menu.ts and the window keydown handlers (SideToggle, Composer). */
const BINDINGS: ReadonlyArray<{ key: MessageKey; keys: readonly string[] }> = [
  { key: "shell.settings.keybindings.newSession", keys: ["⌘", "N"] },
  { key: "shell.settings.keybindings.settings", keys: ["⌘", ","] },
  { key: "shell.settings.keybindings.toggleSidebar", keys: ["⌘", "\\"] },
  { key: "shell.settings.keybindings.sidePanel", keys: ["⌘", "E"] },
  { key: "shell.settings.keybindings.send", keys: ["↩"] },
  { key: "shell.settings.keybindings.newline", keys: ["⇧", "↩"] },
  { key: "shell.settings.keybindings.escape", keys: ["Esc"] },
];

export function KeybindingsSection() {
  const t = useT();
  return (
    <section className={css.section}>
      <SettingsGroup title={t("shell.settings.nav.keybindings")} intro={t("shell.settings.keybindings.intro")} />
      <SettingsCard>
        {BINDINGS.map((binding) => (
          <SettingsRow
            key={binding.key}
            title={t(binding.key)}
          >
            <span className={css.kbdGroup}>
              {binding.keys.map((key, index) => (
                <kbd key={index} className={css.kbd}>
                  {key}
                </kbd>
              ))}
            </span>
          </SettingsRow>
        ))}
      </SettingsCard>
    </section>
  );
}
