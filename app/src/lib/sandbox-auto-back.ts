/**
 * sandbox-auto-back.ts — B2 "auto-back" backup primitive.
 *
 * Captures the cloud sandbox's full working tree (tracked + untracked,
 * .gitignore-respecting) into a dangling commit OFF HEAD without switching the
 * active branch or disturbing HEAD / index / working tree, then force-pushes it
 * to a stable per-branch backup ref (`draft/auto/<branch>`). The pushed ref is
 * the durable, portable home for in-progress work: if the sandbox is lost, the
 * work is recoverable by fetching the ref — no dependence on the browser-local
 * snapshot or its reconnect window.
 *
 * This is a WIP/draft push (the doc's "two push flavors", see
 * "Pushed Branch as Source of Truth — Gate at Push" §Move B / B2): it is
 * secret-scanned (never leak a credential to origin, even on a draft ref) but
 * NOT Protect-Main-gated — it targets a draft ref, never the protected branch,
 * and the Protect Main push gate (#976) would otherwise reject the refspec form
 * outright (refspec → unverifiable → fail closed).
 *
 * Non-switching capture uses a throwaway index + `commit-tree`, so the model's
 * HEAD, index, and working tree are untouched — the backup is invisible to the
 * agent's own git state.
 *
 * Web/cloud-sandbox scoped (same scoping as §11): the CLI/daemon has a reliable
 * local filesystem and needs no remote backup.
 *
 * Symmetric structured logs, one per branch (see CLAUDE.md):
 * `auto_back_pushed` ↔ `auto_back_clean` ↔ `auto_back_blocked` ↔
 * `auto_back_skipped` ↔ `auto_back_failed`.
 */

import { makeSecretScanPrePushGate } from '@push/lib/git/secret-scan-gate';
import { execInSandbox } from './sandbox-client';
import { createSandboxPushGit, resolveWebSecretScanEnabled } from './git-backend';
import { isInvalidGitRef } from './git-ref-validation';

/** Stable per-working-branch backup ref. One ref per branch, force-updated. */
export function autoBackRef(branch: string): string {
  return `draft/auto/${branch.trim()}`;
}

export type AutoBackResult =
  | { status: 'skipped'; reason: string }
  | { status: 'clean' }
  | { status: 'backed-up'; ref: string; sha: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string };

type LogFn = (level: 'info' | 'warn', event: string, ctx: Record<string, unknown>) => void;
const defaultLog: LogFn = (level, event, ctx) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

// Non-destructive working-tree capture: stage everything into a throwaway index
// (seeded from HEAD so only *changes* are re-hashed) and `commit-tree` it off
// HEAD. The real HEAD / index / working tree are untouched. `git add -A` always
// includes untracked files regardless of `status.showUntrackedFiles`, and
// "clean" is decided by comparing the snapshot tree to HEAD's tree — NOT by
// `git status` (which can report an untracked-only tree as empty under
// `showUntrackedFiles=no`, and reports failures as empty too; Codex P2 on #980).
// Prints `CLEAN` when the tree matches HEAD, `COMMIT <sha>` on success, or
// `ERR <stage>` on a git failure (kept non-fatal — one bad backup must never
// brick the session).
const CAPTURE_COMMAND = [
  'cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }',
  // Private temp dir (not `mktemp -u`, which races on an unclaimed path); the
  // trap cleans it up on every exit path.
  'tmpdir="$(mktemp -d /tmp/push-autoback.XXXXXX)" || { echo "ERR mktemp"; exit 0; }',
  'trap \'rm -rf "$tmpdir"\' EXIT',
  'idx="$tmpdir/index"',
  'has_head=0',
  'if git rev-parse -q --verify HEAD >/dev/null 2>&1; then',
  '  has_head=1',
  // Every stage is checked: a failed read-tree/add/write-tree must surface as
  // ERR, never fall through. A failed `add -A` on a HEAD-seeded index would
  // otherwise leave the index == HEAD, write-tree == HEAD^{tree}, and the clean
  // check would declare CLEAN while changes exist — silent data loss (Codex P1).
  '  GIT_INDEX_FILE="$idx" git read-tree HEAD 2>/dev/null || { echo "ERR read-tree"; exit 0; }',
  'fi',
  'GIT_INDEX_FILE="$idx" git add -A 2>/dev/null || { echo "ERR add"; exit 0; }',
  'tree="$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)" || { echo "ERR write-tree"; exit 0; }',
  '[ -z "$tree" ] && { echo "ERR write-tree"; exit 0; }',
  'if [ "$has_head" = 1 ]; then',
  '  head_tree="$(git rev-parse "HEAD^{tree}" 2>/dev/null)"',
  // Only declare clean on a confirmed tree match; if HEAD's tree is unreadable,
  // bias toward backing up rather than risking a false-clean.
  '  if [ -n "$head_tree" ] && [ "$tree" = "$head_tree" ]; then echo CLEAN; exit 0; fi',
  '  commit="$(git commit-tree "$tree" -p HEAD -m "push: auto-back WIP" 2>/dev/null)"',
  'else',
  // Unborn HEAD: compute the empty tree for this repo (hash-agnostic, not a
  // hard-coded SHA-1 value).
  '  empty="$(git hash-object -t tree /dev/null 2>/dev/null)"',
  '  if [ -n "$empty" ] && [ "$tree" = "$empty" ]; then echo CLEAN; exit 0; fi',
  '  commit="$(git commit-tree "$tree" -m "push: auto-back WIP" 2>/dev/null)"',
  'fi',
  '[ -z "$commit" ] && { echo "ERR commit-tree"; exit 0; }',
  'echo "COMMIT $commit"',
].join('\n');

/**
 * Back up the sandbox working tree to its stable per-branch draft ref. Pure
 * side-effect of git state on the remote; returns a typed result. Safe to call
 * repeatedly — a clean tree is a no-op, and the ref is force-updated in place.
 */
export async function backUpWorkingTree(
  sandboxId: string | null,
  branch: string | null | undefined,
  opts?: { log?: LogFn },
): Promise<AutoBackResult> {
  const log = opts?.log ?? defaultLog;
  const trimmedBranch = branch?.trim();
  if (!sandboxId) {
    log('info', 'auto_back_skipped', { reason: 'no_sandbox' });
    return { status: 'skipped', reason: 'no_sandbox' };
  }
  if (!trimmedBranch) {
    log('info', 'auto_back_skipped', { reason: 'no_branch' });
    return { status: 'skipped', reason: 'no_branch' };
  }
  // The branch is session-derived (the sandbox's tracked branch), so it's
  // normally a valid ref — but validate before it goes into the push refspec so
  // a malformed/garbage value can't produce a bad ref. (push-agent on #980.)
  if (isInvalidGitRef(trimmedBranch)) {
    log('info', 'auto_back_skipped', { reason: 'invalid_branch', branch: trimmedBranch });
    return { status: 'skipped', reason: 'invalid_branch' };
  }

  // 1. Capture (non-destructive).
  let captureOut: string;
  let captureErr: string | undefined;
  try {
    const capture = await execInSandbox(sandboxId, CAPTURE_COMMAND);
    captureOut = capture.stdout.trim();
    captureErr = capture.error;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('warn', 'auto_back_failed', { reason, stage: 'capture' });
    return { status: 'failed', reason };
  }
  if (captureOut === 'CLEAN') {
    log('info', 'auto_back_clean', { branch: trimmedBranch });
    return { status: 'clean' };
  }
  const match = /^COMMIT ([0-9a-f]{7,40})$/m.exec(captureOut);
  if (!match) {
    const reason = captureErr ?? captureOut ?? 'capture produced no commit';
    log('warn', 'auto_back_failed', { reason, stage: 'capture' });
    return { status: 'failed', reason };
  }
  const sha = match[1];
  const ref = autoBackRef(trimmedBranch);

  // 2. Push the backup commit to the stable per-branch ref (force-update). The
  //    secret scan runs over the backup's content vs HEAD — which covers
  //    untracked files a plain `git diff HEAD` would miss — and the push is NOT
  //    Protect-Main-gated (it targets a draft ref, never the protected branch).
  const pushGit = createSandboxPushGit(sandboxId, {
    prePush: makeSecretScanPrePushGate({
      getDiff: () => diffBackupCommit(sandboxId, sha),
      enabled: resolveWebSecretScanEnabled(),
    }),
  });
  let pushResult: Awaited<ReturnType<typeof pushGit.push>>;
  try {
    pushResult = await pushGit.push({ ref: `+${sha}:refs/heads/${ref}` });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('warn', 'auto_back_failed', { reason, stage: 'push' });
    return { status: 'failed', reason };
  }
  if (!pushResult.ok) {
    if (pushResult.blocked) {
      log('warn', 'auto_back_blocked', { ref, reason: 'secret_scan' });
      return { status: 'blocked', reason: pushResult.stderr || 'secret scan blocked the backup' };
    }
    const reason = pushResult.error || pushResult.stderr || 'push failed';
    log('warn', 'auto_back_failed', { reason, stage: 'push' });
    return { status: 'failed', reason };
  }

  log('info', 'auto_back_pushed', { ref, sha });
  return { status: 'backed-up', ref, sha };
}

/**
 * Diff of the backup commit vs HEAD (or the empty tree when HEAD is unborn) so
 * the secret scan sees untracked file content too. Returns null on a diff-read
 * hiccup; the secret-scan gate treats null as "no diff" and fails open — a
 * read hiccup must not brick durability (same posture as the gate itself).
 */
async function diffBackupCommit(sandboxId: string, sha: string): Promise<string | null> {
  const command = [
    'cd /workspace 2>/dev/null || exit 0',
    'if git rev-parse -q --verify HEAD >/dev/null 2>&1; then base=HEAD; else base="$(git hash-object -t tree /dev/null 2>/dev/null)"; fi',
    // --no-ext-diff so repo config can't substitute an external diff and slip a
    // secret past the scan; sha is hex-validated but quoted regardless.
    `git diff --no-ext-diff --no-color "$base" "${sha}" 2>/dev/null`,
  ].join('\n');
  try {
    const result = await execInSandbox(sandboxId, command);
    return result.stdout ?? null;
  } catch {
    return null;
  }
}
