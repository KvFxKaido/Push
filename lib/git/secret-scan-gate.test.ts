import { describe, expect, it, vi } from 'vitest';
import { makeSecretScanPrePushGate } from './secret-scan-gate.ts';

const SECRET_DIFF = ['+++ b/config.ts', '@@ -0,0 +1 @@', `+const k = "AKIAIOSFODNN7EXAMPLE";`].join(
  '\n',
);
const CLEAN_DIFF = ['+++ b/x.ts', '@@ -0,0 +1 @@', '+const x = 1;'].join('\n');

function spyLog() {
  const lines: Array<{ level: string; event: string; ctx: Record<string, unknown> }> = [];
  const log = vi.fn((level: string, event: string, ctx: Record<string, unknown>) => {
    lines.push({ level, event, ctx });
  });
  return { log, lines, events: () => lines.map((l) => l.event) };
}

describe('makeSecretScanPrePushGate', () => {
  it('passes a clean diff and logs secret_scan_clean', async () => {
    const { log, events } = spyLog();
    const gate = makeSecretScanPrePushGate({ getDiff: () => CLEAN_DIFF, log });
    expect(await gate()).toEqual({ ok: true });
    expect(events()).toContain('secret_scan_clean');
  });

  it('blocks a diff with a secret and reports the reason', async () => {
    const { log, events } = spyLog();
    const gate = makeSecretScanPrePushGate({ getDiff: () => SECRET_DIFF, log });
    const verdict = await gate();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('AWS access key ID');
    expect(verdict.reason).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(events()).toContain('secret_scan_blocked');
  });

  it('skips (allows) when disabled, without scanning', async () => {
    const { log, events } = spyLog();
    const getDiff = vi.fn(() => SECRET_DIFF);
    const gate = makeSecretScanPrePushGate({ getDiff, enabled: false, log });
    expect(await gate()).toEqual({ ok: true });
    expect(getDiff).not.toHaveBeenCalled();
    expect(events()).toContain('secret_scan_skipped');
  });

  it('fails open with secret_scan_no_diff when no diff resolves', async () => {
    const { log, events } = spyLog();
    const gate = makeSecretScanPrePushGate({ getDiff: () => null, log });
    expect(await gate()).toEqual({ ok: true });
    expect(events()).toContain('secret_scan_no_diff');
  });

  it('fails open with secret_scan_error when getDiff throws', async () => {
    const { log, events } = spyLog();
    const gate = makeSecretScanPrePushGate({
      getDiff: () => {
        throw new Error('diff read failed');
      },
      log,
    });
    expect(await gate()).toEqual({ ok: true });
    expect(events()).toContain('secret_scan_error');
  });

  it('awaits an async getDiff', async () => {
    const gate = makeSecretScanPrePushGate({
      getDiff: async () => SECRET_DIFF,
      log: () => {},
    });
    expect((await gate()).ok).toBe(false);
  });
});
