/**
 * NativeJgitCheckpointStore — the APK/native CheckpointStore backend (Model 3).
 *
 * Captures the sandbox working tree as a real git tree in an app-private,
 * on-device `git init` repo (a SEPARATE backup dir, never the session's active
 * working copy), keyed by `repoFullName + branch` so checkpoints persist across
 * sandboxes/sessions. See `docs/decisions/Native Checkpoint Store.md`.
 *
 * Data flow (the transport reuses existing sandbox-client primitives):
 *   capture  — build a git-aware archive in the sandbox (`git ls-files | tar`,
 *              .gitignore-respecting + WIP, hard-excludes + size cap) → fetch its
 *              bytes (`downloadFileFromSandbox`) → `NativeGit.commitWorkingTree`
 *              (extract into the worktree, `git add -A`, commit) on the device.
 *   restore  — `NativeGit.archiveCommit` (device tree → tar.gz) → push to the
 *              sandbox (`writeToSandbox`) → a `.git`-PRESERVING, delete-faithful
 *              sync (clear-except-.git + extract) so the clone's origin/branch
 *              survive and the recovered work lands as unstaged changes.
 *   list     — `NativeGit.listCheckpoints` (the on-device `git log`).
 *
 * Native methods (`commitWorkingTree` / `archiveCommit` / `listCheckpoints` /
 * `pruneCheckpoints`) are skeletoned on web and implemented in JGit on Android.
 */

import { execInSandbox, downloadFileFromSandbox, writeToSandbox } from '../sandbox-client';
import { isInvalidGitRef } from '../git-ref-validation';
import { NativeGit } from '../native-git/plugin';
import type { NativeGitPlugin } from '../native-git/definitions';
import type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
  CheckpointDetectInput,
  CheckpointRecord,
  CheckpointRestoreAvailability,
  CheckpointRestoreInput,
  CheckpointRestoreResult,
  CheckpointScope,
  CheckpointStore,
} from './checkpoint-store';

type LogFn = (level: 'info' | 'warn', event: string, ctx: Record<string, unknown>) => void;
const defaultLog: LogFn = (level, event, ctx) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

/** Max checkpoint archive size; a larger working tree is refused, not truncated. */
export const CHECKPOINT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/** Default retention: keep the newest N checkpoints per lane. */
export const CHECKPOINT_RETENTION_KEEP = 50;

const TMP_ARCHIVE = '/tmp/push-checkpoint.tar.gz';
const TMP_RESTORE_B64 = '/tmp/push-checkpoint-restore.b64';

/**
 * Sandbox-side capture: a git-aware archive of the working tree. `git ls-files
 * --cached --others --exclude-standard` is tracked + untracked, .gitignore-
 * respecting, WIP included (`git archive HEAD` would miss untracked WIP); the
 * `:!:` pathspecs hard-exclude heavy build dirs even when a repo fails to
 * gitignore them. Prints `OK <bytes>` or `ERR <stage>` (never fatal).
 */
const CAPTURE_ARCHIVE_COMMAND = [
  `cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }`,
  `rm -f ${TMP_ARCHIVE}`,
  `git ls-files -z --cached --others --exclude-standard \
    ':!:node_modules/**' ':!:dist/**' ':!:build/**' ':!:.next/**' ':!:.cache/**' \
    ':!:coverage/**' ':!:target/**' ':!:.git/**' \
    | tar --null --no-recursion -czf ${TMP_ARCHIVE} -T - 2>/dev/null || { echo "ERR tar"; exit 0; }`,
  `sz=$(stat -c %s ${TMP_ARCHIVE} 2>/dev/null || echo 0)`,
  `echo "OK $sz"`,
].join('\n');

/**
 * Sandbox-side restore sync: decode the uploaded archive, then a `.git`-
 * PRESERVING, delete-faithful replace of the working tree (clear everything under
 * /workspace except `.git`, then extract). Keeps the clone's origin/branch; the
 * recovered files land as unstaged changes. (The snapshot `restore` endpoint
 * can't be reused — it clears `.git` too.)
 */
const RESTORE_SYNC_COMMAND = [
  `cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }`,
  `arc=/tmp/push-checkpoint-restore.tar.gz`,
  `base64 -d ${TMP_RESTORE_B64} > "$arc" 2>/dev/null || { echo "ERR decode"; exit 0; }`,
  `find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + 2>/dev/null || { echo "ERR clear"; exit 0; }`,
  `tar xzf "$arc" -C /workspace 2>/dev/null || { echo "ERR extract"; exit 0; }`,
  `rm -f ${TMP_RESTORE_B64} "$arc"`,
  `echo OK`,
].join('\n');

/** `git status --porcelain` — non-empty means the target tree is dirty. */
const DIRTY_CHECK_COMMAND = `cd /workspace 2>/dev/null && git status --porcelain 2>/dev/null | head -1`;

/** Path-safe segment for the on-device dir (relative → app-private filesDir). */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}

/** App-private on-device checkpoint repo dir for a lane (relative; resolved under filesDir). */
function checkpointDir(scope: CheckpointScope): string {
  return `checkpoints/${sanitizeSegment(scope.repoFullName)}/${sanitizeSegment(scope.branch)}`;
}

export interface NativeCheckpointDeps {
  plugin?: NativeGitPlugin;
  exec?: typeof execInSandbox;
  download?: typeof downloadFileFromSandbox;
  write?: typeof writeToSandbox;
  log?: LogFn;
}

export function createNativeJgitCheckpointStore(deps: NativeCheckpointDeps = {}): CheckpointStore {
  const plugin = deps.plugin ?? NativeGit;
  const exec = deps.exec ?? execInSandbox;
  const download = deps.download ?? downloadFileFromSandbox;
  const write = deps.write ?? writeToSandbox;
  const log = deps.log ?? defaultLog;

  async function listRecords(scope: CheckpointScope): Promise<CheckpointRecord[]> {
    try {
      const { checkpoints } = await plugin.listCheckpoints({ dir: checkpointDir(scope) });
      // The plugin speaks `commitId`; the store's record handle is `checkpointId`.
      return (checkpoints ?? []).map((c) => ({
        checkpointId: c.commitId,
        message: c.message,
        timestampMs: c.timestampMs,
      }));
    } catch {
      return [];
    }
  }

  return {
    kind: 'native-jgit',

    async capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult> {
      if (!input.branch || isInvalidGitRef(input.branch)) {
        return { status: 'skipped', reason: 'invalid_branch' };
      }
      const dir = checkpointDir(input);

      // 1. Build the git-aware archive in the sandbox.
      let bytes: number;
      try {
        const res = await exec(input.sandboxId, CAPTURE_ARCHIVE_COMMAND);
        const out = res.stdout.trim();
        const m = /^OK (\d+)$/m.exec(out);
        if (!m) {
          log('warn', 'native_checkpoint_capture_failed', {
            stage: 'archive',
            out: out.slice(0, 120),
          });
          return { status: 'failed', reason: res.error ?? out ?? 'archive failed' };
        }
        bytes = Number(m[1]);
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
      if (bytes <= 0) return { status: 'clean' };
      if (bytes > CHECKPOINT_ARCHIVE_MAX_BYTES) {
        log('warn', 'native_checkpoint_capture_skipped', { reason: 'too_large', bytes });
        return { status: 'skipped', reason: `archive too large (${bytes} bytes)` };
      }

      // 2. Fetch the bytes to the device.
      const fetched = await download(input.sandboxId, TMP_ARCHIVE);
      if (!fetched.ok || !fetched.fileBase64) {
        return { status: 'failed', reason: fetched.error ?? 'archive download failed' };
      }

      // 3. Extract + commit into the on-device repo.
      try {
        const result = await plugin.commitWorkingTree({
          dir,
          archiveBase64: fetched.fileBase64,
          message: `checkpoint ${new Date().toISOString()}`,
        });
        if (!result.commitId) {
          return { status: 'failed', reason: result.message ?? 'commit failed' };
        }
        // Best-effort retention; never fail the capture on a prune error.
        await plugin.pruneCheckpoints({ dir, keep: CHECKPOINT_RETENTION_KEEP }).catch(() => {});
        log('info', 'native_checkpoint_captured', {
          dir,
          committed: result.committed,
          commitId: result.commitId,
        });
        return result.committed
          ? { status: 'captured', dedupToken: result.commitId }
          : { status: 'unchanged', dedupToken: result.commitId };
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async detectRestore(input: CheckpointDetectInput): Promise<CheckpointRestoreAvailability> {
      if (!input.branch || isInvalidGitRef(input.branch)) {
        return { available: false, reason: 'invalid_branch' };
      }
      const records = await listRecords(input);
      const latest = records[0];
      if (!latest) return { available: false, reason: 'no_checkpoint' };
      return { available: true, checkpointId: latest.checkpointId, summary: latest.message };
    },

    async restore(input: CheckpointRestoreInput): Promise<CheckpointRestoreResult> {
      if (!input.branch || isInvalidGitRef(input.branch)) {
        return { status: 'failed', reason: 'invalid_branch' };
      }
      // Don't clobber live work: refuse on a dirty target tree.
      try {
        const dirty = await exec(input.sandboxId, DIRTY_CHECK_COMMAND);
        if (dirty.stdout.trim().length > 0) return { status: 'skipped-dirty' };
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }

      // 1. Read the checkpoint tree off the device as an archive.
      let archiveBase64: string;
      try {
        const archived = await plugin.archiveCommit({
          dir: checkpointDir(input),
          commitId: input.checkpointId,
        });
        if (!archived.archiveBase64) return { status: 'failed', reason: 'checkpoint not found' };
        archiveBase64 = archived.archiveBase64;
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }

      // 2. Push it into the sandbox and run the .git-preserving sync.
      const wrote = await write(input.sandboxId, TMP_RESTORE_B64, archiveBase64);
      if (!wrote.ok) return { status: 'failed', reason: wrote.error ?? 'upload failed' };
      try {
        const synced = await exec(input.sandboxId, RESTORE_SYNC_COMMAND, undefined, {
          markWorkspaceMutated: true,
        });
        if (synced.stdout.trim() !== 'OK') {
          return {
            status: 'failed',
            reason: synced.error ?? (synced.stdout.trim() || 'sync failed'),
          };
        }
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
      log('info', 'native_checkpoint_restored', { checkpointId: input.checkpointId });
      return { status: 'restored', checkpointId: input.checkpointId };
    },

    list(scope: CheckpointScope): Promise<CheckpointRecord[]> {
      return listRecords(scope);
    },
  };
}

export const nativeJgitCheckpointStore: CheckpointStore = createNativeJgitCheckpointStore();
