import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import { SegmentView, TranscriptTail } from './segment-view';
import { segmentKey, type TranscriptSegment, type TranscriptHandlers } from './segment-model';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { AUTO_SCROLL_THRESHOLD_PX, AT_BOTTOM_THRESHOLD_PX } from './constants';

/**
 * Memoized settled-segment list. Because the grouped segment array is memoized
 * upstream (stable identity while only the streaming tail changes) and
 * `handlers` is memoized, this skips re-rendering on every streaming chunk.
 */
const SegmentList = memo(function SegmentList({
  segments,
  handlers,
}: {
  segments: TranscriptSegment[];
  handlers: TranscriptHandlers;
}) {
  return (
    <>
      {segments.map((segment, index) => (
        <SegmentView key={segmentKey(segment, index)} segment={segment} handlers={handlers} />
      ))}
    </>
  );
});

interface PlainTranscriptProps {
  segments: TranscriptSegment[];
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
  lastMessage: ChatMessage | null;
}

/**
 * The original, non-virtualized transcript path — preserved verbatim for short
 * chats. Owns its own scroll container, hand-tuned stick-to-bottom behavior, and
 * the scroll-to-bottom button.
 */
export function PlainTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: PlainTranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastMessageRef = useRef<ChatMessage | null>(null);
  const lastMessageContent = lastMessage?.content ?? '';

  const updateBottomState = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsAtBottom(distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX);
  }, []);

  // Track scroll position and show/hide scroll button
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateBottomState(container);

    const handleScroll = () => {
      updateBottomState(container);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [updateBottomState]);

  // Auto-scroll to bottom when new messages arrive or content streams in.
  // State (isAtBottom) is managed by the scroll event handler above —
  // scrollIntoView triggers scroll events that feed into updateBottomState.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previousLastMessage = lastMessageRef.current;

    // Check if this is a new message (not just content update)
    const isNewMessage =
      lastMessage && (!previousLastMessage || lastMessage.id !== previousLastMessage.id);

    // Always scroll to bottom when user sends a new message
    if (isNewMessage && lastMessage.role === 'user') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      // For assistant messages (streaming), only scroll if user is near bottom
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }

    // Update ref to track the last message
    lastMessageRef.current = lastMessage;
  }, [lastMessage, lastMessageContent]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  }, []);

  return (
    <>
      <div ref={containerRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="flex-1" />
        <div className="py-4 space-y-1.5">
          {segments.length > 0 && <SegmentList segments={segments} handlers={handlers} />}
          <TranscriptTail
            activeMessage={activeMessage}
            agentStatus={agentStatus}
            handlers={handlers}
          />
        </div>
        <div ref={bottomRef} />
      </div>

      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />
    </>
  );
}
