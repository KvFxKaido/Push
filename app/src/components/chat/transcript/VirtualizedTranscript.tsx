import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ChatMessage, AgentStatus } from '@/types';
import { SegmentView, TranscriptTail } from './segment-view';
import { segmentKey, type TranscriptSegment, type TranscriptHandlers } from './segment-model';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { AT_BOTTOM_THRESHOLD_PX } from './constants';

/**
 * Context handed to Virtuoso's item renderer and footer. Carrying the streaming
 * tail through `context` (rather than closing over it) keeps the footer mounted
 * and lets `followOutput` track its growth without virtualizing it.
 */
interface VirtuosoContext {
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
}

// Top spacer — mirrors the `py-4` top padding of the plain path.
const Header = () => <div className="h-4" />;

// The streaming tail + status bar live in the footer so they stay mounted and
// `followOutput` keeps them pinned while the user is at the bottom.
const Footer = ({ context }: { context?: VirtuosoContext }) => {
  if (!context) return null;
  return (
    <div className="pb-4">
      <TranscriptTail
        activeMessage={context.activeMessage}
        agentStatus={context.agentStatus}
        handlers={context.handlers}
      />
    </div>
  );
};

interface VirtualizedTranscriptProps {
  segments: TranscriptSegment[];
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
  lastMessage: ChatMessage | null;
}

/**
 * Virtuoso-backed transcript path for long chats. Virtuoso owns the scroll
 * container and provides the primitives that replace the plain path's
 * hand-tuned scroll logic:
 *  - `followOutput`: at/near bottom → follow streaming output; scrolled up → don't yank.
 *  - `atBottomStateChange`: drives the scroll-to-bottom button visibility.
 *  - dynamic item measurement: variable-height markdown/code/tool summaries.
 * New-user-message "jump to bottom" is handled explicitly below, matching the
 * plain path's behavior even when the user had scrolled away.
 */
export function VirtualizedTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: VirtualizedTranscriptProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastMessageIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
  }, []);

  // Always jump to the bottom when the user sends a new message — even if they
  // had scrolled up (followOutput alone won't fire when not already at bottom).
  useEffect(() => {
    const previousId = lastMessageIdRef.current;
    const isNewMessage = lastMessage && lastMessage.id !== previousId;
    if (isNewMessage && lastMessage.role === 'user') {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
    }
    lastMessageIdRef.current = lastMessage?.id ?? null;
  }, [lastMessage]);

  const context = useMemo<VirtuosoContext>(
    () => ({ activeMessage, agentStatus, handlers }),
    [activeMessage, agentStatus, handlers],
  );

  return (
    <>
      <Virtuoso<TranscriptSegment, VirtuosoContext>
        ref={virtuosoRef}
        className="flex-1 overscroll-contain"
        data={segments}
        context={context}
        components={{ Header, Footer }}
        computeItemKey={(index, segment) => segmentKey(segment, index)}
        itemContent={(_index, segment, ctx) => (
          <div className="pb-1.5">
            <SegmentView segment={segment} handlers={ctx.handlers} />
          </div>
        )}
        followOutput={(atBottom) => (atBottom ? 'smooth' : false)}
        atBottomThreshold={AT_BOTTOM_THRESHOLD_PX}
        atBottomStateChange={setIsAtBottom}
        initialTopMostItemIndex={Math.max(0, segments.length - 1)}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />

      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />
    </>
  );
}
