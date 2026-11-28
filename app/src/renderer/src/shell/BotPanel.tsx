// The right-hand bot panel: the open bot's avatar and name (editable), its computer, and its model.
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { AvatarColor, AvatarShape, PublicBot } from "../../../../../server/src/types.ts";
import { botColor, botShape } from "../bot-colors.ts";
import { Avatar, AvatarPicker } from "./Avatar.tsx";
import { cleanName, MAX_NAME } from "./sidebar-state.ts";

export const PANEL_ID = "bot-panel";

export function BotPanel({
  bot,
  providerLabel,
  onClose,
  onRename,
  onAvatar,
  onChangeModel,
}: {
  bot: PublicBot;
  providerLabel: string;
  onClose(): void;
  /** Rejects when the gateway refuses; the field then goes back to the saved name. */
  onRename(name: string): Promise<void>;
  /** Saves a new shape or color; the banner says why if it fails. */
  onAvatar(avatar: { shape: AvatarShape; color: AvatarColor }): void;
  /** Opens Settings at Models & keys for this bot. */
  onChangeModel(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  // The latest pick: each pick builds on it, not on the saved avatar, which lags while saves are on their way.
  const [picked, setPicked] = useState<{ shape: AvatarShape; color: AvatarColor }>();
  const shown = picked ?? { shape: botShape(bot.avatar.shape), color: botColor(bot.avatar.color) };

  // Another bot: its own avatar, and the picker closed so a stray click can't restyle it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the bot changes, by design.
  useEffect(() => {
    setPicking(false);
    setPicked(undefined);
  }, [bot.id]);

  // Opening the panel moves focus into it, so keyboard users land on its first control.
  useEffect(() => {
    close.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      // The picker closes first, back onto its button; the next Escape closes the panel.
      if (picking) {
        setPicking(false);
        avatarButton.current?.focus();
      } else onClose();
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
        <button
          ref={avatarButton}
          type="button"
          className="avatar-button"
          aria-label="Change avatar"
          title="Change avatar"
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
        >
          <Avatar avatar={shown} size="large" botId={bot.id} />
        </button>
        {picking && (
          <div className="panel-picker">
            <AvatarPicker
              shape={shown.shape}
              color={shown.color}
              onChange={(avatar) => {
                setPicked(avatar);
                onAvatar(avatar);
              }}
            />
          </div>
        )}
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
            <Avatar avatar={bot.avatar} size="small" botId={bot.id} />
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
