import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@/types';
import { groupChatMessages } from '../tool-call-utils';
import { VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS, isVirtualizedTranscript } from './constants';
import { segmentKey } from './segment-model';
import { TranscriptList } from './TranscriptList';

function textMessage(id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: `msg-${id}`, timestamp: 1, status: 'done' };
}

function textSegments(count: number) {
  const messages = Array.from({ length: count }, (_, i) => textMessage(`m${i}`));
  return groupChatMessages(messages);
}

describe('isVirtualizedTranscript (threshold contract)', () => {
  it('stays on the plain path just below the threshold', () => {
    expect(isVirtualizedTranscript(VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS - 1)).toBe(false);
  });

  it('switches to the virtualized path at the threshold', () => {
    expect(isVirtualizedTranscript(VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS)).toBe(true);
    expect(isVirtualizedTranscript(VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS + 50)).toBe(true);
  });

  it('treats an empty transcript as plain', () => {
    expect(isVirtualizedTranscript(0)).toBe(false);
  });
});

describe('segmentKey', () => {
  it('keys text segments by message id and index', () => {
    const [segment] = groupChatMessages([textMessage('abc')]);
    expect(segmentKey(segment, 3)).toBe('abc-3');
  });

  it('keys tool groups by index', () => {
    const segments = groupChatMessages([
      {
        id: 'call',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'done',
        isToolCall: true,
      },
      {
        id: 'result',
        role: 'user',
        content: 'ok',
        timestamp: 2,
        status: 'done',
        isToolResult: true,
      },
    ]);
    expect(segments).toHaveLength(1);
    expect(segmentKey(segments[0], 2)).toBe('tool-group-2');
  });
});

describe('TranscriptList path selection (dev badge)', () => {
  const handlers = { regeneratableAssistantMessageId: null };

  it('renders the plain path below the threshold', () => {
    const html = renderToStaticMarkup(
      <TranscriptList
        segments={textSegments(3)}
        activeMessage={null}
        agentStatus={{ active: false, phase: '' }}
        handlers={handlers}
        lastMessage={null}
      />,
    );
    // Dev badge reflects the active path + count, and real bubbles render.
    expect(html).toContain('plain · 3');
    expect(html).toContain('msg-m0');
  });

  it('selects the virtualized path at the threshold', () => {
    const html = renderToStaticMarkup(
      <TranscriptList
        segments={textSegments(VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS)}
        activeMessage={null}
        agentStatus={{ active: false, phase: '' }}
        handlers={handlers}
        lastMessage={null}
      />,
    );
    expect(html).toContain(`virtualized · ${VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS}`);
  });
});
