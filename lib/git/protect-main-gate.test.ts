import { describe, expect, it } from 'vitest';
import { makeProtectMainPrePushGate } from './protect-main-gate.ts';

type LogLine = { level: string; event: string; ctx: Record<string, unknown> };

function capture() {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (level: string, event: string, ctx: Record<string, unknown>) =>
      lines.push({ level, event, ctx }),
  };
}

describe('makeProtectMainPrePushGate', () => {
  it('skips (passes) when Protect Main is disabled', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: false,
      getCurrentBranch: () => 'main',
      log,
    });
    expect(await gate()).toEqual({ ok: true });
    expect(lines[0].event).toBe('protect_main_push_skipped');
  });

  it('passes a push from a feature branch', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'feature/foo',
      log,
    });
    expect(await gate()).toEqual({ ok: true });
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_clean',
      ctx: { branch: 'feature/foo' },
    });
  });

  it('blocks a push to main', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main',
      log,
    });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('protected branch "main"');
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'protected_branch' },
    });
  });

  it('blocks a push to master', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'master',
      log,
    });
    expect((await gate()).ok).toBe(false);
  });

  it('blocks a push to a non-default-named default branch (e.g. develop)', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'develop',
      getCurrentBranch: () => 'develop',
      log,
    });
    expect((await gate()).ok).toBe(false);
  });

  it('fails closed when the branch cannot be determined (null)', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => null,
      log,
    });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'branch_undetermined' },
    });
  });

  it('fails closed when the branch read throws', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => {
        throw new Error('sandbox gone');
      },
      log,
    });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'branch_unreadable' },
    });
  });

  it('normalizes whitespace so a padded branch name still matches', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => '  main\n',
      log,
    });
    expect((await gate()).ok).toBe(false);
  });
});
