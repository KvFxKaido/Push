import { describe, expect, it } from 'vitest';
import {
  RUNTIME_CONTEXT_SECTIONS,
  buildRuntimeMemoryScope,
  clearRuntimeCoderWorkingMemory,
  createRuntimeContext,
  readRuntimeCoderWorkingMemory,
  setRuntimeCoderWorkingMemory,
  type PushRuntimeContext,
} from './runtime-context';

describe('runtime-context', () => {
  it('keeps the named section vocabulary in sync with PushRuntimeContext', () => {
    const sample: PushRuntimeContext = createRuntimeContext();

    expect([...RUNTIME_CONTEXT_SECTIONS].sort()).toEqual(Object.keys(sample).sort());
  });

  it('builds the durable memory scope from repo-first identifiers', () => {
    expect(
      buildRuntimeMemoryScope({
        repoFullName: 'owner/repo',
        branch: 'feature/runtime-context',
        chatId: 'chat-1',
      }),
    ).toEqual({
      repoFullName: 'owner/repo',
      branch: 'feature/runtime-context',
      chatId: 'chat-1',
    });

    // A deliberate run-scoped write can still opt in through `extras`.
    expect(
      buildRuntimeMemoryScope({
        repoFullName: 'owner/repo',
        chatId: 'chat-1',
        extras: { role: 'coder' },
      }),
    ).toEqual({
      repoFullName: 'owner/repo',
      chatId: 'chat-1',
      role: 'coder',
    });

    expect(buildRuntimeMemoryScope({ repoFullName: null, chatId: 'chat-1' })).toBeNull();
  });

  it('owns coder working-memory mutation behind one helper surface', () => {
    const ctx = createRuntimeContext();
    const state = { plan: 'ship the consolidation' };

    setRuntimeCoderWorkingMemory(ctx, state);
    expect(readRuntimeCoderWorkingMemory(ctx)).toBe(state);

    clearRuntimeCoderWorkingMemory(ctx);
    expect(readRuntimeCoderWorkingMemory(ctx)).toBeNull();
  });
});
