// The right-hand bot panel: the open bot's avatar and name (editable), its computer, and its model.
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { PublicBot } from "../../../../../server/src/types.ts";
import { botColor, initial } from "../bot-colors.ts";
import { cleanName, MAX_NAME } from "./sidebar-state.ts";

export const PANEL_ID = "bot-panel";

export function BotPanel({
  bot,
  providerLabel,
  onClose,
  onRename,
  onChangeModel,
}: {
  bot: PublicBot;
  providerLabel: string;
  onClose(): void;
  /** Rejects when the gateway refuses; the field then goes back to the saved name. */
  onRename(name: string): Promise<void>;
  /** Opens Settings at Models & keys for this bot. */
  onChangeModel(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);

  // Opening the panel moves focus into it, so keyboard users land on its first control.
  useEffect(() => {
    close.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <aside
      id={PANEL_ID}
      className="bot-panel"
      aria-label={`About ${bot.name}`}
      data-bot-color={botColor(bot.avatar.color)}
      onKeyDown={onKeyDown}
    >
      <div className="panel-top">
        <button
          ref={close}
          type="button"
          className="icon-button"
          aria-label="Close panel"
          title="Close panel"
          onClick={onClose}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="panel-identity">
        <span className="avatar large" aria-hidden="true">
          {initial(bot.name)}
        </span>
        <NameField key={bot.id} saved={bot.name} onRename={onRename} />
      </div>

      <PanelSection title="Computer">
        {/* Informational until the computer view exists: not a button, so it doesn't promise an action. */}
        <div className="panel-row">
          <span className="row-text">
            <span className="row-title">Bot's computer</span>
            <span className="row-subtitle">Local folder</span>
          </span>
          <span className="computer-thumb" aria-hidden="true">
            <span className="avatar small">{initial(bot.name)}</span>
          </span>
        </div>
      </PanelSection>

      <PanelSection
        title="Model"
        action={
          <button type="button" className="panel-action" onClick={onChangeModel}>
            Change
          </button>
        }
      >
        <div className="panel-row">
          <span className="row-title">Provider</span>
          <span className="row-value">{providerLabel}</span>
        </div>
        <div className="panel-row">
          <span className="row-title">Model</span>
          <span className="row-value">{bot.model || "Default"}</span>
        </div>
      </PanelSection>
    </aside>
  );
}

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-section" aria-label={title}>
      <div className="panel-heading-row">
        <h3 className="panel-heading">{title}</h3>
        {action}
      </div>
      <div className="panel-card">{children}</div>
    </section>
  );
}

/** The bot's name, edited in place: Enter or leaving the field saves, Escape puts the saved name back. */
function NameField({ saved, onRename }: { saved: string; onRename(name: string): Promise<void> }) {
  const [value, setValue] = useState(saved);
  const field: RefObject<HTMLInputElement | null> = useRef(null);
  // Set while Escape is undoing, so the blur that follows doesn't save.
  const cancelling = useRef(false);

  useEffect(() => setValue(saved), [saved]);

  const commit = async () => {
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    const name = cleanName(value);
    if (!name || name === saved) {
      setValue(saved);
      return;
    }
    setValue(name);
    try {
      await onRename(name);
    } catch {
      // The banner says why. Put the saved name back, unless the user has typed something new since.
      setValue((current) => (current === name ? saved : current));
    }
  };

  return (
    <input
      ref={field}
      className="name-field"
      aria-label="Bot name"
      value={value}
      maxLength={MAX_NAME * 2}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          field.current?.blur(); // blur saves
        } else if (e.key === "Escape") {
          // Undo the edit only; the panel stays open.
          e.preventDefault();
          cancelling.current = true;
          setValue(saved);
          field.current?.blur();
        }
      }}
    />
  );
}
