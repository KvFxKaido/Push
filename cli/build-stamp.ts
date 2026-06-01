// build-stamp.ts — code-freshness token for the running process.
//
// PROTOCOL_VERSION (lib/protocol-schema.ts) answers "can these two processes
// talk?" — wire compatibility. This module answers a different question the
// daemon model needs: "is this long-lived daemon running the SAME code I am?"
// — code freshness.
//
// The daemon is spawned detached and outlives the client that started it. In a
// hybrid local/remote workflow a `git pull` moves HEAD while a week-old pushd
// keeps serving yesterday's `lib/` behavior under an unchanged PROTOCOL_VERSION.
// The build stamp is what makes that drift observable: the daemon freezes its
// stamp at startup, a freshly-started client computes its own, and a mismatch
// means "the daemon is stale — drain and respawn."

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// Semantic runtime version. Bump on releases. The git short-SHA captured at
// process startup is appended to it to form the freshness token, so two builds
// from the same release but different commits still compare unequal.
export const RUNTIME_VERSION = '0.3.0';

let cached: string | null = null;
let inflight: Promise<string> | null = null;

async function captureGitSha(): Promise<string | null> {
  try {
    // Anchor to THIS module's directory (cli/), not the user's cwd, so the
    // rev-parse resolves the Push repo's HEAD regardless of where `push` was
    // invoked from.
    const cwd = path.dirname(fileURLToPath(import.meta.url));
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd,
      timeout: 2000,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch (err) {
    // Not a git checkout (published install) or git missing — fall back to a
    // version-only stamp. Two such installs are indistinguishable, which is
    // acceptable: a non-git install doesn't shift under you mid-session the
    // way a working tree does. Emit one structured line so an UNEXPECTED nogit
    // (git broken in an environment that should have it) is explainable rather
    // than silent — operators can't otherwise tell it apart from a real
    // published install.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({ level: 'debug', event: 'build_stamp_nogit', reason: message })}\n`,
    );
    return null;
  }
}

/**
 * The freshness token for the *currently running* process, captured once on
 * first call and frozen for the process lifetime.
 *
 * Freezing on first call is the whole point: the daemon calls this at startup,
 * so its stamp reflects the commit it loaded into memory — NOT the repo's
 * current HEAD. A daemon spawned at commit A keeps reporting A even after the
 * working tree advances to B; a client started at B computes B; the mismatch
 * is the stale-runtime signal.
 *
 * Limitation: the stamp tracks committed HEAD, not uncommitted working-tree
 * edits. Editing a file without committing and restarting only one of the two
 * processes will NOT be detected. The target case — `git pull` / commit moving
 * HEAD under a running daemon — is detected precisely.
 *
 * Format: `<RUNTIME_VERSION>+<short-sha>`, or `<RUNTIME_VERSION>+nogit`.
 */
export async function getBuildStamp(): Promise<string> {
  if (cached) return cached;
  if (!inflight) {
    inflight = (async () => {
      const sha = await captureGitSha();
      return `${RUNTIME_VERSION}+${sha ?? 'nogit'}`;
    })();
  }
  cached = await inflight;
  return cached;
}

/**
 * Synchronous read of the already-captured stamp, or null if `getBuildStamp`
 * hasn't resolved yet. For callers that want to avoid awaiting on a hot path
 * after a startup capture has already primed the cache.
 */
export function peekBuildStamp(): string | null {
  return cached;
}

/** Test-only: reset the frozen capture so a fresh stamp can be computed. */
export function __resetBuildStampForTesting(): void {
  cached = null;
  inflight = null;
}
