// The Settings window: a modal with page navigation on the left. Keeps keyboard focus inside while open, closes on
// Escape or a click outside, and gives focus back to whatever opened it.
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import "./settings.css";

export type SettingsPage = "general" | "models" | "usage";

const PAGES: readonly { id: SettingsPage; label: string; icon: ReactNode }[] = [
  {
    id: "general",
    label: "General",
    icon: (
      <path
        d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    ),
  },
  {
    id: "models",
    label: "Models & keys",
    icon: (
      <path
        d="M10 2.5a3.5 3.5 0 00-3.3 4.6L2.5 11.3V13.5h2.2v-1.4h1.4v-1.4h1.4l1.3-1.3A3.5 3.5 0 1010 2.5zm1 2.3a.8.8 0 110 1.6.8.8 0 010-1.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    ),
  },
  {
    id: "usage",
    label: "Usage",
    icon: (
      <path
        d="M3 13.5V9M6.3 13.5V5M9.7 13.5V7.5M13 13.5V2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    ),
  },
];

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

export function SettingsDialog({
  page,
  onPage,
  onClose,
  children,
}: {
  page: SettingsPage;
  onPage(page: SettingsPage): void;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const title = PAGES.find((p) => p.id === page)?.label ?? "Settings";

  useEffect(() => {
    // Remember who opened it, and give focus back on close.
    opener.current = document.activeElement;
    dialog.current?.querySelector<HTMLElement>(".settings-nav-item[aria-current='page']")?.focus();
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Wrap Tab around the dialog's own controls.
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim only closes on a click outside; Escape covers keyboards.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above.
    <div
      className="settings-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={onKeyDown}
      >
        <nav className="settings-nav" aria-label="Settings pages">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className="settings-nav-item"
              aria-current={p.id === page ? "page" : undefined}
              onClick={() => onPage(p.id)}
            >
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                {p.icon}
              </svg>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <h2 id="settings-title" className="settings-title">
            {title}
          </h2>
          {children}
        </div>
      </div>
    </div>
  );
}
