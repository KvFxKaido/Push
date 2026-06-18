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

  // --- refspec destination (Codex P1 on #976) -----------------------------
  // A push refspec destination overrides the checked-out branch, so the gate
  // must inspect the ref target, not just live HEAD.

  it('blocks a refspec push to main even from a feature branch', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'feature/foo', // checked out on a feature branch
      log,
    });
    const verdict = await gate({ ref: 'HEAD:refs/heads/main' });
    expect(verdict.ok).toBe(false);
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'protected_branch', branch: 'main', via: 'refspec' },
    });
  });

  it('blocks a forced refspec push to main (+HEAD:main)', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'feature/foo',
      log,
    });
    expect((await gate({ ref: '+HEAD:main' })).ok).toBe(false);
  });

  it('allows a refspec push to a feature branch', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main', // even checked out on main…
      log,
    });
    // …the push targets a feature branch, so it is allowed.
    expect((await gate({ ref: 'feature/bar' })).ok).toBe(true);
  });

  it('falls back to live HEAD when the ref is HEAD (no explicit destination)', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main',
      log,
    });
    expect((await gate({ ref: 'HEAD' })).ok).toBe(false);
  });

  it('treats @ as HEAD and falls back to live HEAD', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      defaultBranch: 'main',
      getCurrentBranch: () => 'main', // @ → HEAD → current branch is main
      log,
    });
    expect((await gate({ ref: '@' })).ok).toBe(false);
  });

  // --- unverifiable refspecs fail closed (Codex 2nd-pass on #976) ----------
  // A safety gate can't chase every Git form, so anything that doesn't resolve
  // to one safe branch is blocked.

  it('fails closed on the matching refspec ":" (pushes every same-named branch incl. main)', async () => {
    const { lines, log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'feature/foo', // live read says feature, but ":" hits main
      log,
    });
    const verdict = await gate({ ref: ':' });
    expect(verdict.ok).toBe(false);
    expect(lines[0]).toMatchObject({
      event: 'protect_main_push_blocked',
      ctx: { reason: 'ref_unverifiable', detail: 'matching refspec' },
    });
  });

  it('fails closed on a forced matching refspec "+:"', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'feature/foo',
      log,
    });
    expect((await gate({ ref: '+:' })).ok).toBe(false);
  });

  it('fails closed on option-shaped refs (--all / --mirror)', async () => {
    const { log } = capture();
    const gate = makeProtectMainPrePushGate({
      enabled: true,
      getCurrentBranch: () => 'feature/foo',
      log,
    });
    expect((await gate({ ref: '--all' })).ok).toBe(false);
    expect((await gate({ ref: '--mirror' })).ok).toBe(false);
  });
});
