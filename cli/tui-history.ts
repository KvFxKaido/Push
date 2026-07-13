/**
 * Maps persisted session messages (`state.messages`) to displayable
 * transcript rows.
 *
 * Shared by the TUI's two consumers of message history — seeding the
 * visible transcript when a session is resumed/switched, and the
 * exit-time stdout dump — so the filtering rules (skip paired internal
 * envelopes injected as user messages, strip fenced tool-call JSON from
 * assistant prose) live once.
 */
import { isInternalEnvelope } from './message-envelopes.ts';
import { parseJsonToolCalls } from './tui-framers.js';

export interface TranscriptHistoryRow {
  role: 'user' | 'assistant';
  text: string;
  timestampMs?: number;
}

// Candidate fences that may hold a text-dispatch tool call. Whether one is
// actually stripped is decided by `parseJsonToolCalls` — the same check the
// live renderer uses — so ordinary JSON examples in assistant prose survive.
const JSON_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;

// Strip only fences whose body parses as a tool call (object or array with a
// `tool` key); everything else is legitimate content and stays.
function stripToolCallFences(text: string): string {
  return text.replace(JSON_FENCE_RE, (fence, body: string) =>
    parseJsonToolCalls(body.trim()) ? '' : fence,
  );
}

/**
 * Extract display text from a message's `content`. Strings pass through;
 * structured content-part arrays (native-FC providers) contribute their
 * text parts; anything else (tool-call-only turns, unknown shapes) yields
 * '' and the message is skipped.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function sessionMessagesToTranscriptRows(
  messages: readonly unknown[],
): TranscriptHistoryRow[] {
  const rows: TranscriptHistoryRow[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as { role?: unknown; content?: unknown; timestamp?: unknown };
    const timestampMs = typeof msg.timestamp === 'number' ? msg.timestamp : undefined;
    if (msg.role === 'user') {
      const text = messageText(msg.content);
      if (!text) continue;
      // Skip runtime-injected user turns — paired internal envelopes like
      // [TOOL_RESULT]…[/TOOL_RESULT], [CONTEXT DIGEST]…, [PROJECT_INSTRUCTIONS
      // source="…"]… — they were never typed by the user. Paired-tag matching
      // (not a blanket leading-bracket check) keeps real prompts like
      // "[WIP] refactor auth" or "[ ] fix tests" visible.
      if (isInternalEnvelope(text.trim())) continue;
      rows.push({ role: 'user', text, ...(timestampMs === undefined ? {} : { timestampMs }) });
    } else if (msg.role === 'assistant') {
      const cleaned = stripToolCallFences(messageText(msg.content)).trim();
      if (cleaned) {
        rows.push({
          role: 'assistant',
          text: cleaned,
          ...(timestampMs === undefined ? {} : { timestampMs }),
        });
      }
    }
  }
  return rows;
}
