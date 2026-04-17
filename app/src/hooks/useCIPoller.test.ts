import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CIStatus } from '@/types';

const executeToolCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/github-tools', () => ({
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

type EffectEntry = {
  fn: () => void | (() => void);
  deps?: unknown[];
};

const hookState = vi.hoisted(() => ({
  ciStatus: null as CIStatus | null,
  setCiStatus: vi.fn<(value: CIStatus | null) => void>(),
  effects: [] as EffectEntry[],
}));

vi.mock('react', () => ({
  useState: <T>(initial: T) => [
    (hookState.ciStatus as unknown as T | null) ?? initial,
    hookState.setCiStatus,
  ],
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    hookState.effects.push({ fn, deps });
  },
}));

const { useCIPoller } = await import('./useCIPoller');

function buildCiCard(overrides: Partial<CIStatus> = {}): { type: 'ci-status'; data: CIStatus } {
  return {
    type: 'ci-status',
    data: {
      state: 'success',
      checks: [],
      ...overrides,
    } as CIStatus,
  };
}

beforeEach(() => {
  executeToolCall.mockReset();
  hookState.ciStatus = null;
  hookState.setCiStatus.mockReset();
  hookState.effects = [];
  vi.useRealTimers();
});

describe('useCIPoller', () => {
  it('returns null when no repo is active', () => {
    const result = useCIPoller('chat-1', null);
    expect(result.ciStatus).toBeNull();
    // The effect is registered but should early-return without polling.
    hookState.effects[0]?.fn();
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it('returns null when no branch is available (current or default)', () => {
    const result = useCIPoller('chat-1', 'owner/repo');
    expect(result.ciStatus).toBeNull();
    hookState.effects[0]?.fn();
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it('polls with the current branch when one is set', async () => {
    executeToolCall.mockResolvedValue({ card: buildCiCard({ state: 'failure' }) });
    hookState.ciStatus = null;

    useCIPoller('chat-1', 'owner/repo', {
      currentBranch: 'feature/x',
      defaultBranch: 'main',
    });

    vi.useFakeTimers();
    const cleanup = hookState.effects[0]?.fn() as (() => void) | undefined;
    // The initial poll fires without waiting for the 60s interval.
    await vi.waitFor(() => {
      expect(executeToolCall).toHaveBeenCalledWith(
        { tool: 'fetch_checks', args: { repo: 'owner/repo', ref: 'feature/x' } },
        'owner/repo',
      );
    });
    cleanup?.();
  });

  it('falls back to the default branch when currentBranch is missing', async () => {
    executeToolCall.mockResolvedValue({ card: buildCiCard() });
    useCIPoller('chat-1', 'owner/repo', { defaultBranch: 'main' });

    const cleanup = hookState.effects[0]?.fn() as (() => void) | undefined;
    await vi.waitFor(() => {
      expect(executeToolCall).toHaveBeenCalledWith(
        { tool: 'fetch_checks', args: { repo: 'owner/repo', ref: 'main' } },
        'owner/repo',
      );
    });
    cleanup?.();
  });

  it('stores the CI status when the returned card is a ci-status card', async () => {
    const ciCard = buildCiCard({ state: 'pending' });
    executeToolCall.mockResolvedValue({ card: ciCard });

    useCIPoller('chat-1', 'owner/repo', { currentBranch: 'main' });
    const cleanup = hookState.effects[0]?.fn() as (() => void) | undefined;

    await vi.waitFor(() => {
      expect(hookState.setCiStatus).toHaveBeenCalledWith(ciCard.data);
    });
    cleanup?.();
  });

  it('ignores a non-ci card returned from the tool', async () => {
    executeToolCall.mockResolvedValue({ card: { type: 'something-else' } });

    useCIPoller('chat-1', 'owner/repo', { currentBranch: 'main' });
    const cleanup = hookState.effects[0]?.fn() as (() => void) | undefined;

    await vi.waitFor(() => {
      expect(executeToolCall).toHaveBeenCalled();
    });
    expect(hookState.setCiStatus).not.toHaveBeenCalled();
    cleanup?.();
  });

  it('swallows polling errors so the interval keeps going', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeToolCall.mockRejectedValue(new Error('boom'));

    useCIPoller('chat-1', 'owner/repo', { currentBranch: 'main' });
    const cleanup = hookState.effects[0]?.fn() as (() => void) | undefined;

    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    expect(hookState.setCiStatus).not.toHaveBeenCalled();
    spy.mockRestore();
    cleanup?.();
  });
});
