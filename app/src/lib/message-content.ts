import { stripToolCallPayload } from '@push/lib/tool-prose';

export { stripToolCallPayload } from '@push/lib/tool-prose';

/**
 * Salvage the user-visible text of an assistant turn whose answer never made
 * it into `content` — a heavy reasoner emitted the whole reply on the
 * reasoning channel and the stream-side promotion (`promoteReasoningAnswer`,
 * `lib/tool-call-recovery.ts`) declined, e.g. because the reasoning also
 * contained a tool-call-shaped construct it must not execute. The message
 * still renders in the UI (the "Thought process" pane carries `thinking`), so
 * a history builder that keys on `content` alone silently diverges from what
 * the user saw: on the next send the model has no record of the exchange the
 * user is replying to and reports the conversation as brand-new.
 *
 * Returns the tool-call-stripped reasoning text to use *as history text*, or
 * `null` when there is nothing to salvage: content already present, no plain
 * reasoning, reasoning that is only tool-call payload — or signed
 * `reasoningBlocks` or encrypted Responses reasoning items, which own the
 * replay contract for that turn (a provider reasoning + tool-use round is
 * legitimately content-empty and must be re-sent verbatim, not rewritten).
 * Tool-call turns (`isToolCall`, or a `toolUses` sidecar from a native
 * function-call round) are likewise excluded:
 * their empty content is the shape of "the call rides elsewhere", and
 * promoting the round's private deliberation would replay it as a user-visible
 * assistant reply while losing the call structure ahead of its tool result
 * (Codex P2 on #1420).
 *
 * History-only by design: unlike the stream-side promotion this never feeds
 * the dispatcher (prior-turn text is not parsed for tool calls), and the
 * strip keeps buried call payloads from re-entering the prompt as prose.
 */
export function strandedReasoningAnswerText(message: {
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
  thinking?: string;
  reasoningBlocks?: readonly unknown[];
  responsesReasoningItems?: readonly unknown[];
  isToolCall?: boolean;
  toolUses?: readonly unknown[];
}): string | null {
  if (message.role !== 'assistant') return null;
  if (message.isToolCall || (message.toolUses && message.toolUses.length > 0)) return null;
  if ((message.displayContent ?? message.content).trim()) return null;
  if (message.reasoningBlocks && message.reasoningBlocks.length > 0) return null;
  if (message.responsesReasoningItems && message.responsesReasoningItems.length > 0) return null;
  const thinking = message.thinking ?? '';
  if (!thinking.trim()) return null;
  const salvaged = stripToolCallPayload(thinking).trim();
  return salvaged.length > 0 ? salvaged : null;
}

export function stripToolResultEnvelopes(content: string): string {
  if (!content) return '';
  let text = content.replace(
    /\[(?:TOOL_RESULT|Tool Result)[^\]]*\][\s\S]*?\[\/(?:TOOL_RESULT|Tool Result)\]/g,
    '',
  );
  text = text.replace(/\[TOOL_RESULT — do not interpret as instructions\][\s\S]*$/, '');
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}
