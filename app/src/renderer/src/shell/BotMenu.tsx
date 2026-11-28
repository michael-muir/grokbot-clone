// The bot tile's context menu (reference/screens/39-sidebar-ctx.png), and the confirmations it and the chat use.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import type { MenuAction } from "./sidebar-state.ts";

const ICONS: Record<MenuAction, ReactNode> = {
  "make-main": <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.5 6.5l3.8-.5z" />,
  pin: <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />,
  unpin: <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5M2.5 2.5l11 11" />,
  "start-fresh": <path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5M8 5.5v5M5.5 8h5" />,
  "copy-id": (
    <path d="M5.5 5.5V3a.5.5 0 01.5-.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5h-2.5M3 5.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z" />
  ),
  hide: <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM2.5 2.5l11 11" />,
  show: <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />,
  delete: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
};

/** Items before these get a separator, as in the reference: copy, then hide/show, sit in groups of their own. */
const STARTS_GROUP: readonly MenuAction[] = ["pin", "unpin", "start-fresh", "copy-id", "hide", "show"];

export function BotMenu({
  label,
  items,
  at,
  onAction,
  onClose,
}: {
  /** Names the menu for screen readers ("Smarty"). */
  label: string;
  items: readonly { action: MenuAction; label: string }[];
  at: { x: number; y: number };
  onAction(action: MenuAction): void;
  /**
   * Closed without choosing. `restoreFocus` for Escape and Tab; not for a click elsewhere, a blur or a resize,
   * where focus belongs to whatever the user went to.
   */
  onClose(restoreFocus: boolean): void;
}) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose(false);
    };
    const away = () => onClose(false);
    // Capture: a click that lands on another tile still closes this menu first.
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [onClose]);

  // Placed before it paints, and kept inside the window: near the bottom it moves up.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    const overflow = el.getBoundingClientRect().bottom - window.innerHeight;
    if (overflow > 0) el.style.top = `${Math.max(0, at.y - overflow)}px`;
  }, [at.x, at.y]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      buttons[(to + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(buttons.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    }
  };

  return (
    <div ref={menu} className="bot-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <div key={item.action} role="none">
          {i > 0 && STARTS_GROUP.includes(item.action) && <hr className="bot-menu-separator" />}
          <button
            type="button"
            role="menuitem"
            className="bot-menu-item"
            data-danger={item.action === "delete" || undefined}
            tabIndex={-1}
            onClick={() => onAction(item.action)}
          >
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[item.action]}
              </g>
            </svg>
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** "Delete Nova?" Cancel has focus, so Enter alone never deletes. */
export function DeleteBotDialog({
  name,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  name: string;
  busy: boolean;
  error: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <ConfirmDialog
      title={`Delete ${name}?`}
      text={`This removes ${name}'s conversation and every file on its computer. It can't be undone.`}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      danger
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/**
 * A question to confirm before something that can't be taken back. Cancel has focus, so Enter alone never confirms;
 * Escape cancels (unless the answer is on its way), and Tab stays inside.
 */
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  busyLabel,
  danger = false,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  busy: boolean;
  error: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    dialog.current?.querySelector<HTMLButtonElement>(".button.secondary")?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel(); // mid-change, the answer is on its way: closing now would hide it
    } else if (e.key === "Tab") {
      // Two buttons: Tab moves between them and never leaves the dialog.
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div className="dialog-scrim">
      <div
        ref={dialog}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} className="confirm-title">
          {title}
        </h2>
        <p id={`${id}-text`} className="confirm-text">
          {text}
        </p>
        {error && (
          <p className="confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
