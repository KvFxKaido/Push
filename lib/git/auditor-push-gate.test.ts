import { describe, expect, it, vi } from 'vitest';
import { makeAuditorPrePushGate, type AuditorPushVerdict } from './auditor-push-gate.ts';

const DIFF = ['+++ b/x.ts', '@@ -0,0 +1 @@', '+const x = 1;'].join('\n');

function spyLog() {
  const lines: Array<{ level: string; event: string; ctx: Record<string, unknown> }> = [];
  const log = vi.fn((level: string, event: string, ctx: Record<string, unknown>) => {
    lines.push({ level, event, ctx });
  });
  return { log, lines, events: () => lines.map((l) => l.event) };
}

const safe = async (): Promise<AuditorPushVerdict> => ({ verdict: 'safe', summary: 'ok' });

describe('makeAuditorPrePushGate', () => {
  it('passes a SAFE verdict and logs auditor_push_clean', async () => {
    const { log, events } = spyLog();
    const gate = makeAuditorPrePushGate({ getDiff: () => DIFF, audit: safe, log });
    expect(await gate()).toEqual({ ok: true });
    expect(events()).toContain('auditor_push_clean');
  });

  it('blocks an UNSAFE verdict with the summary as reason (terminal, not retryable)', async () => {
    const { log, events } = spyLog();
    const gate = makeAuditorPrePushGate({
      getDiff: () => DIFF,
      audit: async () => ({ verdict: 'unsafe', summary: 'hardcoded API key in config.ts' }),
      log,
    });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('hardcoded API key');
    expect(verdict.retryable).toBeUndefined();
    expect(events()).toContain('auditor_push_blocked');
  });

  it('skips (allows) when disabled, without resolving the diff or auditing', async () => {
    const { log, events } = spyLog();
    const getDiff = vi.fn(() => DIFF);
    const audit = vi.fn(safe);
    const gate = makeAuditorPrePushGate({ getDiff, audit, enabled: false, log });
    expect(await gate()).toEqual({ ok: true });
    expect(getDiff).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(events()).toContain('auditor_push_skipped');
  });

  it('allows without auditing when no diff resolves — auditor_push_no_diff', async () => {
    const { log, events } = spyLog();
    const audit = vi.fn(safe);
    const gate = makeAuditorPrePushGate({ getDiff: () => null, audit, log });
    expect(await gate()).toEqual({ ok: true });
    expect(audit).not.toHaveBeenCalled();
    expect(events()).toContain('auditor_push_no_diff');
  });

  it('treats an empty diff as no-diff (nothing ships → allow, no audit)', async () => {
    const { log } = spyLog();
    const audit = vi.fn(safe);
    const gate = makeAuditorPrePushGate({ getDiff: () => '', audit, log });
    expect((await gate()).ok).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it('fails OPEN when the diff read throws (local git infra) — auditor_push_diff_error', async () => {
    const { log, events } = spyLog();
    const audit = vi.fn(safe);
    const gate = makeAuditorPrePushGate({
      getDiff: () => {
        throw new Error('diff read failed');
      },
      audit,
      log,
    });
    expect(await gate()).toEqual({ ok: true });
    expect(audit).not.toHaveBeenCalled();
    expect(events()).toContain('auditor_push_diff_error');
  });

  it('fails CLOSED + retryable when the Auditor backend throws — auditor_push_error', async () => {
    const { log, events } = spyLog();
    const gate = makeAuditorPrePushGate({
      getDiff: () => DIFF,
      audit: async () => {
        throw new Error('provider 503');
      },
      log,
    });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(verdict.retryable).toBe(true);
    expect(verdict.reason).toContain('retry');
    expect(verdict.reason).not.toContain('unsafe');
    expect(events()).toContain('auditor_push_error');
  });

  it('awaits an async getDiff', async () => {
    const gate = makeAuditorPrePushGate({
      getDiff: async () => DIFF,
      audit: async () => ({ verdict: 'unsafe', summary: 'nope' }),
      log: () => {},
    });
    expect((await gate()).ok).toBe(false);
  });

  it('forwards push opts to getDiff (so it can scope to the destination ref)', async () => {
    const getDiff = vi.fn(() => DIFF);
    const gate = makeAuditorPrePushGate({ getDiff, audit: safe, log: () => {} });
    await gate({ ref: 'HEAD:refs/heads/feature' });
    expect(getDiff).toHaveBeenCalledWith({ ref: 'HEAD:refs/heads/feature' });
  });
});
