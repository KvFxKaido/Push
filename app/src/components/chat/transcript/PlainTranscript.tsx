import { memo } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import { SegmentView, TranscriptTail } from './segment-view';
import { segmentKey, type TranscriptSegment, type TranscriptHandlers } from './segment-model';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useStickToBottom } from './use-stick-to-bottom';

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
 * The original, non-virtualized transcript path — preserved for short chats.
 * Owns its own scroll container; the stick-to-bottom behavior and the
 * scroll-to-bottom button state come from the shared `useStickToBottom` hook.
 */
export function PlainTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: PlainTranscriptProps) {
  const { registerScroller, isAtBottom, scrollToBottom } = useStickToBottom(lastMessage);

  return (
    <>
      {/*
        `overflow-anchor:auto` (the browser default, made explicit) keeps a
        scrolled-away reader's place when content above the viewport changes
        height — code blocks highlighting async, markdown expanding (shadcn point
        12). It doesn't fight stick-to-bottom: while following we force the
        bottom each frame, so anchoring only takes over once the reader has
        scrolled up, which is exactly when we want it. Virtuoso owns its own
        measurement-based restoration, so this lives on the plain path only.
      */}
      <div
        ref={registerScroller}
        className="flex-1 overflow-y-auto overscroll-contain [overflow-anchor:auto]"
      >
        <div className="flex-1" />
        <div className="py-4 space-y-1.5">
          {segments.length > 0 && <SegmentList segments={segments} handlers={handlers} />}
          <TranscriptTail
            activeMessage={activeMessage}
            agentStatus={agentStatus}
            handlers={handlers}
          />
        </div>
      </div>

      <ScrollToBottomButton
        visible={!isAtBottom}
        streaming={lastMessage?.status === 'streaming'}
        onClick={() => scrollToBottom('smooth')}
      />
    </>
  );
}
