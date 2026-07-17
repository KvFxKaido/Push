/**
 * lib/git/push-git.ts — the PushGit facade.
 *
 * The single composition point the branch + commit/push tool handlers use for
 * git writes. It wraps a `GitBackend` (typed reads + sanctioned writes) and
 * adds two gate seams: the **PreCommitGate** (a commit may be gated by an
 * injected closure the handler builds over the Auditor) and the
 * **PrePushGate** (a push may be gated by an injected closure the factory
 * builds over the deterministic secret scan). Both gates are injected, so
 * `lib/git/` never imports `auditor-agent` or `secret-scan`.
 *
 * Orchestration is deliberately NOT owned here — the `branchSwitch` / `meta`
 * routing, chat re-scoping, the Auditor delegation itself (provider lock,
 * brief, agent run), the Protect Main pre-hook, sandbox teardown, and
 * run-event emission all stay in the handlers. In the same spirit,
 * `validateActiveBranch` only *verifies* the sandbox-HEAD-vs-tracked-branch
 * invariant and returns a typed diagnostic — the caller (which owns
 * `session.activeBranch`) decides whether a mismatch warns or refuses.
 */

import type { GitBackend, GitWriteResult } from './backend.js';
import type { GitStatusInfo } from './status.js';
import type { RuntimeIntervention } from '../runtime-intervention.js';

export interface PreCommitVerdict {
  ok: boolean;
  /** Surfaced to the caller when blocked (e.g. the Auditor's UNSAFE reason). */
  reason?: string;
}

/** Gate run before a commit; the handler builds it over the Auditor. */
export type PreCommitGate = () => Promise<PreCommitVerdict>;

export interface PrePushVerdict {
  ok: boolean;
  /** Surfaced to the caller when blocked (e.g. the secret scan's findings). */
  reason?: string;
  /**
   * Set by a gate that blocked on transient infra trouble rather than a real
   * policy violation — e.g. the Auditor backend was unreachable, as opposed to
   * returning an UNSAFE verdict. Callers map this to a retryable structured
   * error, never to a terminal "unsafe"/"secret found" surface (the
   * HTTP-status-classification discipline in CLAUDE.md: don't lump infra trouble
   * into the verdict bucket).
   */
  retryable?: boolean;
  runtimeIntervention?: RuntimeIntervention;
}

/** Options accepted by a push — shared by `PushGit.push` and the pre-push gates. */
export interface PushOptions {
  setUpstream?: boolean;
  remote?: string;
  ref?: string;
}

/**
 * Gate run before a push. Receives the push options so a gate can inspect the
 * actual destination — e.g. a `ref` refspec (`HEAD:refs/heads/main`) that
 * targets a different branch than the checked-out one. Gates that only care
 * about the working tree (the secret scan) can ignore the argument.
 */
export type PrePushGate = (opts?: PushOptions) => Promise<PrePushVerdict>;

/**
 * Compose multiple `PrePushGate`s into one. Gates run in order and the first
 * denial wins (short-circuit) — so order them safety-first. The push `opts` are
 * forwarded to every gate. A throw propagates to `PushGit.push`, which
 * fail-safe-blocks. Returns `undefined` when no gate is supplied (so the caller
 * can leave `prePush` unset) and the single gate unwrapped when only one is
 * active.
 */
export function composePrePushGates(
  gates: ReadonlyArray<PrePushGate | undefined>,
): PrePushGate | undefined {
  const active = gates.filter((g): g is PrePushGate => Boolean(g));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return async (opts) => {
    for (const gate of active) {
      const verdict = await gate(opts);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  };
}

export interface PushGitDeps {
  backend: GitBackend;
  preCommit?: PreCommitGate;
  prePush?: PrePushGate;
}

export interface ActiveBranchValidation {
  /** True when the sandbox's HEAD branch matches the expected (tracked) one. */
  inSync: boolean;
  /** The branch the orchestration believes is active (session.activeBranch). */
  expected: string;
  /** The sandbox's actual HEAD branch, or null when detached / unreadable. */
  actual: string | null;
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
  private readonly prePush?: PrePushGate;

  constructor(deps: PushGitDeps) {
    this.backend = deps.backend;
    this.preCommit = deps.preCommit;
    this.prePush = deps.prePush;
  }

  // --- Reads (delegated) ---
  currentBranch(): Promise<string | null> {
    return this.backend.currentBranch();
  }
  upstreamRef(): Promise<string | null> {
    return this.backend.upstreamRef();
  }
  remoteUrl(remote?: string, opts?: { push?: boolean }): Promise<string | null> {
    return this.backend.remoteUrl(remote, opts);
  }
  headSha(opts?: { short?: boolean }): Promise<string | null> {
    return this.backend.headSha(opts);
  }
  status(): Promise<GitStatusInfo | null> {
    return this.backend.status();
  }

  /**
   * Verify the sandbox's HEAD branch matches the branch the orchestration
   * thinks is active. Returns a typed diagnostic and does NOT enforce —
   * `lib/git/` only sees git reality, so the caller (which owns the session /
   * UI context) decides whether a mismatch is a warning or a refusal.
   */
  async validateActiveBranch(expected: string): Promise<ActiveBranchValidation> {
    const actual = await this.backend.currentBranch();
    // `currentBranch()` is already trimmed; normalize the caller's value the
    // same way so stray whitespace can't manufacture a spurious mismatch.
    const normalizedExpected = expected.trim();
    return { inSync: actual === normalizedExpected, expected: normalizedExpected, actual };
  }

  // --- Sanctioned writes ---
  createBranch(name: string, from?: string): Promise<GitWriteResult> {
    return this.backend.createBranch(name, from);
  }
  switchBranch(branch: string): Promise<GitWriteResult> {
    return this.backend.switchBranch(branch);
  }
  /**
   * Run the PrePushGate (if injected) then push. When the gate denies — or
   * throws — the push is not attempted and a blocked `GitWriteResult`
   * (`ok: false, blocked: true`) carries the reason in `stderr`. A throw
   * fail-safe-blocks, mirroring `commit`; the secret-scan gate itself fails
   * *open* on its own infra errors (it can't read the diff), so this catch only
   * trips on an unexpected gate bug.
   *
   * The gate + push run inside one working-copy critical section
   * (`backend.runExclusive`): the gate inspects HEAD / the push diff, so a
   * concurrent executor that commits or switches between gate and push would
   * otherwise ship a HEAD the gate never saw. The inner `backend.push` is told
   * it's `alreadyLocked` so it doesn't re-acquire the (non-reentrant) lock.
   */
  async push(opts?: PushOptions): Promise<GitWriteResult> {
    return this.backend.runExclusive(async () => {
      if (this.prePush) {
        let verdict: PrePushVerdict;
        try {
          // Forward opts so a gate can inspect the real push destination (e.g. a
          // refspec targeting a protected branch), not just the checked-out one.
          verdict = await this.prePush(opts);
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'pre-push gate failed';
          return { ok: false, blocked: true, exitCode: 1, stdout: '', stderr: reason };
        }
        if (!verdict.ok) {
          const reason = verdict.reason ?? 'push blocked by pre-push gate';
          return {
            ok: false,
            blocked: true,
            exitCode: 1,
            stdout: '',
            stderr: reason,
            // Carry the gate's transient/infra signal so the caller can classify a
            // retryable failure (e.g. Auditor unreachable) apart from a terminal
            // policy block (secret found, protected branch).
            ...(verdict.retryable ? { retryable: true } : {}),
            ...(verdict.runtimeIntervention
              ? { runtimeIntervention: verdict.runtimeIntervention }
              : {}),
          };
        }
      }
      return this.backend.push(opts, { alreadyLocked: true });
    });
  }

  /**
   * Run the PreCommitGate (if injected) then commit. When the gate denies,
   * the commit is not attempted and `{ ok: false, blocked: true }` is
   * returned. The two-phase web flow runs the Auditor at the prepare step and
   * commits here without a gate; one-shot callers can inject one.
   *
   * Gate + commit share one working-copy critical section (see `push` above),
   * so a concurrent write can't change the staged tree between the gate's read
   * and the commit; the inner `backend.commit` is told it's `alreadyLocked`.
   */
  async commit(opts: { message: string; addArgs?: string[] }): Promise<PushGitCommitResult> {
    return this.backend.runExclusive(async () => {
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
      const result = await this.backend.commit(
        opts.message,
        { addArgs: opts.addArgs },
        { alreadyLocked: true },
      );
      return { ok: result.ok, blocked: false, result };
    });
  }
}
