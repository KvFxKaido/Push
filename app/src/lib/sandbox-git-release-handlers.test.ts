/**
 * Handler-level characterization tests for `sandbox-git-release-handlers.ts`.
 *
 * Mirrors the verification-family pattern in
 * `sandbox-verification-handlers.test.ts` — each test constructs a fully-
 * mocked `GitReleaseHandlerContext` and exercises one handler in isolation,
 * decoupled from the dispatcher's mock setup. Coexists with the
 * dispatcher-level tests in `sandbox-tools.test.ts` (which provide
 * integration coverage of `buildGitReleaseContext` wiring); see PR #324
 * for the dispatcher-level layer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the auto-branch-off-main fork from `handleSandboxCommit` without
// touching real git: the real `ensureCommitTargetBranch` forks via the
// module-level `execInSandbox` (a real fetch in tests). The proposer is a
// passthrough so the handler's `createModelCommitBranchNameProposer(...)` call
// doesn't reach a provider.
const { ensureCommitTargetBranchMock } = vi.hoisted(() => ({
  ensureCommitTargetBranchMock: vi.fn(
    (): Promise<import('./ensure-commit-target-branch').EnsureCommitTargetBranchResult> =>
      Promise.resolve({ switched: false }),
  ),
}));
vi.mock('./ensure-commit-target-branch', async (importActual) => {
  const actual = await importActual<typeof import('./ensure-commit-target-branch')>();
  return {
    ...actual,
    ensureCommitTargetBranch: ensureCommitTargetBranchMock,
    createModelCommitBranchNameProposer: vi.fn(() => async () => null),
  };
});

import {
  handleSandboxCommit,
  handlePreparePush,
  handlePromoteToGithub,
  handleSandboxDiff,
  handleShowCommit,
  handleSandboxPush,
  handleSaveDraft,
  type GitReleaseHandlerContext,
} from './sandbox-git-release-handlers';
import type { DiffResult, ExecResult, FileReadResult } from './sandbox-client';
import type { CreatedRepoResponse } from './sandbox-tool-utils';
import { onWorkspaceMutation } from './sandbox-mutation-signal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

const fail = (stdout = '', stderr = '', exitCode = 1): ExecResult => ({
  stdout,
  stderr,
  exitCode,
  truncated: false,
});

type ExecArgs = Parameters<GitReleaseHandlerContext['execInSandbox']>;
type DiffArgs = Parameters<GitReleaseHandlerContext['getSandboxDiff']>;
type ReadArgs = Parameters<GitReleaseHandlerContext['readFromSandbox']>;
type RunAuditorReturn = Awaited<ReturnType<GitReleaseHandlerContext['runAuditor']>>;

// `ReturnType<typeof vi.fn>` resolves to a generic Mock that vitest 4 no
// longer considers assignable to specific function signatures. Type each
// mock as the production signature directly — the mock's runtime behavior
// is unchanged, only the static shape is being satisfied.
interface MockedContext extends GitReleaseHandlerContext {
  execCalls: ExecArgs[];
  diffCalls: DiffArgs[];
  readCalls: ReadArgs[];
  runAuditor: GitReleaseHandlerContext['runAuditor'];
  fetchAuditorFileContexts: GitReleaseHandlerContext['fetchAuditorFileContexts'];
  createGitHubRepo: GitReleaseHandlerContext['createGitHubRepo'];
  getActiveGitHubToken: GitReleaseHandlerContext['getActiveGitHubToken'];
  clearFileVersionCache: GitReleaseHandlerContext['clearFileVersionCache'];
  clearPrefetchedEditFileCache: GitReleaseHandlerContext['clearPrefetchedEditFileCache'];
}

interface MakeContextOpts {
  execResults?: ExecResult[];
  diffResults?: DiffResult[];
  readResults?: (FileReadResult | null)[];
  auditorVerdict?: RunAuditorReturn;
  authToken?: string;
  createdRepo?: CreatedRepoResponse;
  /** The diff the pre-push secret scan (`computePushedDiff`) sees, if any. */
  pushedDiff?: string;
}

const makeCreatedRepo = (overrides: Partial<CreatedRepoResponse> = {}): CreatedRepoResponse => ({
  id: 42,
  name: 'my-repo',
  full_name: 'myuser/my-repo',
  private: true,
  default_branch: 'main',
  html_url: 'https://github.com/myuser/my-repo',
  owner: { login: 'myuser' },
  ...overrides,
});

function makeContext(opts: MakeContextOpts = {}): MockedContext {
  const execCalls: ExecArgs[] = [];
  const diffCalls: DiffArgs[] = [];
  const readCalls: ReadArgs[] = [];
  const execQueue = [...(opts.execResults ?? [])];
  const diffQueue = [...(opts.diffResults ?? [])];
  const readQueue = [...(opts.readResults ?? [])];

  const ctx: MockedContext = {
    sandboxId: 'sb-1',
    execCalls,
    diffCalls,
    readCalls,
    execInSandbox: vi.fn(async (...args: ExecArgs) => {
      // Absorb pre-push `computePushedDiff` reads — transparent to both the
      // positional execResults queue AND `execCalls`, so handlers' command
      // sequences and counts are unaffected. These commands are the hidden
      // destination-base probe plus the final `git log -p`; everything else
      // (incl. the real `git 'push'`) is recorded and draws from the queue.
      const cmd = String(args[1]);
      if (cmd.includes("'symbolic-ref' '--quiet' '--short' 'HEAD'")) return ok('main');
      // Base is resolved through the fully-qualified remote-tracking ref
      // (refs/remotes/<remote>/...), never the bare `origin/...` shorthand.
      if (/ 'rev-parse' '--verify' '--quiet' 'refs\/remotes\/[^']+'/.test(cmd)) {
        return ok('origin/main');
      }
      // The new-branch fork-point probe (merge-base of a remote-tracking ref
      // with the source ref); scoped so it can't swallow the push plan's
      // `merge-base --is-ancestor`.
      if (/ 'merge-base' 'refs\/remotes\/[^']+' '[^']+'/.test(cmd)) {
        return ok('forkbase');
      }
      if (/ 'log' '-p' '--no-color'/.test(cmd)) return ok(opts.pushedDiff ?? '');
      execCalls.push(args);
      return execQueue.shift() ?? ok();
    }),
    getSandboxDiff: vi.fn(async (...args: DiffArgs) => {
      diffCalls.push(args);
      return diffQueue.shift() ?? ({ diff: '', truncated: false } as DiffResult);
    }),
    readFromSandbox: vi.fn(async (...args: ReadArgs) => {
      readCalls.push(args);
      const next = readQueue.shift();
      return next ?? ({ content: '', truncated: false } as FileReadResult);
    }),
    runAuditor: vi.fn(async () => opts.auditorVerdict ?? safeAuditorVerdict()),
    fetchAuditorFileContexts: vi.fn(async () => []),
    createGitHubRepo: vi.fn(async () => opts.createdRepo ?? makeCreatedRepo()),
    getActiveGitHubToken: vi.fn(() => opts.authToken ?? 'gho_token'),
    clearFileVersionCache: vi.fn(),
    clearPrefetchedEditFileCache: vi.fn(),
  };
  return ctx;
}

const safeAuditorVerdict = (): RunAuditorReturn => ({
  verdict: 'safe',
  card: { verdict: 'safe', summary: 'No issues.', risks: [], filesReviewed: 1 },
});

const unsafeAuditorVerdict = (): RunAuditorReturn => ({
  verdict: 'unsafe',
  card: {
    verdict: 'unsafe',
    summary: 'Looks dangerous.',
    risks: [{ level: 'high', description: 'arbitrary exec' }],
    filesReviewed: 1,
  },
});

// ---------------------------------------------------------------------------
// handleSandboxDiff
// ---------------------------------------------------------------------------

describe('handleSandboxDiff', () => {
  it('returns a structured error when getSandboxDiff fails', async () => {
    const ctx = makeContext({ diffResults: [{ diff: '', truncated: false, error: 'boom' }] });
    const result = await handleSandboxDiff(ctx);
    expect(ctx.diffCalls[0]).toEqual(['sb-1']);
    expect(result.text).toContain('[Tool Error — sandbox_diff]');
    expect(result.text).toContain('boom');
    expect(result.structuredError).toBeDefined();
  });

  it('returns the clean-tree message when diff and git_status are both empty', async () => {
    const ctx = makeContext({ diffResults: [{ diff: '', truncated: false }] });
    const result = await handleSandboxDiff(ctx);
    expect(result.text).toContain('No changes detected.');
    expect(result.text).toContain('The working tree is clean.');
    expect(result.card).toBeUndefined();
  });

  it('includes git status output when no diff but git_status is present', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: '', truncated: false, git_status: ' M foo.ts' }],
    });
    const result = await handleSandboxDiff(ctx);
    expect(result.text).toContain('git status output:');
    expect(result.text).toContain(' M foo.ts');
    expect(result.text).not.toContain('The working tree is clean.');
  });

  it('returns a diff-preview card with parsed stats for a populated diff', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+a\n-b\n';
    const ctx = makeContext({ diffResults: [{ diff, truncated: false }] });
    const result = await handleSandboxDiff(ctx);
    expect(result.text).toContain('1 file changed, +1 -1');
    expect(result.card?.type).toBe('diff-preview');
    if (result.card?.type === 'diff-preview') {
      expect(result.card.data).toEqual({
        diff,
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        truncated: false,
      });
    }
  });
});

describe('handleShowCommit', () => {
  const DIFF = [
    'commit 0ee94b7',
    'diff --git a/app/src/lib/app.ts b/app/src/lib/app.ts',
    '--- a/app/src/lib/app.ts',
    '+++ b/app/src/lib/app.ts',
    '@@ -1 +1 @@',
    '-const x = 1;',
    '+const x = 2;',
  ].join('\n');

  it('runs a read-only `git show` for the ref and returns a diff-preview card', async () => {
    const ctx = makeContext({ execResults: [ok(DIFF)] });
    const result = await handleShowCommit(ctx, { ref: 'HEAD' });

    // The ref is single-quoted; read-only safety flags disable repo-configured
    // external diff / textconv drivers; no working-tree mutation flag.
    const cmd = String(ctx.execCalls[0][1]);
    expect(cmd).toContain('git --no-pager show --no-color');
    expect(cmd).toContain('--no-ext-diff');
    expect(cmd).toContain('--no-textconv');
    expect(cmd).toContain("'HEAD'");
    expect(result.text).toContain('[Tool Result — sandbox_show_commit]');
    expect(result.text).toContain('1 file changed, +1 -1');
    expect(result.card?.type).toBe('diff-preview');
  });

  it('scopes to paths after `--` and quotes each', async () => {
    const ctx = makeContext({ execResults: [ok(DIFF)] });
    await handleShowCommit(ctx, { ref: 'main~2', paths: ['app/src/lib/app.ts', 'lib/x.ts'] });
    const cmd = String(ctx.execCalls[0][1]);
    expect(cmd).toContain("'main~2' -- 'app/src/lib/app.ts' 'lib/x.ts'");
  });

  it('passes --stat and omits the diff card in stat mode', async () => {
    const ctx = makeContext({ execResults: [ok(' app.ts | 2 +-\n 1 file changed')] });
    const result = await handleShowCommit(ctx, { ref: 'HEAD', stat: true });
    expect(String(ctx.execCalls[0][1])).toContain('--no-textconv --stat');
    expect(result.card).toBeUndefined();
  });

  it('surfaces a structured error when the ref does not resolve', async () => {
    const ctx = makeContext({
      execResults: [fail('', "fatal: bad revision 'nope'", 128)],
    });
    const result = await handleShowCommit(ctx, { ref: 'nope' });
    expect(result.structuredError).toBeDefined();
    expect(result.text).toContain('[Tool Error — sandbox_show_commit]');
    expect(result.text).toContain('bad revision');
  });

  it('reports an empty diff distinctly from an error', async () => {
    const ctx = makeContext({ execResults: [ok('   ')] });
    const result = await handleShowCommit(ctx, { ref: 'HEAD', paths: ['untouched.ts'] });
    expect(result.structuredError).toBeUndefined();
    expect(result.text).toContain('(no output');
  });

  it('truncates very large output', async () => {
    const big = `${DIFF}\n${'+x'.repeat(40_000)}`;
    const ctx = makeContext({ execResults: [ok(big)] });
    const result = await handleShowCommit(ctx, { ref: 'HEAD' });
    expect(result.text).toContain('(truncated to');
  });
});

// ---------------------------------------------------------------------------
// handlePrepareCommit
// ---------------------------------------------------------------------------

describe('handleSandboxCommit', () => {
  it('returns a structured error when the initial getSandboxDiff fails', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: '', truncated: false, error: 'diff failed' }],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('[Tool Error — sandbox_commit]');
    expect(result.text).toContain('diff failed');
    expect(ctx.execInSandbox).not.toHaveBeenCalled();
    expect(ctx.runAuditor).not.toHaveBeenCalled();
  });

  it('returns nothing-to-commit text when the initial diff is empty (with git_status)', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: '', truncated: false, git_status: ' M x.ts' }],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('Nothing to commit.');
    expect(result.text).toContain('git status shows:  M x.ts');
    expect(result.card).toBeUndefined();
  });

  it('returns nothing-to-commit text with the clean-tree hint when there is no git_status', async () => {
    const ctx = makeContext({ diffResults: [{ diff: '', truncated: false }] });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('Nothing to commit.');
    expect(result.text).toContain('Working tree is clean.');
    expect(result.card).toBeUndefined();
  });

  it('blocks (no card) when the pre-commit hook fails', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+x\n', truncated: false }],
      execResults: [fail('lint failed', 'src/x.ts:1 error', 1)],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('Commit BLOCKED by pre-commit hook');
    // Silent commit: no card emitted, and the Auditor never runs at commit time.
    expect(result.card).toBeUndefined();
    expect(ctx.runAuditor).not.toHaveBeenCalled();
    expect(ctx.execCalls[0][3]).toEqual({ markWorkspaceMutated: true });
  });

  it('returns a structured error when the post-hook getSandboxDiff fails', async () => {
    const ctx = makeContext({
      diffResults: [
        { diff: 'diff --git a/x.ts b/x.ts\n+x\n', truncated: false },
        { diff: '', truncated: false, error: 'post-hook failed' },
      ],
      execResults: [ok()],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('[Tool Error — sandbox_commit]');
    expect(result.text).toContain('post-hook failed');
  });

  it('returns post-hook nothing-to-commit text when the hook clears the diff', async () => {
    const ctx = makeContext({
      diffResults: [
        { diff: 'diff --git a/x.ts b/x.ts\n+x\n', truncated: false },
        { diff: '', truncated: false, git_status: '' },
      ],
      execResults: [ok('formatter rewrote files')],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('Nothing to commit after running the pre-commit hook.');
    expect(result.text).toContain('pre-commit output:');
    expect(result.text).toContain('formatter rewrote files');
  });

  it('commits silently (no card, no Auditor) on the happy path', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+ok\n';
    const ctx = makeContext({
      diffResults: [
        { diff, truncated: false },
        { diff, truncated: false },
      ],
      // [0] = pre-commit hook, [1] = git add -A, [2] = git commit (backend).
      execResults: [ok('hook ran'), ok(), ok('[branch abc123] chore: add greeting')],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: add greeting' });
    expect(result.text).toContain('Committed: "chore: add greeting"');
    expect(result.text).toContain('Use prepare_push to ship.');
    // Silent: no review card and the Auditor never ran at commit time.
    expect(result.card).toBeUndefined();
    expect(ctx.runAuditor).not.toHaveBeenCalled();
    // The pre-commit hook ran at /workspace before the commit.
    expect(ctx.execCalls[0][1]).toContain('.git/hooks/pre-commit');
    expect(ctx.execCalls[0][2]).toBe('/workspace');
    // The backend committed via a real `git commit` (not sandbox_exec).
    expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'commit'"))).toBe(true);
  });

  it('commits a brand-new untracked file instead of short-circuiting (#1075)', async () => {
    // `git diff HEAD` is empty for a brand-new file; the porcelain `??` entry is
    // the only signal. The gate must proceed and the backend's `add -A` stages it.
    const untrackedDiff =
      'diff --git a/dev/null b/docs/new.md\n' +
      '--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+hello\n';
    const ctx = makeContext({
      diffResults: [
        { diff: '', truncated: false, git_status: '?? docs/new.md' },
        { diff: '', truncated: false, git_status: '?? docs/new.md' },
      ],
      // [0] pre-commit hook, [1] collectUntrackedDiff (new-file diff),
      // [2] git add -A, [3] git commit (backend).
      execResults: [ok('hook ran'), ok(untrackedDiff), ok(), ok('[branch abc123] add doc')],
    });
    const result = await handleSandboxCommit(ctx, { message: 'docs: add new doc' });
    expect(result.text).toContain('Committed: "docs: add new doc"');
    // Stats come from the synthesized untracked diff, not the empty `git diff HEAD`.
    expect(result.text).toContain('1 file, +1 -0');
    // The backend actually committed (reached `git commit`, not the empty path).
    expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'commit'"))).toBe(true);
    // The untracked-diff probe is read-only (no markWorkspaceMutated flag) and
    // disables repo-configured diff helpers so it can't trigger a side effect.
    const untrackedProbe = ctx.execCalls.find((c) => String(c[1]).includes('--no-index'));
    expect(untrackedProbe).toBeDefined();
    expect(untrackedProbe?.[3]).toBeUndefined();
    expect(String(untrackedProbe?.[1])).toContain('--no-ext-diff');
    expect(String(untrackedProbe?.[1])).toContain('--no-textconv');
  });

  it('returns a structured error when the backend commit fails', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+ok\n';
    const ctx = makeContext({
      diffResults: [
        { diff, truncated: false },
        { diff, truncated: false },
      ],
      // [0] hook ok, [1] git add -A ok, [2] git commit FAILS.
      execResults: [ok('hook ran'), ok(), fail('', 'nothing staged', 1)],
    });
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('[Tool Error — sandbox_commit]');
    expect(result.structuredError).toBeDefined();
    expect(result.card).toBeUndefined();
  });

  it('signals auto-back when the backend commit fails after the hook path (#982)', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+ok\n';
    const ctx = makeContext({
      diffResults: [
        { diff, truncated: false },
        { diff, truncated: false },
      ],
      execResults: [ok('hook ran'), ok(), fail('', 'pre-commit rejected rewritten files', 1)],
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await handleSandboxCommit(ctx, { message: 'chore: x' });
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  it('auto-forks off the default branch and emits a branchSwitch before committing', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+ok\n';
    // currentBranch === defaultBranch → ensureCommitTargetBranch forks. The
    // mock returns a deterministic branchSwitch so no real git is touched.
    const branchSwitch = { name: 'feat/x', kind: 'forked' as const };
    ensureCommitTargetBranchMock.mockResolvedValueOnce({
      switched: true as const,
      branch: 'feat/x',
      branchSwitch,
    });
    const ctx = makeContext({
      diffResults: [
        { diff, truncated: false },
        { diff, truncated: false },
      ],
      execResults: [ok('hook ran'), ok(), ok('[feat/x abc123] chore: x')],
    });
    ctx.currentBranch = 'main';
    ctx.defaultBranch = 'main';
    const result = await handleSandboxCommit(ctx, { message: 'chore: x' });
    expect(result.text).toContain('Committed:');
    // The fork-off-main path stamps a branchSwitch payload (forked) and notes it.
    expect(result.branchSwitch).toEqual(branchSwitch);
    expect(result.text).toContain('Forked off the default branch first.');
    expect(result.card).toBeUndefined();
  });

  it('refuses on a protected branch when the commit did not fork off main (fail-closed)', async () => {
    // Tracked branch is a feature branch, but the live HEAD reads back as main
    // (desync). ensureCommitTargetBranch returns switched:false (not on the
    // default per the tracked branch), so the in-handler fail-closed Protect
    // Main check must read the LIVE branch and block — the shared pre-hook no
    // longer matches sandbox_commit.
    const ctx = makeContext({
      diffResults: [
        { diff: 'diff --git a/x b/x\n+a', truncated: false },
        { diff: 'diff --git a/x b/x\n+a', truncated: false },
      ],
      execResults: [ok(''), ok('main')], // [pre-commit hook, live branch read]
    });
    ctx.isMainProtected = true;
    ctx.currentBranch = 'feature/x';
    ctx.defaultBranch = 'main';
    const result = await handleSandboxCommit(ctx, { message: 'wip' });
    expect(result.structuredError?.type).toBe('PROTECT_MAIN_BLOCKED');
    expect(ctx.execCalls.some((c) => /'commit'/.test(String(c[1])))).toBe(false);
  });
});

describe('handlePreparePush', () => {
  const cleanDiff = '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;';

  it('returns a nothing-to-push message when the cumulative diff is empty', async () => {
    const ctx = makeContext({ pushedDiff: '' });
    const result = await handlePreparePush(ctx);
    expect(result.text).toContain('Nothing to push');
    expect(result.card).toBeUndefined();
    expect(ctx.runAuditor).not.toHaveBeenCalled();
  });

  it('returns a push-kind commit-review card on a SAFE Auditor verdict', async () => {
    const ctx = makeContext({ pushedDiff: cleanDiff, auditorVerdict: safeAuditorVerdict() });
    const result = await handlePreparePush(ctx);
    expect(ctx.runAuditor).toHaveBeenCalledWith(
      cleanDiff,
      expect.any(Function),
      expect.objectContaining({ source: 'sandbox-push' }),
      undefined,
      expect.any(Object),
      expect.any(Array),
    );
    expect(result.card?.type).toBe('commit-review');
    if (result.card?.type === 'commit-review') {
      expect(result.card.data.kind).toBe('push');
      expect(result.card.data.status).toBe('pending');
      expect(result.card.data.diff.diff).toBe(cleanDiff);
      expect(result.card.data.auditVerdict.verdict).toBe('safe');
      expect(result.card.data.commitMessage).toBe('');
    }
    expect(result.text).toContain('Work has landed locally');
    expect(result.text).toContain('awaiting user approval');
    expect(result.text).toContain('SAFE');
  });

  it('pins the audited HEAD sha and destination on the push-kind card (staleness guard)', async () => {
    const ctx = makeContext({
      pushedDiff: cleanDiff,
      auditorVerdict: safeAuditorVerdict(),
      execResults: [
        ok('abc1234'), // the HEAD-sha read (git rev-parse)
        ok('feature/work'), // the branch read
        ok('origin/feature/work'), // the upstream read
        ok('https://github.com/owner/repo.git'), // the remote-url read
      ],
    });
    const result = await handlePreparePush(ctx);
    expect(result.card?.type).toBe('commit-review');
    if (result.card?.type === 'commit-review') {
      expect(result.card.data.auditedHeadSha).toBe('abc1234');
      expect(result.card.data.auditedBranch).toBe('feature/work');
      expect(result.card.data.auditedUpstream).toBe('origin/feature/work');
      expect(result.card.data.auditedRemoteUrl).toBe('https://github.com/owner/repo.git');
    }
  });

  it('pins the force-with-lease tip and a fast-forward plan summary on the SAFE card', async () => {
    const ctx = makeContext({
      pushedDiff: cleanDiff,
      auditorVerdict: safeAuditorVerdict(),
      execResults: [
        // 4 pins: HEAD sha, branch, upstream, remote-url.
        ok('abc1234'),
        ok('feature/work'),
        ok('origin/feature/work'),
        ok('https://github.com/owner/repo.git'),
        // push plan: rev-parse, ls-remote, merge-base (ancestor → FF), rev-list.
        ok('localsha'),
        ok('remotesha\trefs/heads/feature/work'),
        ok(''), // merge-base --is-ancestor exit 0 → fast-forward
        ok('0\t3'), // behind 0, ahead 3
      ],
    });
    const result = await handlePreparePush(ctx);
    expect(result.card?.type).toBe('commit-review');
    if (result.card?.type === 'commit-review') {
      expect(result.card.data.auditedRemoteTipSha).toBe('remotesha');
      expect(result.card.data.pushPlan?.kind).toBe('fast-forward');
      expect(result.card.data.pushPlan?.ahead).toBe(3);
    }
  });

  it('blocks a diverged push (force-with-lease) before auditing', async () => {
    const ctx = makeContext({
      pushedDiff: cleanDiff,
      auditorVerdict: safeAuditorVerdict(),
      execResults: [
        // 4 pins.
        ok('abc1234'),
        ok('feature/work'),
        ok('origin/feature/work'),
        ok('https://github.com/owner/repo.git'),
        // push plan: rev-parse, ls-remote, merge-base (NOT ancestor), rev-list.
        ok('localsha'),
        ok('remotesha\trefs/heads/feature/work'),
        fail('', '', 1), // merge-base --is-ancestor exit 1 → diverged
        ok('2\t4'), // behind 2, ahead 4
      ],
    });
    const result = await handlePreparePush(ctx);
    expect(result.text).toContain('Push BLOCKED');
    expect(result.text).toContain('force-push');
    expect(result.card).toBeUndefined();
    // The expensive Auditor must not run for a push that can't ship anyway.
    expect(ctx.runAuditor).not.toHaveBeenCalled();
  });

  it('returns an audit-verdict card and blocks on an UNSAFE verdict', async () => {
    const ctx = makeContext({ pushedDiff: cleanDiff, auditorVerdict: unsafeAuditorVerdict() });
    const result = await handlePreparePush(ctx);
    expect(result.text).toContain('Push BLOCKED by Auditor:');
    expect(result.text).toContain('Looks dangerous.');
    expect(result.card?.type).toBe('audit-verdict');
    if (result.card?.type === 'audit-verdict') {
      expect(result.card.data.verdict).toBe('unsafe');
    }
  });

  it('returns retryable AUDITOR_UNAVAILABLE when the Auditor backend throws', async () => {
    const ctx = makeContext({ pushedDiff: cleanDiff });
    ctx.runAuditor = vi.fn(async () => {
      throw new Error('provider 503');
    });
    const result = await handlePreparePush(ctx);
    expect(result.structuredError?.type).toBe('AUDITOR_UNAVAILABLE');
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.card).toBeUndefined();
  });

  it('threads provider/model overrides through to the Auditor call', async () => {
    const ctx = makeContext({ pushedDiff: cleanDiff, auditorVerdict: safeAuditorVerdict() });
    await handlePreparePush(ctx, {
      providerOverride: 'vertex',
      modelOverride: 'google/gemini-2.5-pro',
    });
    expect(ctx.runAuditor).toHaveBeenCalledWith(
      cleanDiff,
      expect.any(Function),
      expect.objectContaining({ source: 'sandbox-push' }),
      undefined,
      expect.objectContaining({
        providerOverride: 'vertex',
        modelOverride: 'google/gemini-2.5-pro',
      }),
      expect.any(Array),
    );
  });
});

// ---------------------------------------------------------------------------
// handleSandboxPush
// ---------------------------------------------------------------------------

describe('handleSandboxPush', () => {
  it('reports success and threads markWorkspaceMutated on the push exec', async () => {
    const ctx = makeContext({ execResults: [ok('Everything up-to-date')] });
    const result = await handleSandboxPush(ctx);
    // The real push is the last exec (the secret scan's reads precede it).
    expect(ctx.execCalls.at(-1)).toEqual([
      'sb-1',
      "git 'push' 'origin' 'HEAD'",
      undefined,
      { markWorkspaceMutated: true, suppressWorkspaceMutationSignal: true },
    ]);
    expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
    expect(result.card).toBeUndefined();
  });

  it('blocks the push when the secret scan finds a credential in the pushed commits', async () => {
    const secretDiff = ['+++ b/c.ts', '@@ -0,0 +1 @@', '+const k = "AKIAIOSFODNN7EXAMPLE";'].join(
      '\n',
    );
    const ctx = makeContext({ pushedDiff: secretDiff });
    const result = await handleSandboxPush(ctx);
    expect(result.structuredError?.type).toBe('GIT_GUARD_BLOCKED');
    expect(result.text).toContain('AWS access key ID');
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // The actual git push was never issued.
    expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'push'"))).toBe(false);
  });

  it('reports failure with stderr when the push exec fails', async () => {
    const ctx = makeContext({ execResults: [fail('', 'fatal: permission denied', 128)] });
    const result = await handleSandboxPush(ctx);
    expect(result.text).toContain('Push failed: fatal: permission denied');
    expect(result.card).toBeUndefined();
  });

  it('classifies an unreachable sandbox (exit -1) as SANDBOX_UNREACHABLE', async () => {
    const ctx = makeContext({ execResults: [fail('', 'Sandbox not found', -1)] });
    const result = await handleSandboxPush(ctx);
    expect(result.structuredError?.type).toBe('SANDBOX_UNREACHABLE');
    expect(result.text).toContain('[Tool Error — sandbox_push]');
  });

  it('runs the Auditor by default (Gate-at-Push Move A flipped ON)', async () => {
    const cleanDiff = '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;';
    const ctx = makeContext({ pushedDiff: cleanDiff, execResults: [ok()] });
    const result = await handleSandboxPush(ctx);
    // Default ON now: the push-time Auditor runs over the cumulative diff.
    expect(ctx.runAuditor).toHaveBeenCalled();
    expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
  });

  it('does not run the Auditor when the gate is explicitly disabled', async () => {
    const cleanDiff = '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;';
    vi.stubEnv('VITE_PUSH_AUDIT_AT_PUSH', '0');
    try {
      const ctx = makeContext({ pushedDiff: cleanDiff, execResults: [ok()] });
      const result = await handleSandboxPush(ctx);
      expect(ctx.runAuditor).not.toHaveBeenCalled();
      expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('with the Auditor-at-push gate enabled', () => {
    const cleanDiff = '+++ b/x.ts\n@@ -0,0 +1 @@\n+const x = 1;';
    beforeEach(() => {
      vi.stubEnv('VITE_PUSH_AUDIT_AT_PUSH', '1');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('audits the cumulative pushed diff (source sandbox-push) and pushes on SAFE', async () => {
      const ctx = makeContext({ pushedDiff: cleanDiff, execResults: [ok()] });
      const result = await handleSandboxPush(ctx);
      expect(ctx.runAuditor).toHaveBeenCalledWith(
        cleanDiff,
        expect.any(Function),
        expect.objectContaining({ source: 'sandbox-push' }),
        undefined,
        expect.any(Object),
        expect.any(Array),
      );
      expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
      expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'push'"))).toBe(true);
    });

    it('blocks the push on an UNSAFE verdict and surfaces the summary', async () => {
      const ctx = makeContext({ pushedDiff: cleanDiff, auditorVerdict: unsafeAuditorVerdict() });
      const result = await handleSandboxPush(ctx);
      expect(result.structuredError?.type).toBe('GIT_GUARD_BLOCKED');
      expect(result.structuredError?.retryable).toBe(false);
      expect(result.text).toContain('Looks dangerous.');
      expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'push'"))).toBe(false);
    });

    it('returns retryable AUDITOR_UNAVAILABLE when the Auditor backend throws', async () => {
      const ctx = makeContext({ pushedDiff: cleanDiff });
      ctx.runAuditor = vi.fn(async () => {
        throw new Error('provider 503');
      });
      const result = await handleSandboxPush(ctx);
      expect(result.structuredError?.type).toBe('AUDITOR_UNAVAILABLE');
      expect(result.structuredError?.retryable).toBe(true);
      expect(result.text).toContain('retry');
      expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'push'"))).toBe(false);
    });

    it('skips the Auditor when there is nothing new to push (empty cumulative diff)', async () => {
      const ctx = makeContext({ pushedDiff: '', execResults: [ok()] });
      const result = await handleSandboxPush(ctx);
      expect(ctx.runAuditor).not.toHaveBeenCalled();
      expect(result.text).toBe('[Tool Result — sandbox_push]\nPushed successfully.');
    });
  });
});

// ---------------------------------------------------------------------------
// handlePromoteToGithub
// ---------------------------------------------------------------------------

describe('handlePromoteToGithub', () => {
  it('rejects an empty repo_name after stripping an owner/ prefix', async () => {
    const ctx = makeContext();
    const result = await handlePromoteToGithub(ctx, { repo_name: 'myuser/' });
    expect(result.text).toBe('[Tool Error] promote_to_github requires a valid repo_name.');
    expect(ctx.createGitHubRepo).not.toHaveBeenCalled();
    expect(ctx.execInSandbox).not.toHaveBeenCalled();
  });

  it('strips the owner/ prefix and passes the trailing name plus private=true default', async () => {
    const ctx = makeContext({
      execResults: [ok('main'), ok(), ok()],
    });
    await handlePromoteToGithub(ctx, { repo_name: 'otheruser/my-repo', description: 'test' });
    expect(ctx.createGitHubRepo).toHaveBeenCalledWith('my-repo', 'test', true);
  });

  it('returns auth-missing error when getActiveGitHubToken returns empty', async () => {
    const ctx = makeContext({ authToken: '' });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo' });
    expect(result.text).toContain('GitHub auth token missing after repo creation.');
    expect(ctx.execInSandbox).not.toHaveBeenCalled();
  });

  it('reports a remote-config failure with the auth token sanitized out', async () => {
    const ctx = makeContext({
      authToken: 'gho_secret',
      execResults: [ok('main'), fail('', 'fatal: failed with token gho_secret', 1)],
    });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo' });
    expect(result.text).toContain('failed to configure git remote');
    expect(result.text).not.toContain('gho_secret');
    expect(result.text).toContain('***');
  });

  it('reports a non-no-commits push failure with sanitized stderr and no promotion', async () => {
    const ctx = makeContext({
      authToken: 'gho_secret',
      execResults: [
        ok('main'),
        ok(),
        fail('', 'fatal: unable to access token gho_secret (403)', 128),
      ],
    });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo' });
    expect(result.text).toContain('push failed');
    expect(result.text).not.toContain('gho_secret');
    expect(result.promotion).toBeUndefined();
  });

  it('reports a warning and returns pushed=false on the no-commits-yet path', async () => {
    const ctx = makeContext({
      execResults: [ok('main'), ok(), fail('', 'error: src refspec main does not match any', 1)],
    });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo' });
    expect(result.text).toContain('Warning:');
    expect(result.text).toContain('no local commits to push yet');
    expect(result.promotion?.pushed).toBe(false);
    expect(result.promotion?.warning).toBeDefined();
  });

  it('returns the full promotion shape and sets markWorkspaceMutated on the push exec', async () => {
    const ctx = makeContext({
      createdRepo: makeCreatedRepo({
        private: false,
        html_url: 'https://github.com/myuser/my-repo',
      }),
      execResults: [ok('main'), ok(), ok()],
    });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo', private: false });
    expect(result.text).toContain('Repository created: myuser/my-repo');
    expect(result.text).toContain('Visibility: public');
    expect(result.text).toContain('Push: successful on branch main');
    const remoteConfigCall = ctx.execCalls.find((call) =>
      String(call[1]).includes('remote get-url origin'),
    );
    expect(String(remoteConfigCall?.[1])).toContain('https://github.com/myuser/my-repo.git');
    expect(String(remoteConfigCall?.[1])).not.toContain('x-access-token');
    // Final exec is the git push — it mutates git/cache state but suppresses
    // the auto-back observer to avoid draft-push feedback loops (#982). The
    // GitHub token is injected as a transient extraheader, not persisted in the
    // remote URL (#987).
    expect(ctx.execCalls.at(-1)).toEqual([
      'sb-1',
      expect.stringMatching(
        /git '-c' 'http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic [^']+' 'push' '-u' 'origin'/,
      ),
      undefined,
      { markWorkspaceMutated: true, suppressWorkspaceMutationSignal: true },
    ]);
    expect(result.promotion).toEqual({
      repo: {
        id: 42,
        name: 'my-repo',
        full_name: 'myuser/my-repo',
        owner: 'myuser',
        default_branch: 'main',
        private: false,
      },
      pushed: true,
      warning: undefined,
      htmlUrl: 'https://github.com/myuser/my-repo',
    });
  });

  it('blocks the first publish when the scan finds a secret, without leaking it', async () => {
    const secretDiff = ['+++ b/.env', '@@ -0,0 +1 @@', '+AWS=AKIAIOSFODNN7EXAMPLE'].join('\n');
    const ctx = makeContext({
      authToken: 'gho_secret',
      pushedDiff: secretDiff,
      execResults: [ok('main'), ok()], // branch-detect, remote-config; push never issued
    });
    const result = await handlePromoteToGithub(ctx, { repo_name: 'my-repo' });
    expect(result.text).toContain('was created, but the push was blocked');
    expect(result.text).toContain('AWS access key ID');
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.text).not.toContain('gho_secret');
    expect(result.promotion).toBeUndefined();
    expect(ctx.execCalls.some((c) => String(c[1]).includes("git 'push'"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSaveDraft
// ---------------------------------------------------------------------------

describe('handleSaveDraft', () => {
  it('returns no-changes text and skips all execs when the diff is empty', async () => {
    const ctx = makeContext({ diffResults: [{ diff: '', truncated: false }] });
    const result = await handleSaveDraft(ctx, {});
    expect(result.text).toContain('No changes to save');
    expect(ctx.execInSandbox).not.toHaveBeenCalled();
    expect(result.card).toBeUndefined();
  });

  it('returns an error and skips all execs when the initial diff fails', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: '', truncated: false, error: 'sandbox unreachable' }],
    });
    const result = await handleSaveDraft(ctx, {});
    expect(result.text).toContain('[Tool Error — sandbox_save_draft]');
    expect(result.text).toContain('sandbox unreachable');
    expect(ctx.execInSandbox).not.toHaveBeenCalled();
  });

  it('rejects branch_name that does not start with draft/', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+y\n', truncated: false }],
      execResults: [ok('main')],
    });
    const result = await handleSaveDraft(ctx, { branch_name: 'main' });
    expect(result.text).toContain('branch_name must start with "draft/"');
    // Only the branch-detect exec ran (via the GitBackend's currentBranch()).
    expect(ctx.execInSandbox).toHaveBeenCalledTimes(1);
    expect(ctx.execCalls[0][1]).toContain("git 'branch' '--show-current'");
  });

  it('rejects an invalid branch_name before reaching createBranch', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+y\n', truncated: false }],
      execResults: [ok('main')],
    });
    const result = await handleSaveDraft(ctx, { branch_name: '-bad' });
    expect(result.text).toContain('Invalid branch name "-bad"');
    // Only the branch-detect exec ran — no checkout/stage/commit/push.
    expect(ctx.execInSandbox).toHaveBeenCalledTimes(1);
  });

  it('runs checkout/stage/commit/push with mutation flags and returns branchSwitch on the auto-generated-branch path', async () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+a\n';
    const ctx = makeContext({
      diffResults: [{ diff, truncated: false }],
      execResults: [
        ok('main'), // git branch --show-current
        ok(), // git checkout -b
        ok(), // git add -A
        ok('[draft/main-x abc1234] WIP: draft save'), // git commit
        ok('abc1234'), // git rev-parse --short HEAD
        ok(), // git push
      ],
    });
    const result = await handleSaveDraft(ctx, {});
    expect(result.text).toContain('Draft saved to branch: draft/main-');
    expect(result.text).toContain('Commit: abc1234');
    expect(result.text).toContain('Pushed to remote.');
    expect(result.card?.type).toBe('diff-preview');
    // Slice 2: release_draft emits 'switched' (not 'forked') because user
    // intent here is checkpointing, not forking the conversation.
    expect(result.branchSwitch?.name).toMatch(/^draft\/main-/);
    expect(result.branchSwitch?.kind).toBe('switched');
    expect(result.branchSwitch?.source).toBe('release_draft');

    const mutationCalls = ctx.execCalls.filter((c) => c[3]?.markWorkspaceMutated === true);
    expect(mutationCalls).toHaveLength(4);

    // After commit, both caches are cleared (git operations change file hashes).
    expect(ctx.clearFileVersionCache).toHaveBeenCalledWith('sb-1');
    expect(ctx.clearPrefetchedEditFileCache).toHaveBeenCalledWith('sb-1');
  });

  it('skips checkout and omits branchSwitch when already on a draft/ branch', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+a\n', truncated: false }],
      execResults: [
        ok('draft/existing'),
        ok(), // git add -A
        ok('[draft/existing def5678] WIP: draft save'), // git commit
        ok('def5678'), // git rev-parse --short HEAD
        ok(), // git push
      ],
    });
    const result = await handleSaveDraft(ctx, {});
    expect(result.text).toContain('Draft saved to branch: draft/existing');
    expect(result.branchSwitch).toBeUndefined();
    // 5 handler execs: branch-detect, stage, commit, rev-parse (sha), push
    // (no checkout). execCalls excludes the transparent pre-push scan reads.
    expect(ctx.execCalls).toHaveLength(5);
  });

  it('signals auto-back when the draft commit fails after a possible hook rewrite (#982)', async () => {
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+a\n', truncated: false }],
      execResults: [
        ok('draft/existing'),
        ok(), // git add -A
        fail('', 'pre-commit rejected rewritten files', 1), // git commit
      ],
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      const result = await handleSaveDraft(ctx, {});
      expect(result.text).toContain('Failed to commit draft');
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  it('checks out a different draft branch when an explicit branch_name is requested while already on a draft branch', async () => {
    // Regression test for PR #325 review: the original logic skipped checkout
    // whenever the current branch started with `draft/`, silently ignoring an
    // explicitly-requested target. Now an explicit branch_name is honored
    // when it differs from the current branch.
    const ctx = makeContext({
      diffResults: [{ diff: 'diff --git a/x.ts b/x.ts\n+a\n', truncated: false }],
      execResults: [
        ok('draft/existing'), // branch --show-current
        ok(), // git checkout -b draft/requested
        ok(), // git add -A
        ok('[draft/requested abc1234] WIP: draft save'), // git commit
        ok('abc1234'), // git rev-parse --short HEAD
        ok(), // git push
      ],
    });
    const result = await handleSaveDraft(ctx, { branch_name: 'draft/requested' });
    expect(result.text).toContain('Draft saved to branch: draft/requested');
    expect(result.branchSwitch).toEqual({
      name: 'draft/requested',
      kind: 'switched',
      source: 'release_draft',
    });
    // 6 handler execs (execCalls excludes the transparent pre-push scan reads).
    expect(ctx.execCalls).toHaveLength(6);
    // Second exec is the checkout — confirm it targets the requested branch.
    expect(ctx.execCalls[1][1]).toContain("git 'checkout' '-b' 'draft/requested'");
  });
});
