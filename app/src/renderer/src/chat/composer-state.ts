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

/** Enter sends; Shift+Enter is a new line; the Enter that confirms an IME composition is left to the IME. */
export function shouldSend(key: string, shift: boolean, composing: boolean): boolean {
  return key === "Enter" && !shift && !composing;
}

/** Unsent text per bot, kept while the app is open so switching bots doesn't lose it. */
const drafts = new Map<string, string>();

export const draftFor = (botId: string): string => drafts.get(botId) ?? "";

export function saveDraft(botId: string, text: string): void {
  if (text === "") drafts.delete(botId);
  else drafts.set(botId, text);
}
