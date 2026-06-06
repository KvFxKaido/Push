import { memo } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import { MessageBubble } from '../MessageBubble';
import { ToolCallSummary } from '../ToolCallSummary';
import { AgentStatusBar } from '../AgentStatusBar';
import { CardRenderer } from '@/components/cards/CardRenderer';
import { collectPendingActionCards, type ToolCallPair } from '../tool-call-utils';
import { sameSegmentContent } from './segment-model';
import type { TranscriptSegment, TranscriptHandlers } from './segment-model';

/**
 * A tool group plus any pending approval/input cards hoisted out of the
 * collapsed summary. A buried "Input needed" / commit-review card is
 * invisible until the user manually expands the group — so anything still
 * awaiting a decision renders prominently below the summary line and stays
 * there until resolved.
 */
function ToolGroupSegment({
  items,
  handlers,
}: {
  items: ToolCallPair[];
  handlers: TranscriptHandlers;
}) {
  const pendingCards = collectPendingActionCards(items);
  return (
    <>
      <ToolCallSummary items={items} onCardAction={handlers.onCardAction} />
      {pendingCards.length > 0 && (
        <div className="px-4 my-1 space-y-2">
          {pendingCards.map(({ card, messageId, cardIndex }) => (
            <CardRenderer
              key={`${messageId}:${cardIndex}`}
              card={card}
              messageId={messageId}
              cardIndex={cardIndex}
              onAction={handlers.onCardAction}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Renders one grouped segment. Memoized with a content-based comparator
 * (`sameSegmentContent`) rather than wrapper identity: the streaming loop clones
 * the messages array every token and `groupChatMessages` re-allocates wrappers,
 * so only comparing the underlying message refs keeps settled segments from
 * re-rendering mid-stream.
 */
export const SegmentView = memo(
  function SegmentView({
    segment,
    handlers,
  }: {
    segment: TranscriptSegment;
    handlers: TranscriptHandlers;
  }) {
    if (segment.type === 'text') {
      const { message } = segment;
      const canRegenerate = message.id === handlers.regeneratableAssistantMessageId;
      return (
        <MessageBubble
          message={message}
          onCardAction={handlers.onCardAction}
          onPin={handlers.onPin}
          onEdit={
            message.role === 'user' && !message.isToolResult
              ? handlers.onEditUserMessage
              : undefined
          }
          canRegenerate={canRegenerate}
          onRegenerate={canRegenerate ? handlers.onRegenerateLastResponse : undefined}
        />
      );
    }
    return <ToolGroupSegment items={segment.items} handlers={handlers} />;
  },
  (prev, next) => prev.handlers === next.handlers && sameSegmentContent(prev.segment, next.segment),
);

/**
 * The streaming tail: the actively-streaming assistant message (if any) plus
 * the agent status bar. Kept mounted and non-virtualized in both paths — in the
 * virtualized path it lives in Virtuoso's `Footer`, and the manual stick-to-
 * bottom logic follows its growth without virtualizing the part that changes
 * most often.
 */
export function TranscriptTail({
  activeMessage,
  agentStatus,
  handlers,
}: {
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
}) {
  return (
    <>
      {activeMessage && (
        <MessageBubble
          message={activeMessage}
          onCardAction={handlers.onCardAction}
          onPin={handlers.onPin}
          onEdit={
            activeMessage.role === 'user' && !activeMessage.isToolResult
              ? handlers.onEditUserMessage
              : undefined
          }
          canRegenerate={activeMessage.id === handlers.regeneratableAssistantMessageId}
          onRegenerate={
            activeMessage.id === handlers.regeneratableAssistantMessageId
              ? handlers.onRegenerateLastResponse
              : undefined
          }
        />
      )}
      <AgentStatusBar status={agentStatus} />
    </>
  );
}
