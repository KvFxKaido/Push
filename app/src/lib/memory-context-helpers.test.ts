/**
 * Characterization tests for the typed-memory helpers extracted from
 * `useAgentDelegation.ts` as Phase 1 of the useAgentDelegation extraction
 * track (see `docs/decisions/useAgentDelegation Coupling Recon.md`).
 *
 * These tests pin the helpers' shape so the next extraction phases (Sequential
 * Explorer, Sequential Coder, etc.) can rely on the helpers' contract without
 * re-deriving it from the hook's call sites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryQuery } from '@/types';

const buildRetrievedMemoryKnownContext = vi.hoisted(() => vi.fn());

vi.mock('@/lib/context-memory', () => ({
  buildRetrievedMemoryKnownContext,
}));

const {
  buildMemoryScope,
  formatMemoryError,
  logContextMemoryWarning,
  runContextMemoryBestEffort,
  retrieveMemoryKnownContextLine,
  withMemoryContext,
} = await import('./memory-context-helpers');

beforeEach(() => {
  buildRetrievedMemoryKnownContext.mockReset();
});

describe('buildMemoryScope', () => {
  it('returns null when repoFullName is null (scratch mode)', () => {
    expect(buildMemoryScope('chat-1', null, 'main')).toBeNull();
  });

  it('returns scope with repo + chatId + branch when all present', () => {
    expect(buildMemoryScope('chat-1', 'octo/repo', 'main')).toEqual({
      repoFullName: 'octo/repo',
      chatId: 'chat-1',
      branch: 'main',
    });
  });

  it('omits branch when undefined', () => {
    expect(buildMemoryScope('chat-1', 'octo/repo', undefined)).toEqual({
      repoFullName: 'octo/repo',
      chatId: 'chat-1',
    });
  });

  it('omits branch when null', () => {
    expect(buildMemoryScope('chat-1', 'octo/repo', null)).toEqual({
      repoFullName: 'octo/repo',
      chatId: 'chat-1',
    });
  });

  it('merges extras (taskGraphId, taskId) into the scope', () => {
    expect(
      buildMemoryScope('chat-1', 'octo/repo', 'main', {
        taskGraphId: 'tg-1',
        taskId: 'task-3',
      }),
    ).toEqual({
      repoFullName: 'octo/repo',
      chatId: 'chat-1',
      branch: 'main',
      taskGraphId: 'tg-1',
      taskId: 'task-3',
    });
  });
});

describe('formatMemoryError', () => {
  it('returns the message of an Error instance', () => {
    expect(formatMemoryError(new Error('boom'))).toBe('boom');
  });

  it('falls back to String() when Error has no message', () => {
    const err = new Error('');
    expect(formatMemoryError(err)).toBe(err.toString());
  });

  it('stringifies non-Error values', () => {
    expect(formatMemoryError('plain string')).toBe('plain string');
    expect(formatMemoryError(42)).toBe('42');
    expect(formatMemoryError(undefined)).toBe('undefined');
  });
});

describe('logContextMemoryWarning', () => {
  it('emits a console.warn with the action and formatted error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logContextMemoryWarning('writing explorer memory', new Error('disk full'));
    expect(warn).toHaveBeenCalledWith(
      '[context-memory] writing explorer memory failed; continuing without persisted memory.',
      'disk full',
    );
    warn.mockRestore();
  });
});

describe('runContextMemoryBestEffort', () => {
  it('awaits the operation on the success path and does not log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = vi.fn().mockResolvedValue('done');
    await runContextMemoryBestEffort('writing memory', operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows operation errors and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = vi.fn().mockRejectedValue(new Error('network'));
    await expect(runContextMemoryBestEffort('writing memory', operation)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[context-memory] writing memory failed; continuing without persisted memory.',
      'network',
    );
    warn.mockRestore();
  });
});

describe('retrieveMemoryKnownContextLine', () => {
  it('returns null when scope is null without calling the retrieval backend', async () => {
    const line = await retrieveMemoryKnownContextLine(null, 'explorer', 'find auth');
    expect(line).toBeNull();
    expect(buildRetrievedMemoryKnownContext).not.toHaveBeenCalled();
  });

  it('returns the retrieved line on success', async () => {
    buildRetrievedMemoryKnownContext.mockResolvedValueOnce({ line: 'prior context' });
    const line = await retrieveMemoryKnownContextLine(
      { repoFullName: 'octo/repo', chatId: 'chat-1', branch: 'main' },
      'explorer',
      'find auth',
      ['src/auth.ts'],
    );
    expect(line).toBe('prior context');
    const queryArg = buildRetrievedMemoryKnownContext.mock.calls[0]![0] as MemoryQuery;
    expect(queryArg).toMatchObject({
      repoFullName: 'octo/repo',
      chatId: 'chat-1',
      branch: 'main',
      role: 'explorer',
      taskText: 'find auth',
      fileHints: ['src/auth.ts'],
      maxRecords: 6,
    });
  });

  it('merges extras into the query (taskGraphId, taskId)', async () => {
    buildRetrievedMemoryKnownContext.mockResolvedValueOnce({ line: null });
    await retrieveMemoryKnownContextLine(
      { repoFullName: 'octo/repo', chatId: 'chat-1' },
      'coder',
      'fix bug',
      undefined,
      { taskGraphId: 'tg-1', taskId: 'task-2' },
    );
    const queryArg = buildRetrievedMemoryKnownContext.mock.calls[0]![0] as MemoryQuery;
    expect(queryArg.taskGraphId).toBe('tg-1');
    expect(queryArg.taskId).toBe('task-2');
  });

  it('returns null and logs when the retrieval throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildRetrievedMemoryKnownContext.mockRejectedValueOnce(new Error('backend down'));
    const line = await retrieveMemoryKnownContextLine(
      { repoFullName: 'octo/repo', chatId: 'chat-1' },
      'auditor',
      'evaluate',
    );
    expect(line).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[context-memory] retrieving auditor context failed; continuing without persisted memory.',
      'backend down',
    );
    warn.mockRestore();
  });
});

describe('withMemoryContext', () => {
  it('returns the base unchanged when line is null', () => {
    expect(withMemoryContext(['existing'], null)).toEqual(['existing']);
    expect(withMemoryContext(undefined, null)).toBeUndefined();
  });

  it('returns a new single-element array when base is undefined', () => {
    expect(withMemoryContext(undefined, 'new line')).toEqual(['new line']);
  });

  it('returns a new single-element array when base is empty', () => {
    expect(withMemoryContext([], 'new line')).toEqual(['new line']);
  });

  it('appends the line to a non-empty base (immutably)', () => {
    const base = ['a', 'b'];
    const out = withMemoryContext(base, 'c');
    expect(out).toEqual(['a', 'b', 'c']);
    expect(base).toEqual(['a', 'b']);
  });
});
