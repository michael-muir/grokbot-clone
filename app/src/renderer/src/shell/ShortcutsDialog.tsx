// The keyboard shortcuts sheet (reference/screens/25-shortcuts.png): every shortcut the app has, by section.
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { keyLabels, platformKeys, SECTIONS, SHORTCUTS } from "./shortcuts.ts";

export function ShortcutsDialog({ isMac, onClose }: { isMac: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>(".shortcuts-close")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Only the close button takes focus: Tab stays on it.
      e.preventDefault();
    }
  };

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        onKeyDown={onKeyDown}
      >
        <div className="shortcuts-head">
          <h2 id={title} className="shortcuts-title">
            Keyboard shortcuts
          </h2>
          <button type="button" className="shortcuts-close" aria-label="Close" onClick={onClose}>
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="shortcuts-columns">
          {SECTIONS.map((section) => (
            <section key={section} className="shortcuts-section" aria-label={section}>
              <h3 className="shortcuts-section-title">{section}</h3>
              <dl className="shortcuts-list">
                {SHORTCUTS.filter((s) => s.section === section).map((s) => (
                  <div key={s.label} className="shortcuts-row">
                    <dt>
                      {s.label}
                      {s.hint && <span className="shortcuts-hint">{s.hint}</span>}
                    </dt>
                    <dd className="shortcuts-keys">
                      {platformKeys(s, isMac).map((combo, i) => (
                        <span key={combo.join("+")} className="shortcuts-combo">
                          {i > 0 && <span className="shortcuts-or">/</span>}
                          {keyLabels(combo, isMac).map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
