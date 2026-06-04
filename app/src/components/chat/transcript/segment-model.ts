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
 * Compile-time exhaustiveness guard. If `groupChatMessages` grows a new segment
 * variant, every `switch` below that doesn't handle it stops type-checking here
 * — turning silent drift into a build error.
 */
function assertNeverSegment(segment: never): never {
  throw new Error(`Unhandled transcript segment: ${JSON.stringify(segment)}`);
}

/**
 * Stable key for a segment. The index suffix matches the original
 * (non-virtualized) keying so React reconciliation behaves identically across
 * both paths and Virtuoso's `computeItemKey`.
 */
export function segmentKey(segment: TranscriptSegment, index: number): string {
  switch (segment.type) {
    case 'text':
      return `${segment.message.id}-${index}`;
    case 'toolGroup':
      return `tool-group-${index}`;
    default:
      return assertNeverSegment(segment);
  }
}

/**
 * Content-based equality for a segment's render inputs. `groupChatMessages`
 * allocates fresh wrapper objects every call, and the streaming loop clones the
 * whole `messages` array on every token — so wrapper identity is useless for
 * memoization. Comparing the underlying message references (stable while only
 * the streaming tail mutates) is what keeps settled segments from re-rendering
 * mid-stream, in both the plain and virtualized paths. Mirrors the element-
 * identity comparator the pre-refactor `GroupedMessageList` used.
 */
export function sameSegmentContent(a: TranscriptSegment, b: TranscriptSegment): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'text':
      return b.type === 'text' && a.message === b.message;
    case 'toolGroup': {
      if (b.type !== 'toolGroup') return false;
      if (a.items.length !== b.items.length) return false;
      for (let index = 0; index < a.items.length; index++) {
        if (a.items[index].callMsg !== b.items[index].callMsg) return false;
        if (a.items[index].resultMsg !== b.items[index].resultMsg) return false;
      }
      return true;
    }
    default:
      return assertNeverSegment(a);
  }
}
