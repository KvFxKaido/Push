import { useEffect } from 'react';
import type { ChatMessage, AgentStatus } from '@/types';
import type { TranscriptSegment, TranscriptHandlers } from './segment-model';
import { PlainTranscript } from './PlainTranscript';
import { VirtualizedTranscript } from './VirtualizedTranscript';
import { VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS, isVirtualizedTranscript } from './constants';

interface TranscriptListProps {
  segments: TranscriptSegment[];
  activeMessage: ChatMessage | null;
  agentStatus: AgentStatus;
  handlers: TranscriptHandlers;
  lastMessage: ChatMessage | null;
}

/**
 * Narrow transcript adapter. The rest of Push renders through this component and
 * never imports the virtualization library directly — swapping it out stays a
 * one-file change. Both paths consume the same grouped-segment contract and the
 * same per-segment renderer; only the list container (and its scroll ownership)
 * differs. The plain path stays the default until a chat crosses
 * `VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS` settled segments.
 */
export function TranscriptList({
  segments,
  activeMessage,
  agentStatus,
  handlers,
  lastMessage,
}: TranscriptListProps) {
  const virtualized = isVirtualizedTranscript(segments.length);
  const path = virtualized ? 'virtualized' : 'plain';

  // Dev-only structured log on path transition. Uses the repo's canonical
  // `JSON.stringify({ level, event, ...ctx })` shape, but gated to DEV (like the
  // badge below) since this is a browser surface — prod infra wouldn't capture
  // client console output, and the log exists for screenshot/testing
  // verification rather than server-side ops.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log(
      JSON.stringify({
        level: 'debug',
        event: 'transcript_render_path',
        path,
        segmentCount: segments.length,
        threshold: VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS,
      }),
    );
    // Log only on path transition, not on every segment-count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden relative">
      {virtualized ? (
        <VirtualizedTranscript
          segments={segments}
          activeMessage={activeMessage}
          agentStatus={agentStatus}
          handlers={handlers}
          lastMessage={lastMessage}
        />
      ) : (
        <PlainTranscript
          segments={segments}
          activeMessage={activeMessage}
          agentStatus={agentStatus}
          handlers={handlers}
          lastMessage={lastMessage}
        />
      )}

      {import.meta.env.DEV && (
        <div className="pointer-events-none absolute right-2 top-2 z-30 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-push-fg-secondary">
          {path} · {segments.length}
        </div>
      )}
    </div>
  );
}
