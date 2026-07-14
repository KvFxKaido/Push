/**
 * Sandbox tools for the autonomous PR reviewer.
 *
 * The review Durable Object reviews from the GitHub-API diff only; this lets it
 * grep/read across the *checked-out PR head* so it can trace a changed symbol
 * into non-diff files (the gap that let the #1219 normalizer strip slip past
 * review). It provisions a sandbox with the PR head checked out and dispatches a
 * small inspection tool set (search/read/ls) into the reviewer's tool loop.
 *
 * Security posture — deliberately reuses the existing read-only inspection
 * handlers (`handleSearch`/`handleReadFile`/`handleListDir`) rather than calling
 * sandbox routes raw, so the reviewer inherits the SAME redaction the web
 * Coder/Explorer get: sensitive-path hiding + secret-value redaction
 * (`handleSearch`) and envelope-boundary escaping (`handleReadFile`). The raw
 * `sandbox_exec` route is NEVER exposed. Verification comes from the PR head's
 * GitHub check runs (§9a), not from executable tools in this sandbox.
 *
 * Reachability uses the internal, gate-free `dispatchSandboxRouteInternal`
 * (proved by the reachability spike): the DO is inside the trust boundary and
 * the public `/api/sandbox-cf/*` path would reject it. Auth on every non-create
 * route is the owner token minted at create time.
 *
 * Imports are TYPE-ONLY at module scope; the runtime deps (`worker-cf-sandbox`,
 * which pulls the CF Sandbox SDK's `cloudflare:`-scheme imports, and the
 * inspection handlers) are loaded via dynamic `import()`
 * inside the functions so this module — and `pr-review-job-do` which statically
 * imports it — stay off the vitest/node graph that can't resolve `cloudflare:`
 * (same reason the reachability spike was dynamically imported).
 */

import type { ExecResult, FileEntry, FileReadResult } from '@/lib/sandbox-client';
import type { ReadOnlyInspectionHandlerContext } from '@/lib/sandbox-read-only-inspection-handlers';
import type { SandboxToolCall } from '@/lib/sandbox-tool-detection';
import type { ToolExecutionResult } from '@/types';
import type { Env } from './worker-middleware';

/** Sandbox tools wired into the reviewer. Advertised set and
 *  executor switch derive from this ONE list so they can't drift. Entries are
 *  the registry PUBLIC names (`sandbox_run_tests` → `test`, singular) — the
 *  detector resolves only canonical/public/alias names, so advertising
 *  anything else produces calls that silently never execute (Codex P2,
 *  PR #1385). */
export const REVIEW_SANDBOX_TOOLS = ['search', 'read', 'ls'] as const;
/** Full public names string. */
export const REVIEW_SANDBOX_TOOL_NAMES = REVIEW_SANDBOX_TOOLS.join(', ');

/**
 * Public names for the reviewer tool-protocol `- Sandbox:` line.
 *
 * INSPECTION ONLY since §9a. `typecheck` and `test` used to live here: the reviewer
 * re-ran the repo's own commands inside a half-vCPU container that `Dockerfile.sandbox`
 * documents as getting OOM-killed by repo test suites, while CI had already run those
 * exact commands on that exact commit in ~90s. Verification now reads the head SHA's
 * check runs; the sandbox keeps the job it is actually good at — reading the code.
 */
export function reviewSandboxToolNames(): string {
  return REVIEW_SANDBOX_TOOL_NAMES;
}

/** Tool result for a reviewer sandbox call. Inspection-only since §9a, so there is
 *  no verification metadata riding on it any more — the verdict comes from the head
 *  SHA's check runs (see review-ci-verification.ts), not from anything this module
 *  executes. */
export type ReviewSandboxToolResult = ToolExecutionResult;

export interface ReviewSandbox {
  sandboxId: string;
  ownerToken: string;
}

function log(event: string, ctx: Record<string, unknown>): void {
  // Worker surface → console.log per the structured-log convention.
  console.log(JSON.stringify({ level: 'info', event, ...ctx }));
}

async function callRoute(
  env: Env,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  // Dynamic import keeps the CF Sandbox SDK (`cloudflare:` scheme) off the
  // static import graph of every module that imports this one.
  const { dispatchSandboxRouteInternal } = await import('./worker-cf-sandbox');
  const res = await dispatchSandboxRouteInternal(env, route, body);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — status alone still classifies success/failure.
  }
  return { status: res.status, json };
}

const okStatus = (s: number): boolean => s >= 200 && s < 300;

async function bestEffortCleanup(env: Env, sandboxId: string, ownerToken: string): Promise<void> {
  try {
    await callRoute(env, 'cleanup', { sandbox_id: sandboxId, owner_token: ownerToken });
  } catch {
    // teardown is best-effort; the 1h idle reaper is the backstop.
  }
}

/**
 * Provision a sandbox with the PR head checked out, then verify HEAD matches the
 * commit we intend to review. Returns null (review falls back to diff-only) when
 * create fails, the workspace is empty (cross-fork / dead ref), or HEAD drifted
 * from `expectedHeadSha` between webhook and clone. Tears down on a verify
 * failure so a half-provisioned sandbox never leaks. NEVER throws.
 */
export async function provisionReviewSandbox(
  env: Env,
  repoFullName: string,
  headRef: string,
  expectedHeadSha: string,
  githubToken: string,
): Promise<ReviewSandbox | null> {
  let sandboxId = '';
  let ownerToken = '';
  try {
    const created = await callRoute(env, 'create', {
      repo: repoFullName,
      branch: headRef,
      github_token: githubToken,
    });
    sandboxId = typeof created.json?.sandbox_id === 'string' ? created.json.sandbox_id : '';
    ownerToken = typeof created.json?.owner_token === 'string' ? created.json.owner_token : '';
    if (!okStatus(created.status) || !sandboxId || !ownerToken) {
      log('review_sandbox_provision_failed', {
        stage: 'create',
        httpStatus: created.status,
        hasId: Boolean(sandboxId),
      });
      // create may have produced a sandbox even on a non-2xx tail; best-effort kill.
      if (sandboxId && ownerToken) await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }

    // Verify the checkout landed on the RIGHT commit. `routeDiff` reports the
    // workspace HEAD; a missing value means an empty workspace (cross-fork /
    // dead ref) and a mismatch means the branch advanced post-webhook — either
    // way the sandbox can't faithfully back a review of `expectedHeadSha`.
    const diff = await callRoute(env, 'diff', { sandbox_id: sandboxId, owner_token: ownerToken });
    const headSha = typeof diff.json?.head_sha === 'string' ? diff.json.head_sha : '';
    if (!headSha) {
      log('review_sandbox_provision_failed', { stage: 'verify', reason: 'no_head_sha' });
      await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }
    if (expectedHeadSha && headSha !== expectedHeadSha) {
      log('review_sandbox_provision_failed', {
        stage: 'verify',
        reason: 'head_mismatch',
        expected: expectedHeadSha.slice(0, 12),
        actual: headSha.slice(0, 12),
      });
      await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }

    log('review_sandbox_provisioned', { headSha: headSha.slice(0, 12) });
    return { sandboxId, ownerToken };
  } catch (err) {
    log('review_sandbox_provision_failed', {
      stage: 'exception',
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    if (sandboxId && ownerToken) await bestEffortCleanup(env, sandboxId, ownerToken);
    return null;
  }
}

/** Best-effort teardown. NEVER throws. */
export async function cleanupReviewSandbox(env: Env, sandbox: ReviewSandbox): Promise<void> {
  await bestEffortCleanup(env, sandbox.sandboxId, sandbox.ownerToken);
  log('review_sandbox_cleanup', { ok: true });
}

/**
 * Build a read-only inspection context whose transport dispatches to the
 * review's sandbox via the internal route entry. Client-side cache/ledger hooks
 * are no-ops â€” the DO has no per-session workspace cache to keep coherent.
 */
function buildReviewInspectionContext(
  env: Env,
  sandbox: ReviewSandbox,
): ReadOnlyInspectionHandlerContext {
  const auth = { sandbox_id: sandbox.sandboxId, owner_token: sandbox.ownerToken };
  return {
    sandboxId: sandbox.sandboxId,
    readFromSandbox: async (_id, path, startLine, endLine): Promise<FileReadResult> => {
      const body: Record<string, unknown> = { ...auth, path };
      if (startLine !== undefined) body.start_line = startLine;
      if (endLine !== undefined) body.end_line = endLine;
      const { json } = await callRoute(env, 'read', body);
      return (json ?? { error: 'read failed' }) as unknown as FileReadResult;
    },
    execInSandbox: async (_id, command): Promise<ExecResult> => {
      const { json } = await callRoute(env, 'exec', { ...auth, command, workdir: '/workspace' });
      return {
        stdout: typeof json?.stdout === 'string' ? json.stdout : '',
        stderr: typeof json?.stderr === 'string' ? json.stderr : '',
        exitCode: typeof json?.exit_code === 'number' ? json.exit_code : 1,
        truncated: json?.truncated === true,
        error: typeof json?.error === 'string' ? json.error : undefined,
      };
    },
    listDirectory: async (_id, path = '/workspace'): Promise<FileEntry[]> => {
      const { json } = await callRoute(env, 'list', { ...auth, path });
      if (json?.error) throw new Error(String(json.error));
      const base = path.replace(/\/+$/, '');
      const entries = Array.isArray(json?.entries)
        ? (json.entries as Array<Record<string, unknown>>)
        : [];
      return entries.map((entry) => ({
        ...(entry as unknown as FileEntry),
        path:
          typeof entry.path === 'string' && entry.path
            ? entry.path
            : `${base}/${String(entry.name ?? '')}`,
      }));
    },
    // Symbols/refs are not in the v1 reviewer tool set; never invoked because
    // executeReviewSandboxTool routes only search/read/ls. Throw defensively.
    readSymbolsFromSandbox: async () => {
      throw new Error('sandbox_read_symbols is not available in PR review');
    },
    findReferencesInSandbox: async () => {
      throw new Error('sandbox_find_references is not available in PR review');
    },
    // Client-side coherence caches â€” no-ops in the DO.
    syncReadSnapshot: () => {},
    invalidateWorkspaceSnapshots: () => 0,
    deleteFileVersion: () => {},
    recordReadFileMetric: () => {},
    recordLedgerRead: () => {},
    lookupCachedSymbols: () => undefined,
    storeCachedSymbols: () => {},
  };
}

/**
 * Execute one reviewer sandbox tool against the checked-out PR head.
 *
 * INSPECTION ONLY since §9a — search / read / ls. The verifier cases
 * (`sandbox_check_types`, `sandbox_run_tests`) and the setup gate that fed them are
 * gone: the reviewer no longer re-runs the repo's commands on a half-vCPU container,
 * it reads the verdict CI already produced for the head SHA.
 *
 * That deletes the whole failure class this module kept generating — the 600s setup
 * install, the two 480s verifier deadlines, and the setup gate whose model-facing
 * "[Tool Error] … Verification cannot run in this review's sandbox" the model would
 * then relay as its own reasoning, making an environment outage look like a model
 * excuse.
 */
export async function executeReviewSandboxTool(
  env: Env,
  sandbox: ReviewSandbox,
  call: SandboxToolCall,
): Promise<ReviewSandboxToolResult> {
  switch (call.tool) {
    case 'sandbox_search': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleSearch } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleSearch(ctx, call.args);
    }
    case 'sandbox_read_file': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleReadFile } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleReadFile(ctx, call.args);
    }
    case 'sandbox_list_dir': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleListDir } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleListDir(ctx, call.args);
    }
    default:
      return {
        text: `[Tool Error] ${call.tool} is not available in automated PR review (sandbox tools: ${reviewSandboxToolNames()}). Verification comes from this commit's CI check runs, not from the review sandbox.`,
      };
  }
}
