import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@/types';
import { groupChatMessages } from '../tool-call-utils';
import {
  VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS,
  isVirtualizedTranscript,
  turnSpacerHeight,
} from './constants';
import { segmentKey, sameSegmentContent } from './segment-model';
import { TranscriptList } from './TranscriptList';
import { nextAnnouncement, type AnnouncerSnapshot } from './transcript-announce';

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

  it('throws on an unknown segment variant (exhaustiveness guard)', () => {
    // Compile-time exhaustiveness is the real guard; this confirms the runtime
    // fallback isn't a silent no-op if an unhandled variant ever reaches it.
    expect(() => segmentKey({ type: 'mystery' } as never, 0)).toThrow();
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

describe('sameSegmentContent (settled-segment memoization)', () => {
  it('treats fresh wrappers around the same message as equal', () => {
    const message = textMessage('m1');
    // groupChatMessages allocates a new wrapper each call; the underlying
    // message ref is what must drive equality so settled bubbles skip re-render.
    const [a] = groupChatMessages([message]);
    const [b] = groupChatMessages([message]);
    expect(a).not.toBe(b);
    expect(sameSegmentContent(a, b)).toBe(true);
  });

  it('treats a new message object (same id) as changed', () => {
    const [a] = groupChatMessages([textMessage('m1')]);
    const [b] = groupChatMessages([textMessage('m1')]);
    expect(sameSegmentContent(a, b)).toBe(false);
  });

  it('compares tool groups by their underlying call/result refs', () => {
    const call: ChatMessage = {
      id: 'call',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'done',
      isToolCall: true,
    };
    const result: ChatMessage = {
      id: 'result',
      role: 'user',
      content: 'ok',
      timestamp: 2,
      status: 'done',
      isToolResult: true,
    };
    const [a] = groupChatMessages([call, result]);
    const [b] = groupChatMessages([call, result]);
    expect(sameSegmentContent(a, b)).toBe(true);

    const [c] = groupChatMessages([call, { ...result }]);
    expect(sameSegmentContent(a, c)).toBe(false);
  });

  it('treats a text segment and a tool group as unequal', () => {
    const [text] = groupChatMessages([textMessage('m1')]);
    const [tool] = groupChatMessages([
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
    expect(sameSegmentContent(text, tool)).toBe(false);
  });
});

describe('nextAnnouncement (aria-live turn boundaries)', () => {
  const snap = (id: string, status: ChatMessage['status']): AnnouncerSnapshot => ({ id, status });
  const msg = (
    id: string,
    status: ChatMessage['status'],
    role: ChatMessage['role'] = 'assistant',
  ) => ({ id, role, status }) as Pick<ChatMessage, 'id' | 'role' | 'status'>;

  it('announces when an assistant turn starts streaming', () => {
    expect(nextAnnouncement(null, msg('a', 'streaming'))).toBe('Responding…');
    expect(nextAnnouncement(null, msg('a', 'sending'))).toBe('Responding…');
  });

  it('stays silent across streaming tokens of the same turn', () => {
    expect(nextAnnouncement(snap('a', 'streaming'), msg('a', 'streaming'))).toBeNull();
  });

  it('announces completion and failure once per turn', () => {
    expect(nextAnnouncement(snap('a', 'streaming'), msg('a', 'done'))).toBe('Response ready.');
    expect(nextAnnouncement(snap('a', 'done'), msg('a', 'done'))).toBeNull();
    expect(nextAnnouncement(snap('a', 'streaming'), msg('a', 'error'))).toBe('Response failed.');
  });

  it('re-announces a new turn even with the same status (distinct id)', () => {
    // A fresh assistant turn that begins streaming is a new boundary.
    expect(nextAnnouncement(snap('a', 'done'), msg('b', 'streaming'))).toBe('Responding…');
  });

  it('ignores the reader own (user) messages', () => {
    expect(nextAnnouncement(null, msg('u', 'done', 'user'))).toBeNull();
    expect(nextAnnouncement(null, null)).toBeNull();
  });
});

describe('turnSpacerHeight (top-anchor room)', () => {
  it('fills the slack so a short turn can reach the top, minus the gap', () => {
    // viewport 800, a 200px turn, default gap 72 → 800 - 200 - 72 = 528.
    expect(turnSpacerHeight(800, 200, 72)).toBe(528);
  });

  it('collapses to 0 once the turn is at least a viewport tall', () => {
    expect(turnSpacerHeight(800, 800)).toBe(0);
    expect(turnSpacerHeight(800, 2000)).toBe(0);
  });

  it('never returns negative (clamped at 0)', () => {
    // Turn just shorter than the viewport but within the gap → still clamps.
    expect(turnSpacerHeight(800, 760, 72)).toBe(0);
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
        lastUserMessageId={null}
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
        lastUserMessageId={null}
      />,
    );
    expect(html).toContain(`virtualized · ${VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS}`);
  });
});
