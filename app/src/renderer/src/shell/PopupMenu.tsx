// Popups that open beside what opened them: a menu of actions (the bot menu, a message's More menu) and a row of
// reactions. One place for placing them inside the window, closing them, and moving through them by keyboard.
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MenuItem<K extends string> {
  key: K;
  label: string;
  icon: ReactNode;
  /** Drawn in the danger color (Delete). */
  danger?: boolean;
  /** A separator goes before it. */
  startsGroup?: boolean;
  /** A check item: true or false shows its state; undefined makes it a plain item. */
  checked?: boolean;
}

/**
 * Places the popup at `at` (window pixels), before it paints, and keeps it inside the window. Closes it on a click
 * elsewhere, the window losing focus, a resize, or the user scrolling (it would no longer sit by what opened it).
 * Scrolls the app makes itself, like the chat following a reply as it streams, leave it open.
 */
function usePopup(
  ref: RefObject<HTMLDivElement | null>,
  at: { x: number; y: number },
  onClose: (restoreFocus: boolean) => void,
  opener?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus();
    const outside = (e: Event) => {
      const target = e.target as Node;
      // Its own button toggles it on click; closing here first would just reopen it.
      if (opener?.current?.contains(target)) return;
      if (!ref.current?.contains(target)) onClose(false);
    };
    const away = () => onClose(false);
    // Capture: a click that lands on another control still closes this popup first.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, { capture: true, passive: true });
    document.addEventListener("touchmove", outside, { capture: true, passive: true });
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("touchmove", outside, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [ref, onClose, opener]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    const box = el.getBoundingClientRect();
    const below = box.bottom - window.innerHeight;
    if (below > 0) el.style.top = `${Math.max(0, at.y - below)}px`;
    const right = box.right - window.innerWidth;
    if (right > 0) el.style.left = `${Math.max(0, at.x - right)}px`;
  }, [ref, at.x, at.y]);
}

/** Arrow keys (along `axis`), Home and End move between items; Escape and Tab close. */
function useMenuKeys(
  ref: RefObject<HTMLDivElement | null>,
  axis: "vertical" | "horizontal",
  onClose: (r: boolean) => void,
) {
  const [prev, next] = axis === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  return (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === next) move(at + 1);
    else if (e.key === prev) move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    }
  };
}

export function PopupMenu<K extends string>({
  label,
  items,
  at,
  opener,
  onSelect,
  onClose,
}: {
  /** Names the menu for screen readers. */
  label: string;
  items: readonly MenuItem<K>[];
  at: { x: number; y: number };
  /** The button that opened it, which toggles it: a click there isn't a click elsewhere. */
  opener?: RefObject<HTMLElement | null>;
  onSelect(key: K): void;
  /**
   * Closed without choosing. `restoreFocus` for Escape and Tab; not for a click elsewhere, a blur, a scroll or a
   * resize, where focus belongs to whatever the user went to.
   */
  onClose(restoreFocus: boolean): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  usePopup(menu, at, onClose, opener);
  const onKeyDown = useMenuKeys(menu, "vertical", onClose);

  // In a portal: inside the chat, an ancestor's transform (the virtualized list) would make "fixed" mean relative
  // to it, not to the window.
  return createPortal(
    <div ref={menu} className="bot-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <div key={item.key} role="none">
          {i > 0 && item.startsGroup && <hr className="bot-menu-separator" />}
          {item.checked === undefined ? (
            <button
              type="button"
              role="menuitem"
              className="bot-menu-item"
              data-danger={item.danger || undefined}
              tabIndex={-1}
              onClick={() => onSelect(item.key)}
            >
              <ItemFace item={item} />
            </button>
          ) : (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              className="bot-menu-item"
              tabIndex={-1}
              onClick={() => onSelect(item.key)}
            >
              <ItemFace item={item} />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** An item's icon, label and, when checked, a check mark. */
function ItemFace<K extends string>({ item }: { item: MenuItem<K> }) {
  return (
    <>
      <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          {item.icon}
        </g>
      </svg>
      <span className="bot-menu-label">{item.label}</span>
      {item.checked && (
        <svg className="icon bot-menu-check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </>
  );
}

/** A row of emoji (reference/screens/37-reaction.png). Ones already chosen show as pressed; choosing one toggles it. */
export function ReactionPicker({
  choices,
  chosen,
  at,
  opener,
  onSelect,
  onClose,
}: {
  choices: readonly string[];
  chosen: readonly string[];
  at: { x: number; y: number };
  opener?: RefObject<HTMLElement | null>;
  onSelect(emoji: string): void;
  onClose(restoreFocus: boolean): void;
}) {
  const picker = useRef<HTMLDivElement>(null);
  usePopup(picker, at, onClose, opener);
  const onKeyDown = useMenuKeys(picker, "horizontal", onClose);

  return createPortal(
    <div
      ref={picker}
      className="reaction-picker"
      role="menu"
      aria-label="Add reaction"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      {choices.map((emoji) => {
        const on = chosen.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            aria-label={`React with ${emoji}`}
            className="reaction-choice"
            tabIndex={-1}
            onClick={() => onSelect(emoji)}
          >
            {emoji}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
