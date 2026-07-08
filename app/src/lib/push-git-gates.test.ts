import { describe, expect, it, vi } from 'vitest';
import { buildPushPrePushGate } from './push-git-gates';

describe('buildPushPrePushGate', () => {
  it('blocks when an enabled push gate needs a pushed-diff provider and none was wired', async () => {
    const audit = vi.fn(async () => ({ verdict: 'safe' as const, summary: 'safe' }));
    const gate = buildPushPrePushGate({
      getCurrentBranch: async () => 'feature/native',
      auditAtPush: { enabled: true, audit },
    });

    const verdict = await gate?.();

    expect(verdict).toEqual({
      ok: false,
      reason:
        'Push blocked: pushed-diff provider is unavailable, so enabled push gates cannot inspect this delivery.',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not require a pushed-diff provider for disabled push gates', async () => {
    const audit = vi.fn(async () => ({ verdict: 'safe' as const, summary: 'safe' }));
    const gate = buildPushPrePushGate({
      getCurrentBranch: async () => 'feature/native',
      auditAtPush: { enabled: false, audit },
    });

    await expect(gate?.()).resolves.toEqual({ ok: true });
    expect(audit).not.toHaveBeenCalled();
  });
});
