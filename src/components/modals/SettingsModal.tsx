import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "../../ui";
import { bindingsBySection, formatCombo, IS_MAC } from "../../keymap";
import type { ShellChoice, ShellInfo } from "../../shells";

type ThemeOption = { id: string; label: string };

type SettingsSection = "appearance" | "terminal" | "power" | "keyboard" | "general";

type SettingsModalProps = {
  themes: ThemeOption[];
  uiTheme: string;
  onSetTheme: (id: string) => void;
  autoCaffeinate: boolean;
  keepAwakeActive: boolean;
  onToggleAutoCaffeinate: () => void;
  /** App-global default shell (used when a project has no default). null ⇒ bundled agsh. */
  appDefaultShell: ShellChoice | null;
  onSetAppDefaultShell: (choice: ShellChoice | null) => void;
  shells: ShellInfo[];
  shellsLoading: boolean;
  onLoadShells: () => void;
  onOpenSecureStorage: () => void;
  onOpenUpdates: () => void;
  onClose: () => void;
};

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "power", label: "Power" },
  { id: "keyboard", label: "Keyboard" },
  { id: "general", label: "Storage & updates" },
];

function shellChoiceToKey(choice: ShellChoice | null): string {
  if (!choice || choice.kind === "bundled-agsh") return "bundled-agsh";
  if (choice.kind === "bundled-nu") return "bundled-nu";
  return choice.path;
}

/**
 * Unified app settings, replacing the old gear dropdown + scattered surfaces.
 * Sections: Appearance (live-previewing theme grid), Terminal (app-global
 * default shell), Power (auto-caffeinate), Keyboard (cheat sheet from the
 * keymap table), Storage & updates (jump-offs to the dedicated dialogs).
 */
export function SettingsModal(props: SettingsModalProps) {
  const {
    themes, uiTheme, onSetTheme,
    autoCaffeinate, keepAwakeActive, onToggleAutoCaffeinate,
    appDefaultShell, onSetAppDefaultShell, shells, shellsLoading, onLoadShells,
    onOpenSecureStorage, onOpenUpdates, onClose,
  } = props;
  const [section, setSection] = useState<SettingsSection>("appearance");

  // Populate the shell select as soon as the modal opens.
  useEffect(() => {
    onLoadShells();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme preview: hovering a card applies the theme to the document
  // root; leaving the grid (or unmounting) restores the committed theme.
  useEffect(() => {
    return () => document.documentElement.setAttribute("data-theme", uiTheme);
  }, [uiTheme]);
  const previewTheme = (id: string) => document.documentElement.setAttribute("data-theme", id);
  const restoreTheme = () => document.documentElement.setAttribute("data-theme", uiTheme);

  const systemShells = useMemo(() => shells.filter((s) => s.kind === "system"), [shells]);

  const shellKey = shellChoiceToKey(appDefaultShell);
  const shellKeyMissing =
    appDefaultShell?.kind === "system" && !systemShells.some((s) => s.path === appDefaultShell.path);

  const onShellKeyChange = (key: string) => {
    if (key === "bundled-agsh") return onSetAppDefaultShell(null);
    if (key === "bundled-nu") return onSetAppDefaultShell({ kind: "bundled-nu" });
    const match = systemShells.find((s) => s.path === key);
    if (match) onSetAppDefaultShell({ kind: "system", path: match.path, family: match.family });
  };

  return (
    <Modal title="Settings" onClose={onClose} className="settingsModal">
      <div className="settingsLayout">
        <nav className="settingsNav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settingsNavItem${section === s.id ? " active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settingsContent">
          {section === "appearance" && (
            <div className="settingsSection">
              <div className="settingsSectionTitle">Theme</div>
              <div className="settingsSectionHint">Hover to preview, click to apply.</div>
              <div className="themeGrid" onMouseLeave={restoreTheme}>
                {themes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`themeCard${uiTheme === t.id ? " active" : ""}`}
                    onMouseEnter={() => previewTheme(t.id)}
                    onClick={() => onSetTheme(t.id)}
                  >
                    <span className={`topbarSettingsDot ${uiTheme === t.id ? "active" : ""}`} aria-hidden="true" />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {section === "terminal" && (
            <div className="settingsSection">
              <div className="settingsSectionTitle">Default shell</div>
              <div className="settingsSectionHint">
                Used for new terminals in projects that don't set their own default shell.
              </div>
              <select className="input" value={shellKey} onChange={(e) => onShellKeyChange(e.target.value)}>
                <optgroup label="Bundled with the app">
                  <option value="bundled-agsh">agsh (default)</option>
                  <option value="bundled-nu">Nushell</option>
                </optgroup>
                {(systemShells.length > 0 || shellKeyMissing) && (
                  <optgroup label="Installed shells">
                    {shellKeyMissing && appDefaultShell?.kind === "system" && (
                      <option value={appDefaultShell.path}>
                        {appDefaultShell.family || "Custom"} (not found) — {appDefaultShell.path}
                      </option>
                    )}
                    {systemShells.map((s) => (
                      <option key={s.path} value={s.path}>
                        {s.displayName} — {s.path}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <div className="hint">
                {shellsLoading
                  ? "Detecting installed shells…"
                  : "Projects can override this in Project settings; individual terminals via “Terminal with shell…”."}
              </div>
            </div>
          )}

          {section === "power" && (
            <div className="settingsSection">
              <div className="settingsSectionTitle">Power</div>
              <label className="checkRow">
                <input type="checkbox" checked={autoCaffeinate} onChange={onToggleAutoCaffeinate} />
                Auto-Caffeinate
              </label>
              <div className="hint">
                Keeps the Mac awake while SSH sessions are active so connections and remote processes
                survive idle periods.
                {autoCaffeinate && keepAwakeActive ? " Currently keeping the Mac awake — SSH session active." : ""}
              </div>
            </div>
          )}

          {section === "keyboard" && (
            <div className="settingsSection">
              <div className="settingsSectionTitle">Keyboard shortcuts</div>
              <div className="shortcutsGrid">
                {bindingsBySection().map((group) => (
                  <div key={group.section} className="shortcutsSection">
                    <div className="shortcutsSectionTitle">{group.section}</div>
                    {group.bindings.map((b) => (
                      <div key={b.id} className="shortcutsRow">
                        <span className="shortcutsLabel">{b.title}</span>
                        <kbd className="shortcutsKeys">{formatCombo(b, IS_MAC)}</kbd>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {section === "general" && (
            <div className="settingsSection">
              <div className="settingsSectionTitle">Storage & updates</div>
              <div className="settingsButtonRow">
                <button type="button" className="btn" onClick={onOpenSecureStorage}>
                  Secure storage settings…
                </button>
                <div className="hint">How session recordings and saved state are encrypted.</div>
              </div>
              <div className="settingsButtonRow">
                <button type="button" className="btn" onClick={onOpenUpdates}>
                  Check for updates…
                </button>
                <div className="hint">See the installed version and available updates.</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="modalActions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
