/**
 * lib/git/secret-scan-gate.ts — builds a `PrePushGate` over the deterministic
 * secret scanner.
 *
 * Kept out of `push-git.ts` so that facade stays free of any scanner import
 * (the same reason the Auditor `PreCommitGate` is built in the handlers). The
 * gate is diff-source-agnostic: the caller supplies a `getDiff` closure — the
 * web commit/push flow returns the diff already in hand; `auto-branch-on-commit`
 * will return the about-to-be-pushed diff computed from git.
 *
 * Failure posture is deliberately asymmetric:
 *   - A **match** blocks (deterministic + reliable → fail closed).
 *   - **Infra trouble** (no diff resolvable, `getDiff` throws) does NOT block
 *     (fail open + a loud structured log) — a local diff-read hiccup must not
 *     brick every push, the liability the per-commit model-Auditor carries.
 *
 * Symmetric structured logs, one per branch (see CLAUDE.md): `secret_scan_clean`
 * ↔ `secret_scan_blocked` ↔ `secret_scan_skipped` ↔ `secret_scan_no_diff` ↔
 * `secret_scan_error`.
 */

import { scanDiffForSecrets, formatSecretFindings } from '../secret-scan.js';
import type { PrePushGate, PushOptions } from './push-git.js';

type LogLevel = 'info' | 'warn' | 'error';
type LogFn = (level: LogLevel, event: string, ctx: Record<string, unknown>) => void;

const defaultLog: LogFn = (level, event, ctx) => {
  console.log(JSON.stringify({ level, event, ...ctx }));
};

export interface SecretScanPrePushGateOptions {
  /**
   * Resolve the diff to scan. Return `null` when no diff is available (the gate
   * then skips, logging `secret_scan_no_diff`).
   */
  getDiff: (opts?: PushOptions) => Promise<string | null> | string | null;
  /** Whether the scan runs. Defaults to true; pass the resolved policy value. */
  enabled?: boolean;
  /** Injectable for tests; defaults to a JSON-line `console.log`. */
  log?: LogFn;
}

export function makeSecretScanPrePushGate(opts: SecretScanPrePushGateOptions): PrePushGate {
  const { getDiff, enabled = true, log = defaultLog } = opts;
  return async (pushOpts?: PushOptions) => {
    if (!enabled) {
      log('info', 'secret_scan_skipped', { reason: 'disabled' });
      return { ok: true };
    }

    let diff: string | null;
    try {
      diff = await getDiff(pushOpts);
    } catch (err) {
      // Fail open: a diff-read failure is infra, not a detected secret. Blocking
      // here would replicate the model-Auditor's "flaky backend blocks the
      // operation" liability the unbundle is removing.
      log('error', 'secret_scan_error', {
        message: err instanceof Error ? err.message : String(err),
      });
      return { ok: true };
    }

    if (!diff) {
      log('info', 'secret_scan_no_diff', { reason: 'empty-or-unresolved' });
      return { ok: true };
    }

    const findings = scanDiffForSecrets(diff);
    if (findings.length === 0) {
      log('info', 'secret_scan_clean', {});
      return { ok: true };
    }

    log('warn', 'secret_scan_blocked', {
      count: findings.length,
      rules: [...new Set(findings.map((f) => f.ruleId))],
      files: [...new Set(findings.map((f) => f.file).filter(Boolean))],
    });
    return { ok: false, reason: formatSecretFindings(findings) };
  };
}
