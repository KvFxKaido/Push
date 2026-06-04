import type { CardAction } from '@/types';
import type { groupChatMessages } from '../tool-call-utils';

/**
 * A single grouped transcript segment — either a text message bubble or a
 * collapsed tool-call group. This is the shared input contract for both the
 * plain and virtualized transcript paths; only the list container differs.
 */
export type TranscriptSegment = ReturnType<typeof groupChatMessages>[number];

/**
 * Callbacks threaded into every segment. Bundled into one object (rather than
 * loose props) so the rendering paths can compare a single memoized reference
 * and skip re-rendering settled segments while the streaming tail updates.
 */
export interface TranscriptHandlers {
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  onEditUserMessage?: (messageId: string) => void;
  regeneratableAssistantMessageId: string | null;
  onRegenerateLastResponse?: () => void;
}

/**
 * Stable key for a segment. The index suffix matches the original
 * (non-virtualized) keying so React reconciliation behaves identically across
 * both paths and Virtuoso's `computeItemKey`.
 */
export function segmentKey(segment: TranscriptSegment, index: number): string {
  return segment.type === 'text' ? `${segment.message.id}-${index}` : `tool-group-${index}`;
}
