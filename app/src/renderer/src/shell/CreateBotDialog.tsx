// "Create New Bot" (reference/screens/15-new-bot.png): a name, a shape and a color, then Create.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AvatarColor, AvatarShape } from "../../../../../server/src/types.ts";
import { Avatar, AvatarPicker } from "./Avatar.tsx";
import { cleanName, MAX_NAME } from "./sidebar-state.ts";

export function CreateBotDialog({
  defaultColor,
  onCreate,
  onCancel,
}: {
  /** A color no bot uses yet, so a new bot stands apart. */
  defaultColor: AvatarColor;
  /** Rejects with the gateway's reason, which the dialog shows. */
  onCreate(input: { name: string; avatar: { shape: AvatarShape; color: AvatarColor } }): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<{ shape: AvatarShape; color: AvatarColor }>({
    shape: "circle",
    color: defaultColor,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const clean = cleanName(name);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const create = async () => {
    if (!clean || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ name: clean, avatar });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
    } else if (e.key === "Tab") {
      // Focus stays inside: Tab from the last control goes back to the first, and the other way round.
      const focusable = [
        ...(dialog.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled):not([tabindex='-1'])") ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
    }
  };

  return (
    <div className="dialog-scrim">
      <div
        ref={dialog}
        className="create-bot-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-bot-title"
        onKeyDown={onKeyDown}
      >
        <div className="create-bot-header">
          <h2 id="create-bot-title" className="create-bot-title">
            Create New Bot
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            title="Close"
            disabled={busy}
            onClick={onCancel}
          >
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="create-bot-body">
          <Avatar avatar={avatar} size="xl" />
          <input
            ref={field}
            className="create-bot-name"
            aria-label="Bot name"
            placeholder="Name your bot"
            value={name}
            maxLength={MAX_NAME * 2}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
          />
          <AvatarPicker shape={avatar.shape} color={avatar.color} onChange={setAvatar} />
          {error && (
            <p className="confirm-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="create-bot-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={!clean || busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
