import type { LlmMessage } from './provider-contract.js';
import {
  buildContextSummaryBlock as buildContextSummaryBlockGeneric,
  extractSemanticSummaryLines as extractSemanticSummaryLinesGeneric,
  type ContextSummaryBlockOptions,
  type SemanticSummaryOptions,
} from './context-summary.ts';

export interface CoderContextMessage extends LlmMessage {
  isToolResult?: boolean;
  isToolCall?: boolean;
}

/**
 * @deprecated Use `extractSemanticSummaryLines` from `./context-summary.ts`
 * directly — this module re-exports it for back-compat with the Coder
 * agent's existing call sites.
 */
export function extractSemanticSummaryLines(
  content: string,
  opts: SemanticSummaryOptions = {},
): string[] {
  return extractSemanticSummaryLinesGeneric(content, opts);
}

/**
 * @deprecated Use `buildContextSummaryBlock` from `./context-summary.ts`.
 */
export function buildContextSummaryBlock(
  messages: CoderContextMessage[],
  opts: ContextSummaryBlockOptions,
): string {
  return buildContextSummaryBlockGeneric(messages, opts);
}

/**
 * Coder-specific: after a mid-loop trim drops messages, the message
 * array can end up with two consecutive `user` roles (e.g. trimmed
 * assistant turn between a `[CONTEXT_SUMMARY]` injection and a
 * tool-result). Some providers reject that. This normalizes the
 * sequence by either merging adjacent `user` turns or inserting a
 * synthetic `[Context bridge]` assistant turn when the conflict is at
 * the head of the array. Tool-result-shaped follow-ups are dropped
 * outright since they no longer have a tool call to anchor to.
 */
export function normalizeTrimmedRoleAlternation(
  messages: CoderContextMessage[],
  round: number,
  now: () => number = Date.now,
): void {
  let bridgeCount = 0;

  for (let i = 1; i < messages.length; ) {
    const prev = messages[i - 1];
    const curr = messages[i];

    if (prev.role !== 'user' || curr.role !== 'user') {
      i++;
      continue;
    }

    if (curr.isToolResult) {
      messages.splice(i, 1);
      continue;
    }

    if (i - 1 === 0) {
      messages.splice(i, 0, {
        id: `coder-context-bridge-${round}-${bridgeCount++}`,
        role: 'assistant',
        content: '[Context bridge]\nUse the next user message as the latest guidance.',
        timestamp: now(),
      });
      i += 2;
      continue;
    }

    messages[i - 1] = {
      ...prev,
      content: `${prev.content}\n\n${curr.content}`,
    };
    messages.splice(i, 1);
  }
}
