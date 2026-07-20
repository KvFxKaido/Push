/**
 * run-host-attach tests — Durable Runs Phase 3 attach/viewer client.
 *
 * Covers the pure hydration planning (anchor/append/replace semantics the
 * acceptance's "transcript complete across the gap" rests on), the message
 * conversion rules, and the attach fetch parsing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADOPTION_RESUME_NOTE_MARKER } from '@push/lib/run-adoption-loop';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';
import {
  checkpointMessagesToChatMessages,
  fetchRunHostAttach,
  planTranscriptHydration,
} from './run-host-attach';

const SCOPE = { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' };

function makeCheckpoint(overrides: Partial<RunCheckpointV1> = {}): RunCheckpointV1 {
  return {
    v: 1,
    chatId: SCOPE.chatId,
    repoFullName: SCOPE.repoFullName,
    branch: SCOPE.branch,
    runId: 'run-1',
    round: 6,
    phase: 'executing_tools',
    savedAt: 1781000050000,
    reason: 'turn',
    messages: [
      { role: 'user', content: 'Fix the bug in foo.ts' },
      { role: 'assistant', content: 'Reading foo.ts', isToolCall: true },
      { role: 'user', content: '[Tool Result] contents', isToolResult: true },
      { role: 'user', content: `${ADOPTION_RESUME_NOTE_MARKER} continued server-side` },
      { role: 'assistant', content: 'Fixed it.' },
    ],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'Fix the bug in foo.ts',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkpointMessagesToChatMessages', () => {
  it('maps roles, preserves tool flags, and drops system turns', () => {
    const out = checkpointMessagesToChatMessages([
      { role: 'system', content: 'You are Push.' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'calling', isToolCall: true },
      { role: 'tool', content: '[Tool Result] ok' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[1].isToolCall).toBe(true);
    expect(out[2].isToolResult).toBe(true);
    expect(out.every((m) => m.id.length > 0 && m.status === 'done')).toBe(true);
  });

  it('gives runtime scaffolding notes a friendly displayContent, keeping content verbatim', () => {
    const note = `${ADOPTION_RESUME_NOTE_MARKER} The user's device went silent…`;
    const [msg] = checkpointMessagesToChatMessages([{ role: 'user', content: note }]);
    expect(msg.content).toBe(note);
    expect(msg.displayContent).toMatch(/continued server-side/i);
  });

  it('rebuilds image contentParts as image attachments (pixels survive replay)', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    const [msg] = checkpointMessagesToChatMessages([
      {
        role: 'user',
        content: 'what is in this screenshot?',
        contentParts: [
          { type: 'text', text: 'what is in this screenshot?' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ]);
    expect(msg.content).toBe('what is in this screenshot?');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments?.[0].type).toBe('image');
    expect(msg.attachments?.[0].content).toBe(url);
    expect(msg.attachments?.[0].mimeType).toBe('image/png');
  });

  it('rebuilds image contentBlocks as image attachments (pixels survive replay)', () => {
    const [msg] = checkpointMessagesToChatMessages([
      {
        role: 'user',
        content: 'what is in this screenshot?',
        contentBlocks: [
          { type: 'text', text: 'what is in this screenshot?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
      },
    ]);
    expect(msg.content).toBe('what is in this screenshot?');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments?.[0].type).toBe('image');
    expect(msg.attachments?.[0].content).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(msg.attachments?.[0].mimeType).toBe('image/png');
  });

  it('rebuilds attached-file text blocks as document attachments (capture-path inverse)', () => {
    const [msg] = checkpointMessagesToChatMessages([
      {
        role: 'user',
        content: 'review this config',
        contentBlocks: [
          { type: 'text', text: 'review this config' },
          { type: 'text', text: '[Attached file: wrangler.jsonc]\n```\n{ "name": "push" }\n```' },
        ],
      },
    ]);
    expect(msg.content).toBe('review this config');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments?.[0].type).toBe('document');
    expect(msg.attachments?.[0].filename).toBe('wrangler.jsonc');
    expect(msg.attachments?.[0].content).toBe('{ "name": "push" }');
  });

  it('folds unrecognized extra text parts into content rather than dropping them', () => {
    const [msg] = checkpointMessagesToChatMessages([
      {
        role: 'user',
        content: 'main text',
        contentParts: [
          { type: 'text', text: 'main text' },
          { type: 'text', text: 'some future part format' },
        ],
      },
    ]);
    expect(msg.content).toBe('main text\n\nsome future part format');
    expect(msg.attachments).toBeUndefined();
  });

  it('keeps assistant reasoning blocks for the provider round-trip', () => {
    const blocks = [{ type: 'thinking', thinking: 't', signature: 's' }];
    const [msg] = checkpointMessagesToChatMessages([
      {
        role: 'assistant',
        content: 'x',
        reasoningBlocks: blocks as never,
      },
    ]);
    expect(msg.reasoningBlocks).toEqual(blocks);
  });

  it('keeps encrypted Responses reasoning items for provider replay', () => {
    const items = [{ type: 'reasoning' as const, encrypted_content: 'opaque-ciphertext' }];
    const [msg] = checkpointMessagesToChatMessages([
      { role: 'assistant', content: 'x', responsesReasoningItems: items },
    ]);
    expect(msg.responsesReasoningItems).toEqual(items);
  });
});

describe('planTranscriptHydration', () => {
  it('appends only the gap suffix past the anchor', () => {
    const plan = planTranscriptHydration({
      hostCheckpoint: makeCheckpoint(),
      anchorCount: 3, // mirrored up to the tool result before going silent
      localMessageCount: 7,
    });
    expect(plan?.mode).toBe('append');
    expect(plan?.messages).toHaveLength(2); // adoption note + final assistant
    expect(plan?.hostMessageCount).toBe(5);
  });

  it('returns null when nothing advanced past the anchor (idempotent re-attach)', () => {
    expect(
      planTranscriptHydration({
        hostCheckpoint: makeCheckpoint(),
        anchorCount: 5,
        localMessageCount: 9,
      }),
    ).toBeNull();
  });

  it('replaces when the host transcript is shorter than the anchor (compaction)', () => {
    const plan = planTranscriptHydration({
      hostCheckpoint: makeCheckpoint(),
      anchorCount: 9,
      localMessageCount: 12,
    });
    expect(plan?.mode).toBe('replace');
    expect(plan?.messages).toHaveLength(5);
  });

  it('no anchor: appends into an empty conversation, replaces a non-empty one', () => {
    const fresh = planTranscriptHydration({
      hostCheckpoint: makeCheckpoint(),
      anchorCount: 0,
      localMessageCount: 0,
    });
    expect(fresh?.mode).toBe('append');
    const unaligned = planTranscriptHydration({
      hostCheckpoint: makeCheckpoint(),
      anchorCount: 0,
      localMessageCount: 4,
    });
    expect(unaligned?.mode).toBe('replace');
  });

  it('no anchor + empty host transcript: nothing to do', () => {
    expect(
      planTranscriptHydration({
        hostCheckpoint: makeCheckpoint({ messages: [] }),
        anchorCount: 0,
        localMessageCount: 0,
      }),
    ).toBeNull();
  });
});

describe('fetchRunHostAttach', () => {
  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('parses a snapshot and forwards the cursor on the query', async () => {
    const mock = stubFetch(200, {
      ok: true,
      v: 1,
      runId: 'run-1',
      state: 'adopted',
      mode: 'supervised',
      round: 6,
      midFlight: true,
      lastHeartbeatAt: 1,
      checkpointSavedAt: 1781000050000,
      checkpoint: makeCheckpoint(),
    });
    const result = await fetchRunHostAttach(SCOPE, 1781000000000);
    expect(result.kind).toBe('snapshot');
    if (result.kind === 'snapshot') {
      expect(result.snapshot.state).toBe('adopted');
      expect(result.snapshot.checkpoint?.round).toBe(6);
    }
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain('sinceSavedAt=1781000000000');
    expect(url).toContain(`chatId=${SCOPE.chatId}`);
  });

  it('maps 404 → none/not_found and 503 → none/not_configured', async () => {
    stubFetch(404, { error: 'NOT_FOUND' });
    expect(await fetchRunHostAttach(SCOPE, null)).toEqual({ kind: 'none', reason: 'not_found' });
    stubFetch(503, { error: 'NOT_CONFIGURED' });
    expect(await fetchRunHostAttach(SCOPE, null)).toEqual({
      kind: 'none',
      reason: 'not_configured',
    });
  });

  it('rejects a malformed snapshot (and a malformed embedded checkpoint) as error', async () => {
    stubFetch(200, { ok: true, runId: 'run-1' });
    expect((await fetchRunHostAttach(SCOPE, null)).kind).toBe('error');
    stubFetch(200, {
      ok: true,
      runId: 'run-1',
      state: 'adopted',
      round: 6,
      midFlight: true,
      checkpointSavedAt: 1,
      checkpoint: { v: 1, not: 'a checkpoint' },
    });
    expect((await fetchRunHostAttach(SCOPE, null)).kind).toBe('error');
  });

  it('never probes with an incomplete scope', async () => {
    const mock = stubFetch(200, {});
    const result = await fetchRunHostAttach({ ...SCOPE, branch: '' }, null);
    expect(result).toEqual({ kind: 'none', reason: 'incomplete_scope' });
    expect(mock).not.toHaveBeenCalled();
  });
});
