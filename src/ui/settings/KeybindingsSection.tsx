import { ShortcutKeys } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { SectionHeading, SettingRow } from "./SectionHeading";
import css from "./SettingsDialog.module.css";

const DARWIN = window.omo.platform === "darwin";
const MOD = DARWIN ? "⌘" : "Ctrl";
const SHIFT = DARWIN ? "⇧" : "Shift";

/**
 * The shortcuts the app registers: the menu accelerators (electron/menu.ts), the side chat toggle
 * (btw/SideToggle.tsx) and the composer's Enter handling. They are fixed, so this page is a reference.
 */
const SHORTCUTS: readonly { id: string; label: MessageKey; keys: readonly string[] }[] = [
  { id: "new-session", label: "shell.newProject", keys: [MOD, "N"] },
  { id: "settings", label: "shell.openSettings", keys: [MOD, ","] },
  { id: "toggle-sidebar", label: "shell.toggleSidebar", keys: [MOD, "\\"] },
  { id: "side-chat", label: "btw.toggle", keys: [MOD, "E"] },
  { id: "send", label: "composer.send", keys: ["Enter"] },
  { id: "newline", label: "shell.settings.keybindings.newline", keys: [SHIFT, "Enter"] },
];

export function KeybindingsSection() {
  const t = useT();
  return (
    <section className={css.section} data-testid="settings-keybindings">
      <SectionHeading title={t("shell.settings.nav.keybindings")} intro={t("shell.settings.keybindings.intro")} />
      <div className={css.card}>
        {SHORTCUTS.map((shortcut) => (
          <SettingRow key={shortcut.id} title={t(shortcut.label)}>
            <span data-shortcut={shortcut.id}>
              <ShortcutKeys keys={shortcut.keys} className={css.keycaps} />
            </span>
          </SettingRow>
        ))}
      </div>
    </section>
  );
}
