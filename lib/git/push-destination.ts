import type { GitExec } from './backend.js';
import { pushedDiffSourceFromGitExec, type PushedDiffSource } from './pushed-diff-source.js';

export interface PushDestination {
  /** The local ref whose commits are being pushed. Null for a delete refspec. */
  sourceRef: string | null;
  /** The destination branch short name, or null when it cannot be resolved. */
  branch: string | null;
}

async function destinationBranch(source: PushedDiffSource, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!trimmed || trimmed === 'HEAD') return source.currentBranch();
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length) || null;
  if (trimmed.startsWith('refs/')) return null;
  // These characters cannot appear in a branch name. Treat ref expressions or
  // object ids as source-only unless the caller supplied an explicit dst refspec.
  if (/[~^:]|@\{/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the local source ref and remote branch affected by a `git push` ref.
 * Supports the simple refspecs Push uses (`HEAD`, branch names,
 * `refs/heads/name`, and `src:refs/heads/dst`) without invoking git's mutation
 * machinery.
 */
export async function resolvePushDestination(
  exec: GitExec,
  opts?: { ref?: string },
): Promise<PushDestination> {
  return resolvePushDestinationFromSource(pushedDiffSourceFromGitExec(exec), opts);
}

export async function resolvePushDestinationFromSource(
  source: PushedDiffSource,
  opts?: { ref?: string },
): Promise<PushDestination> {
  const rawRef = opts?.ref?.trim() || 'HEAD';
  const refspec = rawRef.startsWith('+') ? rawRef.slice(1) : rawRef;
  const colon = refspec.indexOf(':');
  const sourcePart = colon === -1 ? refspec : refspec.slice(0, colon);
  const destinationPart = colon === -1 ? refspec : refspec.slice(colon + 1);
  const sourceRef = sourcePart.trim() || null;
  const branch = await destinationBranch(source, destinationPart || sourceRef || '');
  return { sourceRef, branch };
}
