import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRunCheckpoint } from '@push/lib/run-checkpoint';
import type { ChatMessage } from '@/types';
import type { RunCheckpointV1Snapshot } from './run-checkpoint-capture';

// checkpoint-store is IndexedDB-backed; capture tests assert against the
// mocked save so persistence and logging can be observed without a DB.
const storeMocks = vi.hoisted(() => ({
  saveCheckpointV1: vi.fn<(checkpoint: unknown) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock('./checkpoint-store', () => storeMocks);

// The RunHost mirror is fire-and-forget; capture tests only assert the
// hand-off (the transport's own behavior lives in run-host-transport.test.ts).
const transportMocks = vi.hoisted(() => ({
  publishRunCheckpointToHost: vi.fn<(checkpoint: unknown) => void>(),
}));
vi.mock('./run-host-transport', () => transportMocks);

const { buildRunCheckpointV1, captureRunCheckpointV1, deriveUserGoal, toRunCheckpointMessages } =
  await import('./run-checkpoint-capture');

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<RunCheckpointV1Snapshot> = {}): RunCheckpointV1Snapshot {
  return {
    chatId: 'chat-1',
    repoFullName: 'owner/repo',
    branch: 'feature/x',
    workspaceSessionId: 'ws-1',
    round: 2,
    phase: 'executing_tools',
    reason: 'turn',
    apiMessages: [
      msg({ id: 'u1', content: 'Fix the login bug', displayContent: 'Fix the login bug' }),
      msg({ id: 'a1', role: 'assistant', content: 'Looking at it.', isToolCall: true }),
      msg({ id: 't1', content: '{"ok":true}', isToolResult: true }),
    ],
    accumulated: 'partial',
    thinkingAccumulated: '',
    provider: 'zen',
    model: 'big-model',
    approvalMode: 'supervised',
    verificationPolicy: { name: 'Standard', rules: [] },
    workingMemory: null,
    sandboxSessionId: 'sb-1',
    ...overrides,
  };
}

beforeEach(() => {
  storeMocks.saveCheckpointV1.mockClear();
  storeMocks.saveCheckpointV1.mockResolvedValue(undefined);
  transportMocks.publishRunCheckpointToHost.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toRunCheckpointMessages', () => {
  it('maps roles, tool flags, and both reasoning replay sidecars', () => {
    const out = toRunCheckpointMessages([
      msg({ content: 'do it' }),
      msg({
        role: 'assistant',
        content: 'ok',
        isToolCall: true,
        reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
        responsesReasoningItems: [{ type: 'reasoning', encrypted_content: 'opaque-ciphertext' }],
      }),
      msg({ content: 'result', isToolResult: true }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'user', content: 'do it' });
    expect(out[1]).toMatchObject({ role: 'assistant', isToolCall: true });
    expect(out[1].reasoningBlocks).toHaveLength(1);
    expect(out[1].responsesReasoningItems).toEqual([
      { type: 'reasoning', encrypted_content: 'opaque-ciphertext' },
    ]);
    expect(out[2]).toMatchObject({ role: 'user', content: 'result', isToolResult: true });
  });

  it('drops messages marked visibleToModel: false', () => {
    const out = toRunCheckpointMessages([
      msg({ content: 'kept' }),
      msg({ role: 'assistant', content: 'aborted partial', visibleToModel: false }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('kept');
  });

  it('converts attachments to contentBlocks like the wire builder', () => {
    const out = toRunCheckpointMessages([
      msg({
        content: 'see image',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            filename: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            content: 'data:image/png;base64,AAA',
          },
          {
            id: 'att-2',
            type: 'code',
            filename: 'a.ts',
            mimeType: 'text/plain',
            sizeBytes: 12,
            content: 'const x = 1;',
          },
        ],
      }),
    ]);
    expect(out[0].contentBlocks).toEqual([
      { type: 'text', text: 'see image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: '[Attached file: a.ts]\n```\nconst x = 1;\n```' },
    ]);
    expect(out[0].contentParts).toBeUndefined();
  });

  it('preserves a kernel turn’s existing contentParts (no attachments to rebuild from)', () => {
    // The Coder kernel’s image turn carries pixels in `contentParts` only, not
    // `attachments`; the checkpoint must pass them through so an adopted/resumed
    // run keeps the image (Codex P2, #937).
    const contentParts = [
      { type: 'text' as const, text: 'Task: describe this' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,ZZZ' } },
    ];
    const out = toRunCheckpointMessages([msg({ content: 'Task: describe this', contentParts })]);
    expect(out[0].contentParts).toEqual(contentParts);
  });
});

describe('deriveUserGoal', () => {
  it('returns the latest real user message, skipping tool results', () => {
    const goal = deriveUserGoal([
      msg({ content: 'original task' }),
      msg({ role: 'assistant', content: 'working' }),
      msg({ content: 'steer: also fix tests', displayContent: 'steer: also fix tests' }),
      msg({ content: '{"tool":"result"}', isToolResult: true }),
    ]);
    expect(goal).toBe('steer: also fix tests');
  });

  it('prefers displayContent over runtime-wrapped content', () => {
    const goal = deriveUserGoal([
      msg({ content: '[RUNTIME WRAPPER] fix it [/RUNTIME]', displayContent: 'fix it' }),
    ]);
    expect(goal).toBe('fix it');
  });

  it('returns empty string when no user message exists', () => {
    expect(deriveUserGoal([msg({ role: 'assistant', content: 'hi' })])).toBe('');
  });
});

describe('buildRunCheckpointV1', () => {
  it('produces a checkpoint that passes schema validation', () => {
    const checkpoint = buildRunCheckpointV1(makeSnapshot());
    expect(validateRunCheckpoint(checkpoint)).toEqual([]);
    expect(checkpoint.userGoal).toBe('Fix the login bug');
    expect(checkpoint.messages).toHaveLength(3);
  });

  it('carries the run id only when the snapshot has one', () => {
    expect(buildRunCheckpointV1(makeSnapshot({ runId: 'run-7' })).runId).toBe('run-7');
    expect(buildRunCheckpointV1(makeSnapshot()).runId).toBeUndefined();
    expect(buildRunCheckpointV1(makeSnapshot({ runId: '' })).runId).toBeUndefined();
  });

  it('carries the zen Go transport flag only when set', () => {
    expect(buildRunCheckpointV1(makeSnapshot({ zenGo: true })).providerOptions).toEqual({
      zenGo: true,
    });
    expect(buildRunCheckpointV1(makeSnapshot()).providerOptions).toBeUndefined();
  });

  it('marks delegation active with serialized coder state during delegation phases', () => {
    const checkpoint = buildRunCheckpointV1(
      makeSnapshot({
        phase: 'delegating_coder',
        workingMemory: { plan: 'step 1' },
      }),
    );
    expect(checkpoint.delegation).toEqual({
      active: true,
      lastCoderState: JSON.stringify({ plan: 'step 1' }),
    });
    expect(buildRunCheckpointV1(makeSnapshot()).delegation).toBeUndefined();
  });
});

describe('captureRunCheckpointV1', () => {
  it('persists a valid checkpoint and logs bytes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    captureRunCheckpointV1(makeSnapshot());

    expect(storeMocks.saveCheckpointV1).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const captured = logSpy.mock.calls
        .map((c) => c[0])
        .filter((line): line is string => typeof line === 'string')
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.event === 'run_checkpoint_captured');
      expect(captured).toMatchObject({
        level: 'info',
        chatId: 'chat-1',
        round: 2,
        reason: 'turn',
        messages: 3,
      });
      expect(captured?.bytes).toBeGreaterThan(0);
    });
  });

  it('mirrors a valid checkpoint to the RunHost transport', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    captureRunCheckpointV1(makeSnapshot({ runId: 'run-7' }));

    expect(transportMocks.publishRunCheckpointToHost).toHaveBeenCalledTimes(1);
    expect(transportMocks.publishRunCheckpointToHost).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-7', chatId: 'chat-1', round: 2 }),
    );
  });

  it('mirrors to the host even when the local store rejects', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeMocks.saveCheckpointV1.mockRejectedValueOnce(new Error('quota exceeded'));
    captureRunCheckpointV1(makeSnapshot({ runId: 'run-7' }));

    await vi.waitFor(() => {
      expect(transportMocks.publishRunCheckpointToHost).toHaveBeenCalledTimes(1);
    });
  });

  it('skips persistence and warns when the checkpoint is invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureRunCheckpointV1(makeSnapshot({ provider: '' }));

    expect(storeMocks.saveCheckpointV1).not.toHaveBeenCalled();
    expect(transportMocks.publishRunCheckpointToHost).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string => typeof line === 'string')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((parsed) => parsed.event === 'run_checkpoint_invalid');
    expect(warned).toMatchObject({ level: 'warn', chatId: 'chat-1' });
  });

  it('logs a write failure when the store rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeMocks.saveCheckpointV1.mockRejectedValueOnce(new Error('quota exceeded'));
    captureRunCheckpointV1(makeSnapshot());

    await vi.waitFor(() => {
      const warned = warnSpy.mock.calls
        .map((c) => c[0])
        .filter((line): line is string => typeof line === 'string')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((parsed) => parsed.event === 'run_checkpoint_write_failed');
      expect(warned).toMatchObject({ level: 'warn', error: 'quota exceeded' });
    });
  });
});
