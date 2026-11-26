// The composer's decisions as pure functions: which button shows, whether it's enabled, and when a key sends.

export type PrimaryButton =
  | { kind: "send"; enabled: boolean; label: "Send message" }
  | { kind: "stop"; enabled: boolean; label: "Stop the reply" };

/**
 * Idle: Send, enabled once there's text and no send is in flight. Busy (a run is going): Stop, enabled until
 * the user has pressed it. The gateway refuses a second message during a run, so there's no Send while busy.
 */
export function primaryButton(s: { draft: string; busy: boolean; sending: boolean; stopping: boolean }): PrimaryButton {
  if (s.busy) return { kind: "stop", enabled: !s.stopping, label: "Stop the reply" };
  return { kind: "send", enabled: s.draft.trim() !== "" && !s.sending, label: "Send message" };
}

/**
 * Enter sends and Shift+Enter is a new line. In Ctrl+Enter mode (a setting), only Ctrl+Enter (⌘+Enter on macOS)
 * sends and Enter alone is a new line. The Enter that confirms an IME composition is always left to the IME.
 */
export function shouldSend(
  key: string,
  shift: boolean,
  composing: boolean,
  mode: { ctrlEnter: boolean; modifier: boolean } = { ctrlEnter: false, modifier: false },
): boolean {
  if (key !== "Enter" || composing) return false;
  return mode.ctrlEnter ? mode.modifier : !shift;
}

/** Unsent text per bot, kept while the app is open so switching bots doesn't lose it. */
const drafts = new Map<string, string>();

export const draftFor = (botId: string): string => drafts.get(botId) ?? "";

export function saveDraft(botId: string, text: string): void {
  if (text === "") drafts.delete(botId);
  else drafts.set(botId, text);
}
