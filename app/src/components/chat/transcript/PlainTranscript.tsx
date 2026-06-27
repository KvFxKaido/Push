import { memo, useRef } from 'react';
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
  /** Last user message id — anchored near the top on load and on each new turn
   *  (shadcn points 4–5, 11). Null when the chat has no user turn yet. */
  anchorMessageId: string | null;
}

/**
 * The original, non-virtualized transcript path — preserved for short chats.
 * Owns its own scroll container; the stick-to-bottom behavior, the top-anchoring
 * of the current turn, and the scroll-to-bottom button state all come from the
 * shared `useStickToBottom` hook.
 */
export function PlainTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
  anchorMessageId,
}: PlainTranscriptProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { registerScroller, isAtBottom, scrollToBottom, bottomSpacerHeight } = useStickToBottom(
    lastMessage,
    { anchorMessageId, contentRef },
  );

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
        <div ref={contentRef} className="py-4 space-y-1.5">
          {segments.length > 0 && <SegmentList segments={segments} handlers={handlers} />}
          <TranscriptTail
            activeMessage={activeMessage}
            agentStatus={agentStatus}
            handlers={handlers}
          />
        </div>
        {/*
          Spacer (sibling of the content, so it never feeds back into the turn
          measurement) that gives the anchored turn room to reach the top.
          Collapses to 0 once the answer fills the viewport — see
          `turnSpacerHeight`. `shrink-0` so it can't be squeezed away.
        */}
        <div aria-hidden className="shrink-0" style={{ height: bottomSpacerHeight }} />
      </div>

      <ScrollToBottomButton
        visible={!isAtBottom}
        streaming={lastMessage?.status === 'streaming'}
        onClick={() => scrollToBottom('smooth')}
      />
    </>
  );
}
