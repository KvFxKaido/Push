import { memo } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import { MessageBubble } from '../MessageBubble';
import { ToolCallSummary } from '../ToolCallSummary';
import { AgentStatusBar } from '../AgentStatusBar';
import type { TranscriptSegment, TranscriptHandlers } from './segment-model';

/**
 * Renders one grouped segment. Memoized so that — because the grouped segment
 * array is itself memoized upstream — settled segments don't re-render on every
 * streaming chunk.
 */
export const SegmentView = memo(function SegmentView({
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
          message.role === 'user' && !message.isToolResult ? handlers.onEditUserMessage : undefined
        }
        canRegenerate={canRegenerate}
        onRegenerate={canRegenerate ? handlers.onRegenerateLastResponse : undefined}
      />
    );
  }
  return <ToolCallSummary items={segment.items} onCardAction={handlers.onCardAction} />;
});

/**
 * The streaming tail: the actively-streaming assistant message (if any) plus
 * the agent status bar. Kept mounted and non-virtualized in both paths — in the
 * virtualized path it lives in Virtuoso's `Footer` so `followOutput` tracks its
 * growth without virtualizing the part that changes most often.
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
