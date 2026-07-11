/**
 * Maps persisted session messages (`state.messages`) to displayable
 * transcript rows.
 *
 * Shared by the TUI's two consumers of message history — seeding the
 * visible transcript when a session is resumed/switched, and the
 * exit-time stdout dump — so the filtering rules (skip synthetic
 * bracket-tagged user messages, strip fenced JSON tool calls from
 * assistant prose) live once.
 */

export interface TranscriptHistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

// Fenced JSON tool calls embedded in assistant prose (the text-dispatch
// protocol) are runtime plumbing, not conversation — strip them.
const TOOL_CALL_FENCE_RE = /```(?:json)?\s*\n?\{[\s\S]*?\}\s*\n?```/g;

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
    const msg = raw as { role?: unknown; content?: unknown };
    if (msg.role === 'user') {
      const text = messageText(msg.content);
      if (!text) continue;
      // Skip synthetic system-injected user messages (e.g. [SESSION_RESUMED],
      // [PROJECT_INSTRUCTIONS] blocks) — they were never typed by the user.
      if (text.startsWith('[') && text.includes(']')) continue;
      rows.push({ role: 'user', text });
    } else if (msg.role === 'assistant') {
      const cleaned = messageText(msg.content).replace(TOOL_CALL_FENCE_RE, '').trim();
      if (cleaned) rows.push({ role: 'assistant', text: cleaned });
    }
  }
  return rows;
}
