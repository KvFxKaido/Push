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

  // --- explicit ref destination + refspec rejection (Codex P1 on #976) ------
  // A safety gate must not emulate Git's refspec parser. Plain branch tokens are
  // checked as the destination; anything carrying a colon / rev syntax / option
  // flag fails closed.

  it('blocks an explicit plain-token push to main even from a feature branch', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'feature/foo', // checked out on a feature branch
      log,
    });
    const verdict = await gate({ ref: 'main' });
    expect(verdict.ok).toBe(false);
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'protected_branch', branch: 'main', via: 'explicit_ref' },
    });
  });

  it('blocks the branch abbreviations Git DWIMs to main (refs/heads/main, heads/main)', async () => {
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'feature/foo',
      log: () => {},
    });
    expect((await gate({ ref: 'refs/heads/main' })).ok).toBe(false);
    expect((await gate({ ref: 'heads/main' })).ok).toBe(false);
  });

  it('allows a feature branch that merely ends in "main" (feature/main)', async () => {
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main',
      log: () => {},
    });
    // `feature/main` is a distinct branch, not the protected `main`.
    expect((await gate({ ref: 'feature/main' })).ok).toBe(true);
  });

  it('allows an explicit feature-branch token', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main', // even checked out on main…
      log,
    });
    // …the push targets a feature branch token, so it is allowed.
    expect((await gate({ ref: 'feature/bar' })).ok).toBe(true);
  });

  it('falls back to live HEAD for HEAD / @ (no explicit destination)', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main',
      log,
    });
    expect((await gate({ ref: 'HEAD' })).ok).toBe(false);
    expect((await gate({ ref: '@' })).ok).toBe(false);
  });

  // Refspecs / rev syntax fail closed — the gate refuses to guess the
  // destination. Covers the bypass vectors from successive Codex passes.
  it.each([
    ['HEAD:refs/heads/main', 'src:dst refspec'],
    ['+HEAD:main', 'forced refspec'],
    [':', 'matching refspec'],
    ['+:', 'forced matching refspec'],
    [':/fix:refs/heads/main', 'commit-search rev + dst (multi-colon)'],
    [':refs/heads/main', 'delete refspec'],
    ['--all', 'option-shaped'],
    ['--mirror', 'option-shaped'],
    ['main~1', 'rev syntax'],
    ['ma*n', 'glob'],
  ])('fails closed on %s (%s)', async (ref) => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'feature/foo', // live read is safe; the ref is not
      log,
    });
    const verdict = await gate({ ref });
    expect(verdict.ok).toBe(false);
    expect(lines[0].event).toBe('protect_main_push_blocked');
  });
});
