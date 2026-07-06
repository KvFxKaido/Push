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
import { invalidateWorkspaceSnapshots } from '../sandbox-edit-ops';
import { isInvalidGitRef } from '../git-ref-validation';
import { NativeGit } from '../native-git/plugin';
import type { NativeGitPlugin } from '../native-git/definitions';
import { laneSegment } from '../native-git/lane-key';
import type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
  CheckpointClearResult,
  CheckpointDetectInput,
  CheckpointDropInput,
  CheckpointDropResult,
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
  // `-c core.quotePath=false`: without it git C-quotes non-ASCII paths (e.g. an
  // em-dash → "…\342\200\224…"), and `zip -@` then can't find the file and SILENTLY
  // drops it — so every non-ASCII-named file was missing from checkpoints.
  `git -c core.quotePath=false ls-files --cached --others --exclude-standard \
    ':!:node_modules/**' ':!:dist/**' ':!:build/**' ':!:.next/**' ':!:.cache/**' \
    ':!:coverage/**' ':!:target/**' ':!:.git/**' ':!:.push-checkpoint*' \
    | zip -q -@ ${ARCHIVE_NAME} 2>/dev/null`,
  `[ -f ${ARCHIVE_NAME} ] || { echo "ERR zip"; exit 0; }`,
  `sz=$(stat -c %s ${ARCHIVE_NAME} 2>/dev/null || echo 0)`,
  `echo "OK $sz"`,
].join('\n');

/**
 * Cheap working-tree fingerprint for the capture short-circuit. Stages the same
 * file set the capture archive includes (gitignore-respecting via `add` defaults
 * + the same hard-excludes) into a THROWAWAY index — never the real one — then
 * `git write-tree`, which hashes blob CONTENTS, so the hash changes iff the
 * captured tree's content/structure does. Runs entirely in the sandbox (no
 * mobile data), so a no-change debounce skips the ~7 MB archive download +
 * commit. Prints `OK <sha1>` or `ERR ...`.
 */
const PROBE_TREE_HASH_COMMAND = [
  `cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }`,
  `idx=/tmp/.push-probe-index`,
  `rm -f "$idx"`,
  `GIT_INDEX_FILE="$idx" git add -A -- \
    ':!:node_modules/**' ':!:dist/**' ':!:build/**' ':!:.next/**' ':!:.cache/**' \
    ':!:coverage/**' ':!:target/**' ':!:.git/**' ':!:.push-checkpoint*' 2>/dev/null \
    || { rm -f "$idx"; echo "ERR add"; exit 0; }`,
  `h=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)`,
  `rm -f "$idx"`,
  `[ -n "$h" ] && echo "OK $h" || echo "ERR write-tree"`,
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

// --- Diff transport (capture): manifest-rsync -------------------------------
// See docs/decisions/Native Checkpoint Store.md. The device sends its newest
// checkpoint's content manifest; the sandbox diffs the working tree against it
// and returns ONLY the changed files (+ a deletion list + its current manifest),
// instead of the whole ~7 MB tree. Strictly additive: the orchestration falls
// back to the full-tree path on any anomaly, so a broken delta never breaks
// capture.

/** Where the device uploads its base manifest (`<sha> <path>` lines); git-hidden. */
const BASE_MANIFEST_PATH = '/workspace/.push-checkpoint-base';
/** The delta archive (changed files only) the sandbox writes; git-hidden, downloaded. */
const TMP_DELTA = '/workspace/.push-checkpoint-delta.zip';
/** Base64 of a valid empty ZIP — used when a delta is deletions-only (no changed files). */
const EMPTY_ZIP_B64 = 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==';

/**
 * Sandbox-side delta capture. Reads the device's base manifest from
 * [BASE_MANIFEST_PATH], computes the current working tree's manifest with
 * **raw-bytes** blob hashes (`git hash-object --no-filters`, so filter/EOL config
 * can't make identical content hash differently than the device's JGit blob ids),
 * diffs the two, and emits: `OK <deltaBytes>`, the deletion list, and the full
 * current manifest. The delta ZIP (changed/new files) lands at [TMP_DELTA]. Same
 * file set + hard-excludes as the full capture. Any failure prints `ERR ...` and
 * the caller falls back.
 */
const DELTA_CAPTURE_COMMAND = [
  `cd /workspace 2>/dev/null || { echo "ERR workspace"; exit 0; }`,
  `delta=.push-checkpoint-delta.zip`,
  `base=.push-checkpoint-base`,
  // Keep the delta + base files invisible to git (idempotent).
  `for f in "$delta" "$base"; do grep -qxF "$f" .git/info/exclude 2>/dev/null || echo "$f" >> .git/info/exclude 2>/dev/null; done`,
  `rm -f "$delta"`,
  `[ -f "$base" ] || { echo "ERR nobase"; exit 0; }`,
  // Same captured set + hard-excludes as the full capture/probe. `quotePath=false`
  // so non-ASCII paths (em-dash, …) flow raw to hash-object/zip — must match the
  // full-capture archive's set or every checkpoint with such a file fails verify.
  `git -c core.quotePath=false ls-files --cached --others --exclude-standard \
    ':!:node_modules/**' ':!:dist/**' ':!:build/**' ':!:.next/**' ':!:.cache/**' \
    ':!:coverage/**' ':!:target/**' ':!:.git/**' ':!:.push-checkpoint*' > /tmp/pc-paths 2>/dev/null \
    || { echo "ERR lsfiles"; exit 0; }`,
  // Raw-bytes blob hash per path, in list order; pair back with the path.
  `git hash-object --no-filters --stdin-paths < /tmp/pc-paths > /tmp/pc-hashes 2>/dev/null \
    || { echo "ERR hash"; exit 0; }`,
  `paste -d' ' /tmp/pc-hashes /tmp/pc-paths > /tmp/pc-man`,
  // Diff vs base (lines are "<40 sha> <path>"; path starts at col 42 so spaces survive):
  //   changed/new → stdout (/tmp/pc-changed); deleted (in base, not current) → /tmp/pc-del.
  `rm -f /tmp/pc-del`,
  `awk '
     FNR==NR { base[substr($0,42)]=substr($0,1,40); next }
     { p=substr($0,42); cur[p]=1; if (base[p]!=substr($0,1,40)) print p }
     END { for (p in base) if (!(p in cur)) print p > "/tmp/pc-del" }
   ' "$base" /tmp/pc-man > /tmp/pc-changed`,
  // Only zip when there ARE changed files; a zip FAILURE must error (not look like
  // a deletions-only delta, which would commit a tree missing the changed files).
  `if [ -s /tmp/pc-changed ]; then zip -q -@ "$delta" < /tmp/pc-changed 2>/dev/null || { echo "ERR zip"; exit 0; }; fi`,
  `sz=0; [ -f "$delta" ] && sz=$(stat -c %s "$delta" 2>/dev/null || echo 0)`,
  `echo "OK $sz"`,
  `echo "---DEL---"; [ -f /tmp/pc-del ] && cat /tmp/pc-del`,
  `echo "---MAN---"; cat /tmp/pc-man`,
].join('\n');

/** Serialize a `path → blobSha` manifest to the sandbox's `<sha> <path>` line format. */
function serializeManifest(manifest: Record<string, string>): string {
  return `${Object.entries(manifest)
    .map(([path, sha]) => `${sha} ${path}`)
    .join('\n')}\n`;
}

/** Parse DELTA_CAPTURE_COMMAND stdout. Returns null when it isn't well-formed. */
function parseDeltaCapture(
  stdout: string,
): { bytes: number; deleted: string[]; manifest: Record<string, string> } | null {
  const lines = stdout.split('\n');
  const ok = /^OK (\d+)$/.exec((lines[0] ?? '').trim());
  if (!ok) return null;
  const delIdx = lines.indexOf('---DEL---');
  const manIdx = lines.indexOf('---MAN---');
  if (delIdx < 0 || manIdx < 0 || manIdx < delIdx) return null;
  const deleted = lines.slice(delIdx + 1, manIdx).filter((l) => l.length > 0);
  const manifest: Record<string, string> = {};
  for (const l of lines.slice(manIdx + 1)) {
    // "<40 sha> <path>" — sha is fixed-width, so a path with spaces survives.
    if (l.length < 42) continue;
    const sha = l.slice(0, 40);
    const path = l.slice(41);
    if (/^[0-9a-f]{40}$/.test(sha) && path) manifest[path] = sha;
  }
  return { bytes: Number(ok[1]), deleted, manifest };
}

/** App-private on-device checkpoint repo dir for a lane (relative; resolved under filesDir). */
/** Root of every lane's checkpoint repo — the dir to purge for an all-lanes clear. */
const CHECKPOINT_ROOT = 'checkpoints';

function checkpointDir(scope: CheckpointScope): string {
  return `${CHECKPOINT_ROOT}/${laneSegment(scope.repoFullName)}/${laneSegment(scope.branch)}`;
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

  // The last captured working-tree fingerprint per lane (`checkpointDir`), so a
  // no-change debounce can short-circuit before the mobile-data-heavy archive
  // download. In-memory: a fresh session re-downloads once (no baseline), which
  // is fine. Holds the `dedupToken` too so a probe-skip returns the standing pin.
  const lastCaptureByScope = new Map<string, { treeHash: string; dedupToken: string }>();

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

  /**
   * Incremental DELTA capture (manifest-rsync). Returns a result on success, or
   * null to fall back to the full-tree path. STRICTLY ADDITIVE — every failure
   * mode (no base, malformed output, verify mismatch, any throw) returns null, so
   * a broken delta can never break capture; worst case it just never improves on
   * the full path. On success it commits a checkpoint byte-identical to a full
   * capture while moving only the changed files over mobile data.
   */
  async function tryDeltaCapture(
    input: CheckpointCaptureInput,
    dir: string,
    treeHash: string | null,
  ): Promise<CheckpointCaptureResult | null> {
    // Every fallback logs a `reason` so the path is never silent (which is exactly
    // how a delta that quietly never engages stays invisible). Returns null → the
    // caller runs the proven full capture.
    const bail = (reason: string, extra: Record<string, unknown> = {}): null => {
      log('info', 'native_checkpoint_delta_fallback', { dir, reason, ...extra });
      return null;
    };

    // Base = the newest checkpoint's content manifest (empty → first capture → full).
    let base: Record<string, string>;
    try {
      base = (await plugin.listManifest({ dir })).manifest ?? {};
    } catch (err) {
      return bail('list_manifest_threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (Object.keys(base).length === 0) return bail('no_base');

    // Hand the base to the sandbox (small — hashes, not contents).
    try {
      const up = await upload(input.sandboxId, BASE_MANIFEST_PATH, serializeManifest(base));
      if (!up.ok) return bail('base_upload_failed', { error: up.error ?? null });
    } catch (err) {
      return bail('base_upload_threw', { error: err instanceof Error ? err.message : String(err) });
    }

    // Diff in-sandbox → delta archive + deletions + the sandbox's current manifest.
    let res: Awaited<ReturnType<typeof exec>>;
    try {
      res = await exec(input.sandboxId, DELTA_CAPTURE_COMMAND);
    } catch (err) {
      return bail('delta_exec_threw', { error: err instanceof Error ? err.message : String(err) });
    }
    // A truncated stdout (per-call cap) means a partial manifest — never trust it.
    if (res.truncated) return bail('stdout_truncated');
    const parsed = parseDeltaCapture(res.stdout);
    if (!parsed) return bail('parse_failed', { head: res.stdout.slice(0, 200) });
    if (parsed.bytes > CHECKPOINT_ARCHIVE_MAX_BYTES)
      return bail('too_large', { bytes: parsed.bytes });
    // Nothing changed and nothing deleted: the probe normally catches this.
    if (parsed.bytes <= 0 && parsed.deleted.length === 0) {
      return bail('empty_delta', { baseCount: Object.keys(base).length });
    }

    // Fetch only the changed bytes (an empty ZIP when the delta is deletions-only).
    let deltaBase64 = EMPTY_ZIP_B64;
    if (parsed.bytes > 0) {
      let dl: Awaited<ReturnType<typeof download>>;
      try {
        dl = await download(input.sandboxId, TMP_DELTA);
      } catch (err) {
        return bail('delta_download_threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!dl.ok || !dl.fileBase64)
        return bail('delta_download_failed', { error: dl.error ?? null });
      deltaBase64 = dl.fileBase64;
    }

    // Apply + commit on-device. commitDelta verifies the applied tree against the
    // sandbox manifest BEFORE publishing a ref, so an unverified checkpoint never
    // lands: `committed` → captured; `!committed` + a commitId → de-duped to the
    // newest checkpoint (unchanged); a null commitId (no base / verify failed /
    // threw) → fall back to a full capture, which resets the worktree.
    let result: { committed: boolean; commitId: string | null };
    try {
      result = await plugin.commitDelta({
        dir,
        deltaArchiveBase64: deltaBase64,
        deletedPaths: parsed.deleted,
        expectedManifest: parsed.manifest,
        message: `checkpoint ${new Date().toISOString()}`,
      });
    } catch (err) {
      return bail('commit_delta_threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!result.commitId) {
      return bail('verify_failed_or_no_base', { deltaBytes: parsed.bytes });
    }
    const commitId = result.commitId;

    await plugin.pruneCheckpoints({ dir, keep: CHECKPOINT_RETENTION_KEEP }).catch(() => {});
    if (treeHash) lastCaptureByScope.set(dir, { treeHash, dedupToken: commitId });
    if (!result.committed) return { status: 'unchanged', dedupToken: commitId };
    log('info', 'native_checkpoint_captured_delta', {
      dir,
      commitId,
      deltaBytes: parsed.bytes,
      deleted: parsed.deleted.length,
    });
    return { status: 'captured', dedupToken: commitId };
  }

  return {
    kind: 'native-jgit',

    async capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult> {
      if (!input.branch || isInvalidGitRef(input.branch)) {
        return { status: 'skipped', reason: 'invalid_branch' };
      }
      const dir = checkpointDir(input);

      // 0. Cheap tree-hash probe FIRST: if the working tree is byte-identical to
      //    the last capture, skip the whole archive → download → commit path
      //    (the ~7 MB download is the mobile-data cost). Probe failure is
      //    non-fatal — fall through to the full capture.
      let treeHash: string | null = null;
      try {
        const probe = await exec(input.sandboxId, PROBE_TREE_HASH_COMMAND);
        const pm = /^OK ([0-9a-f]{40})$/m.exec(probe.stdout.trim());
        if (pm) {
          treeHash = pm[1];
          const last = lastCaptureByScope.get(dir);
          if (last && last.treeHash === treeHash) {
            log('info', 'native_checkpoint_capture_unchanged_probe', { dir });
            return { status: 'unchanged', dedupToken: last.dedupToken };
          }
        }
      } catch (err) {
        log('info', 'native_checkpoint_probe_skipped', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // 0b. Incremental DELTA capture (manifest-rsync) — move only the changed
      //     files instead of the whole ~7 MB tree. STRICTLY ADDITIVE: the whole
      //     attempt is guarded, so any anomaly OR throw (e.g. an upload/exec
      //     transport failure) falls through to the proven full-tree path below;
      //     it can't break capture. Only reached when the tree changed.
      try {
        const delta = await tryDeltaCapture(input, dir, treeHash);
        if (delta) return delta;
      } catch (err) {
        log('info', 'native_checkpoint_delta_skipped', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // 1. Build the git-aware archive in the sandbox (full-tree fallback path).
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
        // Remember this tree so the next debounce can probe-skip. Only when the
        // probe produced a hash this round (a probe failure leaves no baseline,
        // forcing the next capture down the full path — fail-safe).
        if (treeHash) lastCaptureByScope.set(dir, { treeHash, dedupToken: result.commitId });
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
      // The sync is destructive — it clears /workspace, then extracts the
      // checkpoint. Once it's DISPATCHED the working tree can be mutated on ANY
      // outcome (OK, not-OK, or a thrown/lost response), so every post-dispatch
      // path must drop the derived client caches keyed on the old tree:
      // file-version cache (optimistic-concurrency on edits), prefetched-edit
      // cache, and the symbol + file-awareness ledgers. A partial/failed sync
      // leaves a tree that is neither the old tree nor the checkpoint, so serving
      // cached old versions/symbols against it is the same staleness bug as the
      // success case — over-invalidation on failure is cheap (caches rebuild on
      // next read). The earlier returns (invalid branch, missing checkpoint,
      // failed upload) bail BEFORE the sync, so the tree is untouched and they
      // skip this. `markWorkspaceMutated` only wakes the auto-back listener; it
      // does not clear these caches. Revision is left untouched (0 on the CF
      // backend; the provider-agnostic mutation signal is the real "where we are").
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
      } finally {
        invalidateWorkspaceSnapshots(input.sandboxId);
      }
      log('info', 'native_checkpoint_restored', { checkpointId: input.checkpointId });
      return { status: 'restored', checkpointId: input.checkpointId };
    },

    list(scope: CheckpointScope): Promise<CheckpointRecord[]> {
      return listRecords(scope);
    },

    async drop(input: CheckpointDropInput): Promise<CheckpointDropResult> {
      try {
        const { dropped } = await plugin.dropCheckpoint({
          dir: checkpointDir(input),
          commitId: input.checkpointId,
        });
        log('info', 'native_checkpoint_dropped', {
          checkpointId: input.checkpointId,
          dropped,
        });
        return dropped ? { status: 'dropped' } : { status: 'not-found' };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log('warn', 'native_checkpoint_drop_failed', { checkpointId: input.checkpointId, reason });
        return { status: 'failed', reason };
      }
    },

    async clear(
      scope: CheckpointScope,
      options?: { allLanes?: boolean },
    ): Promise<CheckpointClearResult> {
      const allLanes = Boolean(options?.allLanes);
      // All-lanes deletes the whole `checkpoints` root (every repo + branch); a
      // single clear deletes just this lane's dir. The native side deletes the dir
      // outright, so nothing is recoverable.
      const dir = allLanes ? CHECKPOINT_ROOT : checkpointDir(scope);
      try {
        const { cleared } = await plugin.clearCheckpoints({ dir });
        log('info', 'native_checkpoints_cleared', { allLanes, cleared });
        return cleared ? { status: 'cleared' } : { status: 'noop' };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log('warn', 'native_checkpoints_clear_failed', { allLanes, reason });
        return { status: 'failed', reason };
      }
    },
  };
}

export const nativeJgitCheckpointStore: CheckpointStore = createNativeJgitCheckpointStore();
