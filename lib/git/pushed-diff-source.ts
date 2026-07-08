import type { GitExec } from './backend.js';

/**
 * Typed read port for the pushed-diff algorithm.
 *
 * Web/CLI adapt this from argv-based `GitExec`; native adapts it from JGit
 * plugin methods. Keeping the destination/base algorithm above this port means
 * the secret scan and Auditor gates do not grow a second, almost-the-same
 * implementation on Android.
 */
export interface PushedDiffSource {
  /** Current branch name, or null when detached/unreadable. */
  currentBranch(): Promise<string | null>;
  /** Resolve/verify a ref; null means the ref is absent or unreadable. */
  verifyRef(ref: string): Promise<string | null>;
  /** Merge-base of two refs, or null when not computable. */
  mergeBase(a: string, b: string): Promise<string | null>;
  /** Per-commit patch series for a rev/range, or null when the read fails. */
  logPatch(range: string): Promise<string | null>;
}

async function read(exec: GitExec, args: string[]): Promise<string | null> {
  const res = await exec(args);
  if (res.exitCode !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

export function pushedDiffSourceFromGitExec(exec: GitExec): PushedDiffSource {
  return {
    currentBranch: () => read(exec, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    verifyRef: (ref) => read(exec, ['rev-parse', '--verify', '--quiet', ref]),
    mergeBase: (a, b) => read(exec, ['merge-base', a, b]),
    async logPatch(range) {
      const res = await exec(['log', '-p', '--no-color', range]);
      if (res.exitCode !== 0) return null;
      return res.stdout;
    },
  };
}
