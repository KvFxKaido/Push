/**
 * lib/git/push-git.ts — the PushGit facade.
 *
 * The single composition point the branch + commit/push tool handlers use for
 * git writes. It wraps a `GitBackend` (typed reads + sanctioned writes) and
 * adds the **PreCommitGate seam**: a commit may be gated by an injected
 * closure (the handler builds it over the Auditor), so `lib/git/` never
 * imports `auditor-agent`.
 *
 * Orchestration is deliberately NOT owned here — the `branchSwitch` / `meta`
 * routing, chat re-scoping, the Auditor delegation itself (provider lock,
 * brief, agent run), the Protect Main pre-hook, sandbox teardown, and
 * run-event emission all stay in the handlers. (A sandbox-HEAD-vs-session
 * desync validator also belongs to this facade per the design, but is left to
 * a follow-up: it needs the orchestration layer to supply
 * `session.activeBranch`, which this layer doesn't see.)
 */

import type { GitBackend, GitWriteResult } from './backend.js';
import type { GitStatusInfo } from './status.js';

export interface PreCommitVerdict {
  ok: boolean;
  /** Surfaced to the caller when blocked (e.g. the Auditor's UNSAFE reason). */
  reason?: string;
}

/** Gate run before a commit; the handler builds it over the Auditor. */
export type PreCommitGate = () => Promise<PreCommitVerdict>;

export interface PushGitDeps {
  backend: GitBackend;
  preCommit?: PreCommitGate;
}

export interface PushGitCommitResult {
  /** True when the commit ran and succeeded. */
  ok: boolean;
  /** True when the PreCommitGate denied the commit (it never ran). */
  blocked: boolean;
  reason?: string;
  /** Present whenever the commit was actually attempted. */
  result?: GitWriteResult;
}

export class PushGit {
  private readonly backend: GitBackend;
  private readonly preCommit?: PreCommitGate;

  constructor(deps: PushGitDeps) {
    this.backend = deps.backend;
    this.preCommit = deps.preCommit;
  }

  // --- Reads (delegated) ---
  currentBranch(): Promise<string | null> {
    return this.backend.currentBranch();
  }
  headSha(opts?: { short?: boolean }): Promise<string | null> {
    return this.backend.headSha(opts);
  }
  status(): Promise<GitStatusInfo | null> {
    return this.backend.status();
  }

  // --- Sanctioned writes ---
  createBranch(name: string, from?: string): Promise<GitWriteResult> {
    return this.backend.createBranch(name, from);
  }
  switchBranch(branch: string): Promise<GitWriteResult> {
    return this.backend.switchBranch(branch);
  }
  push(opts?: { setUpstream?: boolean; remote?: string; ref?: string }): Promise<GitWriteResult> {
    return this.backend.push(opts);
  }

  /**
   * Run the PreCommitGate (if injected) then commit. When the gate denies,
   * the commit is not attempted and `{ ok: false, blocked: true }` is
   * returned. The two-phase web flow runs the Auditor at the prepare step and
   * commits here without a gate; one-shot callers can inject one.
   */
  async commit(opts: { message: string; addArgs?: string[] }): Promise<PushGitCommitResult> {
    if (this.preCommit) {
      let verdict: PreCommitVerdict;
      try {
        verdict = await this.preCommit();
      } catch (err) {
        // Fail safe: a gate that throws blocks the commit, mirroring the
        // Auditor's default-to-UNSAFE-on-error stance — never commit when the
        // gate couldn't render a verdict.
        return {
          ok: false,
          blocked: true,
          reason: err instanceof Error ? err.message : 'pre-commit gate failed',
        };
      }
      if (!verdict.ok) return { ok: false, blocked: true, reason: verdict.reason };
    }
    const result = await this.backend.commit(opts.message, { addArgs: opts.addArgs });
    return { ok: result.ok, blocked: false, result };
  }
}
