/**
 * sandbox-auto-back-restore.ts - B2 "auto-back" restore primitive.
 *
 * Detects a durable `draft/auto/<branch>` backup for a fresh cloud sandbox and
 * restores it on explicit user request. Restore never moves HEAD and refuses to
 * run on a dirty working tree; successful restores leave the recovered changes
 * unstaged in the working tree.
 */

import { autoBackRef } from './sandbox-auto-back';
import { execInSandbox } from './sandbox-client';
import { gitHubAuthCommandPrefix } from './git-backend';
import { isInvalidGitRef } from './git-ref-validation';

export type RestoreAvailability =
  | { available: false; reason?: string }
  | { available: true; sha: string; summary: string; ref: string };

export type RestoreResult =
  | { status: 'restored'; sha: string }
  | { status: 'skipped-dirty' }
  | { status: 'failed'; reason: string };

type LogFn = (level: 'info' | 'warn', event: string, ctx: Record<string, unknown>) => void;
const defaultLog: LogFn = (level, event, ctx) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

function resolveAutoBackRef(
  branch: string | null | undefined,
): { ok: true; branch: string; ref: string } | { ok: false; reason: string; branch?: string } {
  const trimmedBranch = branch?.trim();
  if (!trimmedBranch) return { ok: false, reason: 'no_branch' };
  if (isInvalidGitRef(trimmedBranch)) {
    return { ok: false, reason: 'invalid_branch', branch: trimmedBranch };
  }
  return { ok: true, branch: trimmedBranch, ref: autoBackRef(trimmedBranch) };
}

// Both builders interpolate `ref`/`expectedSha` into a raw shell command. That is
// safe only because `resolveAutoBackRef` rejects anything outside git's
// `[A-Za-z0-9._/-]` ref charset (isInvalidGitRef) and `expectedSha` is a hex
// commit id validated before we get here — no shell metacharacters can reach
// this point. Do NOT call these with unvalidated input. `authPrefix` is the
// shell-escaped `git -c …` GitHub-auth prefix (or '' for public/no-token):
// origin is tokenless after clone (#987), so the fetch must carry transient auth
// to reach a private repo's backup ref.
//
// Correctness note (Codex P1 on #983): the auto-back commit is HEAD-at-capture +
// WIP, so we ONLY offer/apply when the backup's parent still equals the current
// HEAD. If the branch moved since capture (a commit landed — common across
// surfaces), restoring the backup's full tree would make the intervening commits
// show as local reverts. Gating on parent==HEAD makes the read-tree restore
// exactly the WIP diff, with no revert.
function detectCommand(ref: string, authPrefix: string): string {
  return [
    'cd /workspace 2>/dev/null || { echo "ERR"; exit 0; }',
    `git ${authPrefix}fetch --no-tags origin "${ref}" 2>/dev/null || { echo "NONE"; exit 0; }`,
    'backup="$(git rev-parse FETCH_HEAD 2>/dev/null)"; [ -z "$backup" ] && { echo "NONE"; exit 0; }',
    'head="$(git rev-parse HEAD 2>/dev/null)"',
    'head_tree="$(git rev-parse \'HEAD^{tree}\' 2>/dev/null)"',
    'backup_tree="$(git rev-parse "$backup^{tree}" 2>/dev/null)"',
    '[ "$head_tree" = "$backup_tree" ] && { echo "NOCHANGES"; exit 0; }',
    'parent="$(git rev-parse "$backup^" 2>/dev/null)"',
    '[ "$parent" != "$head" ] && { echo "STALEBASE"; exit 0; }',
    'echo "BACKUP $backup"',
    'git diff --shortstat HEAD "$backup" 2>/dev/null',
  ].join('\n');
}

function applyCommand(ref: string, expectedSha: string, authPrefix: string): string {
  return [
    'cd /workspace 2>/dev/null || { echo "ERR"; exit 0; }',
    `git ${authPrefix}fetch --no-tags origin "${ref}" 2>/dev/null || { echo "FETCH_FAILED"; exit 0; }`,
    'backup="$(git rev-parse FETCH_HEAD 2>/dev/null)"; [ -z "$backup" ] && { echo "FETCH_FAILED"; exit 0; }',
    // Pin the detected backup: if the ref was force-updated since detection (a
    // new auto-back), restore nothing rather than the wrong commit. (Codex P1.)
    `[ "$backup" != "${expectedSha}" ] && { echo "CHANGED"; exit 0; }`,
    'head="$(git rev-parse HEAD 2>/dev/null)"',
    'parent="$(git rev-parse "$backup^" 2>/dev/null)"',
    '[ "$parent" != "$head" ] && { echo "STALEBASE"; exit 0; }',
    'if [ -n "$(git status --porcelain --untracked-files=all 2>/dev/null)" ]; then echo "DIRTY"; exit 0; fi',
    'git read-tree -u --reset "$backup" 2>/dev/null || { echo "RESTORE_FAILED"; exit 0; }',
    'git reset --mixed -q HEAD 2>/dev/null',
    'echo "RESTORED $backup"',
  ].join('\n');
}

function outputLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function detectAutoBackRestore(
  sandboxId: string | null,
  branch: string | null | undefined,
  opts?: { log?: LogFn },
): Promise<RestoreAvailability> {
  const log = opts?.log ?? defaultLog;
  if (!sandboxId) {
    log('info', 'auto_back_restore_none', { reason: 'no_sandbox' });
    return { available: false, reason: 'no_sandbox' };
  }
  const resolved = resolveAutoBackRef(branch);
  if (!resolved.ok) {
    log('info', 'auto_back_restore_none', {
      reason: resolved.reason,
      ...(resolved.branch ? { branch: resolved.branch } : {}),
    });
    return { available: false, reason: resolved.reason };
  }

  let stdout: string;
  let execError: string | undefined;
  try {
    const result = await execInSandbox(
      sandboxId,
      detectCommand(resolved.ref, gitHubAuthCommandPrefix()),
    );
    stdout = result.stdout ?? '';
    execError = result.error;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('warn', 'auto_back_restore_failed', {
      branch: resolved.branch,
      ref: resolved.ref,
      reason,
      stage: 'detect',
    });
    return { available: false, reason };
  }

  const lines = outputLines(stdout);
  const first = lines[0] ?? '';
  if (first === 'NONE' || first === 'NOCHANGES' || first === 'ERR' || first === 'STALEBASE') {
    const reason = first === 'STALEBASE' ? 'stale_base' : first.toLowerCase();
    log('info', 'auto_back_restore_none', {
      branch: resolved.branch,
      ref: resolved.ref,
      reason,
    });
    return { available: false, reason };
  }

  const match = /^BACKUP ([0-9a-f]{7,64})$/i.exec(first);
  if (match) {
    const sha = match[1];
    const summary = lines.slice(1).join('\n').trim();
    log('info', 'auto_back_restore_available', {
      branch: resolved.branch,
      ref: resolved.ref,
      sha,
      summary,
    });
    return { available: true, sha, summary, ref: resolved.ref };
  }

  const reason = execError ?? first ?? 'unexpected restore detection output';
  log('warn', 'auto_back_restore_failed', {
    branch: resolved.branch,
    ref: resolved.ref,
    reason,
    stage: 'detect',
  });
  return { available: false, reason };
}

export async function applyAutoBackRestore(
  sandboxId: string | null,
  branch: string | null | undefined,
  expectedSha: string,
  opts?: { log?: LogFn },
): Promise<RestoreResult> {
  const log = opts?.log ?? defaultLog;
  if (!sandboxId) {
    log('warn', 'auto_back_restore_failed', { reason: 'no_sandbox', stage: 'apply' });
    return { status: 'failed', reason: 'no_sandbox' };
  }
  // `expectedSha` is interpolated into the command — accept only a hex commit id
  // (it comes from detection's BACKUP <sha>, but validate defensively).
  if (!/^[0-9a-f]{7,64}$/i.test(expectedSha)) {
    log('warn', 'auto_back_restore_failed', { reason: 'invalid_sha', stage: 'apply' });
    return { status: 'failed', reason: 'invalid_sha' };
  }
  const resolved = resolveAutoBackRef(branch);
  if (!resolved.ok) {
    log('warn', 'auto_back_restore_failed', {
      reason: resolved.reason,
      stage: 'apply',
      ...(resolved.branch ? { branch: resolved.branch } : {}),
    });
    return { status: 'failed', reason: resolved.reason };
  }

  let stdout: string;
  let execError: string | undefined;
  try {
    const result = await execInSandbox(
      sandboxId,
      applyCommand(resolved.ref, expectedSha, gitHubAuthCommandPrefix()),
    );
    stdout = result.stdout ?? '';
    execError = result.error;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('warn', 'auto_back_restore_failed', {
      branch: resolved.branch,
      ref: resolved.ref,
      reason,
      stage: 'apply',
    });
    return { status: 'failed', reason };
  }

  const first = outputLines(stdout)[0] ?? '';
  const restored = /^RESTORED ([0-9a-f]{7,64})$/i.exec(first);
  if (restored) {
    const sha = restored[1];
    log('info', 'auto_back_restore_restored', {
      branch: resolved.branch,
      ref: resolved.ref,
      sha,
    });
    return { status: 'restored', sha };
  }

  if (first === 'DIRTY') {
    log('info', 'auto_back_restore_skipped_dirty', {
      branch: resolved.branch,
      ref: resolved.ref,
    });
    return { status: 'skipped-dirty' };
  }

  // The backup ref moved (CHANGED) or the branch advanced past the backup's base
  // (STALEBASE) between detection and apply — refuse rather than restore the
  // wrong commit or revert newer history.
  if (first === 'CHANGED' || first === 'STALEBASE') {
    const reason = first === 'CHANGED' ? 'backup_changed' : 'stale_base';
    log('warn', 'auto_back_restore_failed', {
      branch: resolved.branch,
      ref: resolved.ref,
      reason,
      stage: 'apply',
    });
    return { status: 'failed', reason };
  }

  const reason = execError ?? first ?? 'unexpected restore output';
  log('warn', 'auto_back_restore_failed', {
    branch: resolved.branch,
    ref: resolved.ref,
    reason,
    stage: 'apply',
  });
  return { status: 'failed', reason };
}
