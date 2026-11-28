// Search across bots (#23): each bot's latest message for the palette, and the messages that match a query. Pure,
// over transcripts already in memory.
import type { TranscriptEntry } from "./types.ts";

export interface SearchHit {
  botId: string;
  entryId: string;
  /** Set when the message is in a thread: opening it opens the thread. */
  threadId?: string;
  snippet: string;
  createdAt: number;
}

export interface SearchResult {
  /** Each bot's latest visible message, for the palette's Bots section. */
  previews: { botId: string; text: string }[];
  /** Messages that contain the query, newest first. Empty for a query under 2 characters. */
  messages: SearchHit[];
}

export const MAX_QUERY = 200;
const PREVIEW_CHARS = 120;
const SNIPPET_CHARS = 100;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text a person sees in a message: theirs or the bot's, not rolled back. */
function messageText(e: TranscriptEntry): string | undefined {
  if (e.hidden) return undefined;
  const b = e.body;
  return b.kind === "user_message" || b.kind === "assistant_text" ? b.text : undefined;
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** About SNIPPET_CHARS of `text` around the first hit, with … where it was cut. */
function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - Math.floor((SNIPPET_CHARS - length) / 2));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchTranscripts(
  botIds: readonly string[],
  entries: ReadonlyMap<string, readonly TranscriptEntry[]>,
  query: string,
  limit = 20,
): SearchResult {
  const previews: SearchResult["previews"] = [];
  const hits: SearchHit[] = [];
  const q = flat(query).toLowerCase();
  for (const botId of botIds) {
    const list = entries.get(botId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const text = e && messageText(e);
      if (e && text !== undefined && e.threadId === undefined) {
        previews.push({ botId, text: cut(flat(text), PREVIEW_CHARS) });
        break;
      }
    }
    if (q.length < 2) continue;
    for (const e of list) {
      const text = messageText(e);
      if (text === undefined) continue;
      const plain = flat(text);
      const at = plain.toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({
        botId,
        entryId: e.id,
        ...(e.threadId ? { threadId: e.threadId } : {}),
        snippet: snippet(plain, at, q.length),
        createdAt: e.createdAt,
      });
    }
  }
  hits.sort((a, b) => b.createdAt - a.createdAt);
  return { previews, messages: hits.slice(0, limit) };
}
