import { Modal } from "../../ui";
import { bindingsBySection, formatCombo, IS_MAC } from "../../keymap";

type ShortcutsModalProps = {
  onClose: () => void;
};

/**
 * Keyboard shortcuts cheat sheet (mod+/). Rendered straight from the keymap
 * table, so it always matches the actual bindings.
 */
export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const groups = bindingsBySection();
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={onClose}
      className="shortcutsModal"
      actions={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="shortcutsGrid">
        {groups.map((group) => (
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
      <div className="hint">
        Escape closes search, panels, and dialogs in order. Shortcuts pause while a dialog is open.
      </div>
    </Modal>
  );
}
