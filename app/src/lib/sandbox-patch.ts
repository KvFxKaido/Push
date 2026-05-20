/**
 * sandbox-patch — replay engine for persisted `workspace-patch` chat
 * cards (PR 3 of persist-diffs).
 *
 * Single entry point: {@link replayWorkspacePatch}. Pure-ish — takes a
 * sandbox id + card data, returns the new `applyState`. State
 * persistence (mutating the card on the conversation) lives in the
 * `useWorkspacePatchReplay` hook so this module stays testable without
 * React.
 *
 * Decision tree (in order):
 *
 *   1. Pre-flight refusals from card metadata
 *      - `truncated: true` → refused('truncated')
 *      - diff has placeholder binary marker (no `GIT binary patch` section)
 *        → refused('binary-placeholder')
 *
 *   2. Write patch to `/workspace/.git/push-replay.patch` (matching
 *      `useCommitPush.ts`'s convention — inside /workspace because the
 *      sandbox rejects writes outside it; under .git/ so `git add -A`
 *      doesn't pick it up).
 *
 *   3. Reverse-check guard: `git apply --check --reverse <patch>`.
 *      Exit 0 ⇒ patch already applied. Return applied with the
 *      `'already-applied'` note so the UI can tell the difference
 *      from a fresh apply without bumping the schema's apply-state kinds.
 *
 *   4. Compare current `git rev-parse HEAD` with the captured
 *      `card.baseSha`:
 *      - Equal ⇒ direct `git apply --whitespace=nowarn`.
 *      - Not equal ⇒ `git apply --3way --whitespace=nowarn`.
 *
 *   5. Classify exit code & stderr:
 *      - exit 0 ⇒ applied
 *      - direct apply failure ⇒ conflict(stderr)
 *      - 3-way failure with `'with conflicts'` in stderr ⇒ conflict
 *        (Git produced a resolvable conflict with markers)
 *      - any other 3-way failure ⇒ refused('base-mismatch')
 *        (Git could not 3-way the patch — base commit unreachable,
 *        files renamed/deleted, etc.)
 *
 * V1 silent transitions: no toasts, no UI. The hook caller is expected
 * to mutate the card via `setConversations` so the UI in PR 4 can
 * surface state.
 */

import { execInSandbox, writeToSandbox } from './sandbox-client';
import type { WorkspacePatchApplyState, WorkspacePatchCardData } from '@push/lib/protocol-schema';

const REPLAY_PATCH_PATH = '/workspace/.git/push-replay.patch';

/** Cap stderr/stdout copied into `conflict.detail` so a runaway git
 *  error doesn't blow up localStorage. Matches the same magnitude as
 *  the existing recovery-path messages in `useCommitPush.ts`. */
const CONFLICT_DETAIL_MAX = 1000;

/** Sentinel appended by {@link clampConflictDetail} when the conflict
 *  detail was clipped. Exported so the UI renderer
 *  (`WorkspacePatchCard.tsx`) can lift the marker out of the
 *  end-of-string text into a distinct visual line without duplicating
 *  the string literal — drift between the producer and the consumer
 *  would silently break the truncation indicator. */
export const CONFLICT_DETAIL_TRUNCATION_SUFFIX = '\n…[truncated]';

function clampConflictDetail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= CONFLICT_DETAIL_MAX) return trimmed;
  return `${trimmed.slice(0, CONFLICT_DETAIL_MAX)}${CONFLICT_DETAIL_TRUNCATION_SUFFIX}`;
}

/**
 * Detect the placeholder binary marker `git diff` emits when run
 * without `--binary` (e.g. older capture paths). We capture with
 * `--binary` today (see `SANDBOX_DIFF_CAPTURE_COMMAND`), so binary
 * blocks are full `GIT binary patch` sections that `git apply` can
 * replay. A bare `Binary files a/X and b/Y differ` line means the
 * patch is unreplayable regardless of HEAD.
 *
 * Mirrors `useCommitPush.ts:unreplayableDiffReason`.
 */
function hasUnreplayableBinaryPlaceholder(diff: string): boolean {
  // The placeholder is a line "Binary files a/X and b/Y differ". The
  // legit `--binary` form starts with "GIT binary patch" right after
  // the index line. If we see the placeholder text without the GIT
  // binary patch marker, it's unreplayable.
  return diff.includes('\nBinary files ') && !diff.includes('\nGIT binary patch\n');
}

export async function replayWorkspacePatch(
  sandboxId: string,
  card: WorkspacePatchCardData,
): Promise<WorkspacePatchApplyState> {
  // Pre-flight refusals from card metadata only — no sandbox calls yet.
  if (card.truncated) {
    return { kind: 'refused', reason: 'truncated' };
  }
  if (hasUnreplayableBinaryPlaceholder(card.diffBytes)) {
    return { kind: 'refused', reason: 'binary-placeholder' };
  }

  // Stage the patch. A write failure means we can't even attempt apply.
  const writeResult = await writeToSandbox(sandboxId, REPLAY_PATCH_PATH, card.diffBytes);
  if (!writeResult.ok) {
    return {
      kind: 'conflict',
      detail: clampConflictDetail(`Failed to stage patch: ${writeResult.error || 'unknown error'}`),
    };
  }

  // Reverse-check: does the patch reverse cleanly? If yes, the forward
  // direction is already applied — mark terminal without re-applying.
  const reverseResult = await execInSandbox(
    sandboxId,
    `cd /workspace && git apply --check --reverse ${REPLAY_PATCH_PATH}`,
  );
  if (reverseResult.exitCode === 0) {
    return { kind: 'applied', appliedAt: Date.now(), note: 'already-applied' };
  }

  // Compare current HEAD with the captured baseSha to pick the apply mode.
  const headResult = await execInSandbox(sandboxId, 'cd /workspace && git rev-parse HEAD');
  const currentHead = (headResult.stdout || '').trim();

  if (currentHead && currentHead === card.baseSha) {
    const applyResult = await execInSandbox(
      sandboxId,
      `cd /workspace && git apply --whitespace=nowarn ${REPLAY_PATCH_PATH}`,
      undefined,
      { markWorkspaceMutated: true },
    );
    if (applyResult.exitCode === 0) {
      return { kind: 'applied', appliedAt: Date.now() };
    }
    const stderr = applyResult.stderr || applyResult.stdout || 'git apply failed';
    return { kind: 'conflict', detail: clampConflictDetail(stderr) };
  }

  // HEAD differs (or rev-parse failed). Try a 3-way merge.
  const threeWayResult = await execInSandbox(
    sandboxId,
    `cd /workspace && git apply --3way --whitespace=nowarn ${REPLAY_PATCH_PATH}`,
    undefined,
    { markWorkspaceMutated: true },
  );
  if (threeWayResult.exitCode === 0) {
    return { kind: 'applied', appliedAt: Date.now() };
  }

  // Failed 3-way. Two sub-cases:
  //  - Git managed the 3-way merge but produced conflicts ⇒ files have
  //    `<<<<<<<` markers; user can resolve. Classify as `conflict`.
  //  - Git couldn't 3-way at all (base commit unreachable, renames it
  //    can't follow, etc.) ⇒ classify as `refused('base-mismatch')` per
  //    the directive: "failed 3-way as base-mismatch unless Git clearly
  //    produced a resolvable conflict."
  const combined = `${threeWayResult.stderr || ''}\n${threeWayResult.stdout || ''}`;
  if (combined.includes('with conflicts')) {
    return { kind: 'conflict', detail: clampConflictDetail(combined) };
  }
  return { kind: 'refused', reason: 'base-mismatch' };
}
