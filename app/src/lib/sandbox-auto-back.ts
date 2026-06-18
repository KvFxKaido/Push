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

/** Git's canonical empty-tree object — the diff base when HEAD is unborn. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
// (`.gitignore`-respecting via `add -A`) and `commit-tree` it off HEAD. The real
// HEAD / index / working tree are untouched. Prints `CLEAN` when there's nothing
// to back up, `COMMIT <sha>` on success, or `ERR <stage>` on a git failure (kept
// non-fatal — one bad backup must never brick the session).
const CAPTURE_COMMAND = [
  'cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }',
  'if [ -z "$(git status --porcelain 2>/dev/null)" ]; then echo CLEAN; exit 0; fi',
  'idx="$(mktemp -u /tmp/push-autoback.XXXXXX)"',
  'GIT_INDEX_FILE="$idx" git add -A 2>/dev/null',
  'tree="$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)"',
  'rm -f "$idx"',
  '[ -z "$tree" ] && { echo "ERR write-tree"; exit 0; }',
  'if git rev-parse -q --verify HEAD >/dev/null 2>&1; then',
  '  commit="$(git commit-tree "$tree" -p HEAD -m "push: auto-back WIP" 2>/dev/null)"',
  'else',
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
    `if git rev-parse -q --verify HEAD >/dev/null 2>&1; then base=HEAD; else base=${EMPTY_TREE_SHA}; fi`,
    `git diff --no-color "$base" ${sha} 2>/dev/null`,
  ].join('\n');
  try {
    const result = await execInSandbox(sandboxId, command);
    return result.stdout ?? null;
  } catch {
    return null;
  }
}
