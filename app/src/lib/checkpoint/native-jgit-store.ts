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
 *   restore  — `NativeGit.archiveCommit` (device tree → ZIP) → push to the
 *              sandbox (`uploadFileToSandbox`, the 12 MB upload route) → a
 *              `.git`-PRESERVING, delete-faithful
 *              sync (clear-except-.git + extract) so the clone's origin/branch
 *              survive and the recovered work lands as unstaged changes.
 *   list     — `NativeGit.listCheckpoints` (the on-device `git log`).
 *
 * Native methods (`commitWorkingTree` / `archiveCommit` / `listCheckpoints` /
 * `pruneCheckpoints`) are skeletoned on web and implemented in JGit on Android.
 */

import { execInSandbox, downloadFileFromSandbox, uploadFileToSandbox } from '../sandbox-client';
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

// The archive lives UNDER /workspace, not /tmp: the download endpoint rejects
// non-/workspace paths ("Path must be within /workspace" — device finding
// 2026-06-22, the Cloudflare sandbox; exec stdout is 500 KB-capped so streaming
// the base64 out isn't an option either). The temp name is added to
// `.git/info/exclude` so it stays invisible to git status / `add -A` / the diff
// view / remote auto-back, and is excluded from the checkpoint archive itself.
const ARCHIVE_NAME = '.push-checkpoint.zip';
const TMP_ARCHIVE = `/workspace/${ARCHIVE_NAME}`;
const RESTORE_UPLOAD_B64 = '/workspace/.push-checkpoint-restore.b64';

/**
 * Sandbox-side capture: a git-aware archive of the working tree. `git ls-files
 * --cached --others --exclude-standard` is tracked + untracked, .gitignore-
 * respecting, WIP included (`git archive HEAD` would miss untracked WIP); the
 * `:!:` pathspecs hard-exclude heavy build dirs even when a repo fails to
 * gitignore them. ZIP (not tar.gz) so the device side extracts with built-in
 * `java.util.zip` — no native tar dependency. Prints `OK <bytes>` or `ERR`.
 */
const CAPTURE_ARCHIVE_COMMAND = [
  `cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }`,
  // Hide the temp archive from all git-based consumers (idempotent).
  `grep -qxF '${ARCHIVE_NAME}' .git/info/exclude 2>/dev/null || echo '${ARCHIVE_NAME}' >> .git/info/exclude 2>/dev/null || true`,
  `rm -f ${ARCHIVE_NAME}`,
  `git ls-files --cached --others --exclude-standard \
    ':!:node_modules/**' ':!:dist/**' ':!:build/**' ':!:.next/**' ':!:.cache/**' \
    ':!:coverage/**' ':!:target/**' ':!:.git/**' ':!:${ARCHIVE_NAME}' \
    | zip -q -@ ${ARCHIVE_NAME} 2>/dev/null`,
  `[ -f ${ARCHIVE_NAME} ] || { echo "ERR zip"; exit 0; }`,
  `sz=$(stat -c %s ${ARCHIVE_NAME} 2>/dev/null || echo 0)`,
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
  `arc=/tmp/push-checkpoint-restore.zip`,
  // Decode to /tmp FIRST — the b64 lives under /workspace and the clear step
  // below would otherwise delete it before extraction.
  `base64 -d ${RESTORE_UPLOAD_B64} > "$arc" 2>/dev/null || { echo "ERR decode"; exit 0; }`,
  `find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + 2>/dev/null || { echo "ERR clear"; exit 0; }`,
  `unzip -o -q "$arc" -d /workspace 2>/dev/null || { echo "ERR extract"; exit 0; }`,
  `rm -f "$arc"`,
  `echo OK`,
].join('\n');

/** `git status --porcelain` — non-empty means the target tree is dirty. */
const DIRTY_CHECK_COMMAND = `cd /workspace 2>/dev/null && git status --porcelain 2>/dev/null | head -1`;

/** Cosmetic, path-safe prefix for the on-device dir (NOT the uniqueness key). */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}

/**
 * FNV-1a 32-bit hex of the EXACT value — the collision-free part of the lane key.
 * Sanitizing alone is lossy (`feat/x`, `feat:x`, `feat_x` all sanitize to
 * `feat_x`), which would point distinct branches at the same on-device repo and
 * restore the wrong work (Codex P1). The hash disambiguates; the sanitized prefix
 * is just for human-readable dirs.
 */
function laneHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function laneSegment(value: string): string {
  return `${sanitizeSegment(value)}-${laneHash(value)}`;
}

/** App-private on-device checkpoint repo dir for a lane (relative; resolved under filesDir). */
function checkpointDir(scope: CheckpointScope): string {
  return `checkpoints/${laneSegment(scope.repoFullName)}/${laneSegment(scope.branch)}`;
}

export interface NativeCheckpointDeps {
  plugin?: NativeGitPlugin;
  exec?: typeof execInSandbox;
  download?: typeof downloadFileFromSandbox;
  upload?: typeof uploadFileToSandbox;
  log?: LogFn;
}

export function createNativeJgitCheckpointStore(deps: NativeCheckpointDeps = {}): CheckpointStore {
  const plugin = deps.plugin ?? NativeGit;
  const exec = deps.exec ?? execInSandbox;
  const download = deps.download ?? downloadFileFromSandbox;
  const upload = deps.upload ?? uploadFileToSandbox;
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
        // Previously silent — an exec throw (e.g. transport/CORS on the
        // localhost-origin build) returned failed with no log.
        const reason = err instanceof Error ? err.message : String(err);
        log('warn', 'native_checkpoint_capture_failed', { stage: 'archive_throw', reason });
        return { status: 'failed', reason };
      }
      if (bytes <= 0) {
        log('info', 'native_checkpoint_capture_clean', { bytes });
        return { status: 'clean' };
      }
      if (bytes > CHECKPOINT_ARCHIVE_MAX_BYTES) {
        log('warn', 'native_checkpoint_capture_skipped', { reason: 'too_large', bytes });
        return { status: 'skipped', reason: `archive too large (${bytes} bytes)` };
      }

      // 2. Fetch the bytes to the device.
      const fetched = await download(input.sandboxId, TMP_ARCHIVE);
      if (!fetched.ok || !fetched.fileBase64) {
        const reason = fetched.error ?? 'archive download failed';
        log('warn', 'native_checkpoint_capture_failed', {
          stage: 'download',
          reason,
          bytes,
          hasBase64: Boolean(fetched.fileBase64),
        });
        return { status: 'failed', reason };
      }

      // 3. Extract + commit into the on-device repo.
      try {
        const result = await plugin.commitWorkingTree({
          dir,
          archiveBase64: fetched.fileBase64,
          message: `checkpoint ${new Date().toISOString()}`,
        });
        if (!result.commitId) {
          log('warn', 'native_checkpoint_capture_failed', {
            stage: 'commit',
            message: result.message ?? null,
          });
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
        const reason = err instanceof Error ? err.message : String(err);
        log('warn', 'native_checkpoint_capture_failed', { stage: 'commit_throw', reason });
        return { status: 'failed', reason };
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

      // 2. Push it into the sandbox and run the .git-preserving sync. The
      // dedicated `upload` route (12 MB body tier) replaces the ~5 MB-capped
      // `write`, so a real ~7 MB checkpoint (~9 MB base64) round-trips.
      const wrote = await upload(input.sandboxId, RESTORE_UPLOAD_B64, archiveBase64);
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
