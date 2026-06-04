import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { ChatMessage, AgentStatus } from '@/types';
import { SegmentView, TranscriptTail } from './segment-view';
import { segmentKey, type TranscriptSegment, type TranscriptHandlers } from './segment-model';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { AUTO_SCROLL_THRESHOLD_PX, AT_BOTTOM_THRESHOLD_PX } from './constants';

/**
 * Context handed to Virtuoso's item renderer and footer. Carrying the streaming
 * tail through `context` (rather than closing over it) keeps the footer mounted
 * so the actively-streaming message isn't virtualized.
 */
interface VirtuosoContext {
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
}

// Top spacer — mirrors the `py-4` top padding of the plain path.
const Header = () => <div className="h-4" />;

// The streaming tail + status bar live in the footer so they stay mounted and
// non-virtualized. `space-y-1.5` matches the plain path, where the tail's
// children share the transcript's `space-y-1.5` rhythm.
const Footer = ({ context }: { context?: VirtuosoContext }) => {
  if (!context) return null;
  return (
    <div className="pb-4 space-y-1.5">
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
 * container and provides dynamic item measurement; the stick-to-bottom behavior
 * is driven manually against the scroll element so it matches the plain path
 * exactly.
 *
 * Why not `followOutput`? Virtuoso's `followOutput` only reacts to changes in
 * the item *count*. The streaming assistant tail grows inside the footer
 * (`context`) without changing the settled-segment count, so `followOutput`
 * would stop following a streaming response, and its only knobs key off
 * `atBottomThreshold` (48px) rather than the plain path's 150px grace distance.
 * Driving the scroll manually against `scrollerRef` lets us (a) follow the
 * footer's growth, (b) reach the footer's bottom (not just the last data item),
 * and (c) reuse `AUTO_SCROLL_THRESHOLD_PX`/`AT_BOTTOM_THRESHOLD_PX` so the two
 * paths behave identically.
 */
export function VirtualizedTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: VirtualizedTranscriptProps) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastMessageIdRef = useRef<string | null>(null);

  // Scroll to the very bottom of the scroll element — past the footer, so the
  // streaming tail and status bar are reached (not just the last data item).
  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Bottom-align on mount. This is the threshold-crossover case: when a chat
  // grows past the segment threshold the virtualized container mounts fresh, and
  // without this it would render with the last item aligned to the *top* of the
  // viewport. Runs before paint so there's no visible jump.
  useLayoutEffect(() => {
    scrollToBottom('auto');
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stick-to-bottom mirroring the plain path: jump to bottom on a new user
  // message even when scrolled away, otherwise follow streaming output only
  // while within the 150px grace distance. Keyed on the streaming content so it
  // re-evaluates on every chunk (the part `followOutput` can't see).
  const streamingContent = activeMessage?.content ?? '';
  useEffect(() => {
    const previousId = lastMessageIdRef.current;
    const isNewMessage = lastMessage && lastMessage.id !== previousId;
    lastMessageIdRef.current = lastMessage?.id ?? null;

    const el = scrollerRef.current;
    if (!el) return;

    if (isNewMessage && lastMessage.role === 'user') {
      scrollToBottom('smooth');
      return;
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX) {
      scrollToBottom('smooth');
    }
  }, [lastMessage, streamingContent, agentStatus, segments, scrollToBottom]);

  const handleScrollToBottomClick = useCallback(() => {
    scrollToBottom('smooth');
    setIsAtBottom(true);
  }, [scrollToBottom]);

  const context = useMemo<VirtuosoContext>(
    () => ({ activeMessage, agentStatus, handlers }),
    [activeMessage, agentStatus, handlers],
  );

  return (
    <>
      <Virtuoso<TranscriptSegment, VirtuosoContext>
        scrollerRef={(ref) => {
          scrollerRef.current = ref as HTMLElement | null;
        }}
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
        atBottomThreshold={AT_BOTTOM_THRESHOLD_PX}
        atBottomStateChange={setIsAtBottom}
        initialTopMostItemIndex={Math.max(0, segments.length - 1)}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />

      <ScrollToBottomButton visible={!isAtBottom} onClick={handleScrollToBottomClick} />
    </>
  );
}
