/**
 * App-side wrapper around the shared context-summary primitive in `lib/`.
 *
 * The semantic-summary logic (header detection, list-meta tracking,
 * omission markers, file-path collection) lives in
 * `lib/context-summary.ts` and is generic over a minimal message
 * shape. Web call sites keep using these named helpers; CLI imports
 * the generic primitive directly.
 */

import type { ChatMessage } from '@/types';
import { compactMessage, type CompactMessageOptions } from '@push/lib/context-summary';

export {
  extractSemanticSummaryLines,
  extractToolName,
  buildContextSummaryBlock,
  buildContextSummaryPoints,
  compactMessage,
  type SemanticSummaryOptions,
  type CompactMessageOptions,
  type ContextSummaryBlockOptions,
  type ContextSummaryMessage,
} from '@push/lib/context-summary';

/**
 * Typed wrapper around the generic `compactMessage` for web's
 * `ChatMessage`. Preserves the previous `compactChatMessage` name so
 * existing call sites (`message-context-manager`, …) keep working.
 */
export function compactChatMessage(
  msg: ChatMessage,
  opts: CompactMessageOptions = {},
): ChatMessage {
  return compactMessage(msg, opts);
}
