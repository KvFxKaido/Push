import { useCallback, useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { ChatMessage, AgentStatus } from '@/types';
import { SegmentView, TranscriptTail } from './segment-view';
import { segmentKey, type TranscriptSegment, type TranscriptHandlers } from './segment-model';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useStickToBottom } from './use-stick-to-bottom';

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
 * comes from the shared `useStickToBottom` hook, driven against Virtuoso's
 * scroller element.
 *
 * Why not `followOutput`? Virtuoso's `followOutput` only reacts to changes in
 * the item *count*. The streaming assistant tail grows inside the footer
 * (`context`) without changing the settled-segment count, so `followOutput`
 * would stop following a streaming response, and its only knobs key off
 * `atBottomThreshold` (48px) rather than the plain path's 150px grace distance.
 * Driving the scroll manually against the scroller lets us (a) follow the
 * footer's growth, (b) reach the footer's bottom (not just the last data item),
 * and (c) share the exact thresholds with the plain path. `alignOnMount`
 * bottom-aligns past the footer at the threshold crossover; Virtuoso's
 * `initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}` is the race-free
 * native baseline beneath it.
 */
export function VirtualizedTranscript({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: VirtualizedTranscriptProps) {
  const { registerScroller, isAtBottom, scrollToBottom } = useStickToBottom(lastMessage, {
    alignOnMount: true,
  });

  const context = useMemo<VirtuosoContext>(
    () => ({ activeMessage, agentStatus, handlers }),
    [activeMessage, agentStatus, handlers],
  );

  // Stable renderers/props so Virtuoso isn't handed fresh references each render.
  // They close over nothing reactive — segment/context arrive as arguments,
  // Header/Footer are module-level, segmentKey/SegmentView are imports.
  const components = useMemo(() => ({ Header, Footer }), []);
  const computeItemKey = useCallback(
    (index: number, segment: TranscriptSegment) => segmentKey(segment, index),
    [],
  );
  const itemContent = useCallback(
    (_index: number, segment: TranscriptSegment, ctx: VirtuosoContext) => (
      <div className="pb-1.5">
        <SegmentView segment={segment} handlers={ctx.handlers} />
      </div>
    ),
    [],
  );

  return (
    <>
      <Virtuoso<TranscriptSegment, VirtuosoContext>
        scrollerRef={registerScroller}
        className="flex-1 overscroll-contain"
        data={segments}
        context={context}
        components={components}
        computeItemKey={computeItemKey}
        itemContent={itemContent}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />

      <ScrollToBottomButton visible={!isAtBottom} onClick={() => scrollToBottom('smooth')} />
    </>
  );
}
