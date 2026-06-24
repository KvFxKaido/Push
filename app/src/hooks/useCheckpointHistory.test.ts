import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CheckpointRecord } from '@/lib/checkpoint/checkpoint-store';

// Minimal index-based React mock (mirrors useWorkspaceSandboxController.test.ts):
// drive the hook directly, flushing effects manually.
type Effect = () => void | (() => void);
const reactState = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIndex: 0,
  states: [] as { value: unknown }[],
  stateIndex: 0,
  effects: [] as Effect[],
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (fn: Effect) => {
    reactState.effects.push(fn);
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.stateIndex++;
    if (!reactState.states[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.states[i] = { value: seed };
    }
    const cell = reactState.states[i];
    const setter = (value: T | ((prev: T) => T)) => {
      cell.value = typeof value === 'function' ? (value as (prev: T) => T)(cell.value as T) : value;
    };
    return [cell.value as T, setter];
  },
}));

const { useCheckpointHistory, restoreError, purgeError } = await import('./useCheckpointHistory');

const RECORDS: CheckpointRecord[] = [
  { checkpointId: 'c2', message: 'b', timestampMs: 200 },
  { checkpointId: 'c1', message: 'a', timestampMs: 100 },
];

type Args = Parameters<typeof useCheckpointHistory>[0];

function render(args: Args) {
  reactState.refIndex = 0;
  reactState.stateIndex = 0;
  reactState.effects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useCheckpointHistory(args);
}

async function flushEffects() {
  for (const effect of [...reactState.effects]) effect();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  reactState.refs = [];
  reactState.states = [];
  reactState.effects = [];
  reactState.refIndex = 0;
  reactState.stateIndex = 0;
});

describe('restoreError mapping', () => {
  it('maps each non-restored result', () => {
    expect(restoreError({ status: 'skipped-dirty' })).toMatch(/workspace has changes/);
    expect(restoreError({ status: 'unsupported' })).toMatch(/not available/);
    expect(restoreError({ status: 'failed', reason: 'boom' })).toBe('boom');
    expect(restoreError({ status: 'failed', reason: '' })).toBe('Restore failed.');
  });
});

describe('useCheckpointHistory', () => {
  const base = { sandboxId: 'sb', repoFullName: 'owner/repo', branch: 'feat/x', enabled: true };

  it('loads the lane history when ready', async () => {
    const list = vi.fn(async () => RECORDS);
    render({ ...base, list });
    await flushEffects();
    const view = render({ ...base, list });
    expect(list).toHaveBeenCalledWith({ repoFullName: 'owner/repo', branch: 'feat/x' });
    expect(view.checkpoints).toEqual(RECORDS);
    expect(view.loading).toBe(false);
  });

  it('does not load when disabled', async () => {
    const list = vi.fn(async () => RECORDS);
    render({ ...base, enabled: false, list });
    await flushEffects();
    const view = render({ ...base, enabled: false, list });
    expect(list).not.toHaveBeenCalled();
    expect(view.checkpoints).toEqual([]);
  });

  it('canRestore reflects whether a sandbox exists', () => {
    const list = vi.fn(async () => []);
    expect(render({ ...base, sandboxId: 'sb', list }).canRestore).toBe(true);
    reactState.states = [];
    reactState.refs = [];
    expect(render({ ...base, sandboxId: null, list }).canRestore).toBe(false);
  });

  it('restore() no-ops without a sandbox (Codex P2 — no silent dead control)', async () => {
    const list = vi.fn(async () => RECORDS);
    const restoreCheckpoint = vi.fn(async () => ({
      status: 'restored' as const,
      checkpointId: 'c2',
    }));
    const view = render({ ...base, sandboxId: null, list, restoreCheckpoint });
    await view.restore('c2');
    expect(restoreCheckpoint).not.toHaveBeenCalled();
  });

  it('restore() calls the store with the full scope when a sandbox exists', async () => {
    const list = vi.fn(async () => RECORDS);
    const restoreCheckpoint = vi.fn(async () => ({
      status: 'restored' as const,
      checkpointId: 'c2',
    }));
    const view = render({ ...base, list, restoreCheckpoint });
    await view.restore('c2');
    expect(restoreCheckpoint).toHaveBeenCalledWith({
      sandboxId: 'sb',
      repoFullName: 'owner/repo',
      branch: 'feat/x',
      checkpointId: 'c2',
    });
  });

  it('drop() calls the store with the lane scope + commitId (no sandbox needed)', async () => {
    const list = vi.fn(async () => RECORDS);
    const dropCheckpoint = vi.fn(async () => ({ status: 'dropped' as const }));
    // sandboxId null: drop operates on the on-device dir, not the live sandbox.
    const view = render({ ...base, sandboxId: null, list, dropCheckpoint });
    await view.drop('c1');
    expect(dropCheckpoint).toHaveBeenCalledWith({
      repoFullName: 'owner/repo',
      branch: 'feat/x',
      checkpointId: 'c1',
    });
  });

  it('clear() purges the lane; clear(true) purges all lanes', async () => {
    const list = vi.fn(async () => RECORDS);
    const clearCheckpoints = vi.fn(async () => ({ status: 'cleared' as const }));
    const view = render({ ...base, sandboxId: null, list, clearCheckpoints });
    await view.clear();
    expect(clearCheckpoints).toHaveBeenCalledWith(
      { repoFullName: 'owner/repo', branch: 'feat/x' },
      { allLanes: undefined },
    );
    await view.clear(true);
    expect(clearCheckpoints).toHaveBeenLastCalledWith(
      { repoFullName: 'owner/repo', branch: 'feat/x' },
      { allLanes: true },
    );
  });

  it('purgeError maps failed/unsupported results', () => {
    expect(purgeError({ status: 'unsupported' })).toMatch(/not available/);
    expect(purgeError({ status: 'failed', reason: 'rm -rf went wrong' })).toBe('rm -rf went wrong');
    expect(purgeError({ status: 'failed', reason: '' })).toBe('Could not clear checkpoints.');
  });
});
