/**
 * Tool executor adapter — PR #3a real implementation.
 *
 * Executes sandbox tools from inside the CoderJob DO by calling the
 * `handleCloudflareSandbox` Worker handler directly (not over HTTP).
 * This keeps dispatch-time zero-copy, skips the HTTP self-loop that
 * would otherwise trip `validateOrigin` + the rate limiter, and uses
 * the same `env.Sandbox` DO binding the normal /api/sandbox-cf/* path
 * uses.
 *
 * Scope note (Phase 1):
 *   This adapter covers the tools the Coder kernel needs for the
 *   happy-path code-edit loop: exec, read, write, list, diff. The
 *   remaining tool variants (patchset, run_tests, check_types,
 *   edit_range, edit_file, apply_patchset, etc.) return a structured
 *   NOT_IMPLEMENTED_YET error so the kernel surfaces a recoverable
 *   failure to the model instead of silently dropping a tool call.
 *   PR #3b broadens the tool set alongside the UI.
 *
 * Unknown and orchestrator-only tools (promote_to_github,
 * sandbox_save_draft, sandbox_download, ...) stay off the background-
 * jobs path by design — they belong to the foreground Orchestrator.
 */

import type { Env } from './worker-middleware';
import { handleCloudflareSandbox } from './worker-cf-sandbox';
import type { SandboxStatusResult, SandboxToolExecResult } from '@push/lib/coder-agent-bindings';
import type { ChatCard } from '@/types';
import type { AIProviderType } from '@push/lib/provider-contract';
import { GIT_REF_VALIDATION_DETAIL, isInvalidGitRef } from '@/lib/git-ref-validation';
import { shellEscape } from '@/lib/sandbox-tool-utils';
import { classifyGitCommand } from '@push/lib/git/policy';
import type { SandboxToolCall } from './coder-job-detector-adapter';

export interface CoderJobExecutorAdapter {
  executeSandboxToolCall: (
    call: SandboxToolCall,
    sandboxId: string,
    opts: { auditorProviderOverride: string; auditorModelOverride: string | undefined },
  ) => Promise<SandboxToolExecResult<ChatCard>>;
  executeWebSearch: (query: string, provider: string) => Promise<SandboxToolExecResult<ChatCard>>;
  sandboxStatus: (sandboxId: string) => Promise<SandboxStatusResult>;
}

export interface WebExecutorAdapterArgs {
  env: Env;
  origin: string;
  sandboxId: string;
  ownerToken: string;
  provider: AIProviderType;
  /**
   * Whether Protect Main is on for this job's session. Gates raw `git push`
   * via sandbox_exec in the background lane the same way the web git-guard does
   * (#977): under Protect Main a raw push is blocked even with allowDirectGit.
   * Production callers MUST pass it (both do); optional only so tests that don't
   * exercise the push gate can omit it. Absent ⇒ fail closed for raw push —
   * note the forbidden-op and branch-op blocks are unconditional and don't
   * depend on it.
   */
  protectMain?: boolean;
  /** Unique per-job id — used to produce a stable rate-limit bucket
   * (`X-Forwarded-For: job:<jobId>`) so background-job traffic doesn't
   * collapse into the global `'unknown'` IP bucket and spuriously 429
   * other jobs. */
  jobId: string;
}

// ---------------------------------------------------------------------------
// Tool → sandbox-cf route mapping.
// ---------------------------------------------------------------------------

/**
 * Why a guarded git op was blocked, so the guidance can be accurate about
 * whether `allowDirectGit` would help:
 *   - `escapable`      — commit/revert, or push when Protect Main is off;
 *                        retrying with allowDirectGit clears it.
 *   - `protected-push` — push under Protect Main; NO allowDirectGit escape.
 *   - `forbidden`      — merge/rebase/cherry-pick/remote-mutation/branch-rename;
 *                        no escape.
 *   - `branch-*`       — route to the typed branch tool (or unsupported).
 */
type GitBlockCategory =
  | 'escapable'
  | 'protected-push'
  | 'forbidden'
  | 'branch-create'
  | 'branch-switch';

type RouteMapping =
  | { kind: 'ok'; route: string; body: Record<string, unknown> }
  | { kind: 'git_blocked'; op: string; category: GitBlockCategory }
  | { kind: 'invalid_arg'; field: string; value: string; detail: string }
  | { kind: 'not_implemented_yet' }
  | { kind: 'unsupported' };

function mapCallToRoute(call: SandboxToolCall, protectMain: boolean): RouteMapping {
  switch (call.tool) {
    case 'sandbox_exec': {
      // Mirror the Web git-guard (lib/default-pre-hooks.ts) exactly, so the
      // background lane isn't a weaker path (#977). `allowDirectGit` escapes
      // ONLY commit/revert and push-when-Protect-Main-off; it does NOT escape:
      //   - forbidden ops (merge/rebase/cherry-pick; remote-mutation —
      //     `git remote set-url` / `git config remote.*` — which would repoint
      //     an audited push, #985/#986/#991; and branch-rename — `git branch
      //     -m` — which would desync the tracked branch, #1298);
      //   - branch create/switch (state-sync — use the typed tools);
      //   - `git push` under Protect Main (it would bypass the push-boundary
      //     gate and land on the protected branch, #977 vector 1).
      // Background jobs run full-auto with no human, so this is the only gate.
      const decision = classifyGitCommand(
        typeof call.args.command === 'string' ? call.args.command : '',
      );
      if (decision.kind === 'block' || decision.kind === 'route') {
        const isForbidden = decision.kind === 'block';
        const isBranchCreate = decision.kind === 'route' && decision.to === 'create_branch';
        const isBranchSwitch = decision.kind === 'route' && decision.to === 'switch_branch';
        const isProtectedPush = decision.kind === 'route' && decision.to === 'push' && protectMain;
        const escapable = !isForbidden && !isBranchCreate && !isBranchSwitch && !isProtectedPush;
        if (!escapable || call.args.allowDirectGit !== true) {
          const category: GitBlockCategory = isBranchCreate
            ? 'branch-create'
            : isBranchSwitch
              ? 'branch-switch'
              : isForbidden
                ? 'forbidden'
                : isProtectedPush
                  ? 'protected-push'
                  : 'escapable';
          return { kind: 'git_blocked', op: decision.label, category };
        }
      }
      return {
        kind: 'ok',
        route: 'exec',
        body: {
          command: call.args.command,
          workdir: call.args.workdir,
          allow_direct_git: call.args.allowDirectGit,
        },
      };
    }
    case 'sandbox_read_file':
      return {
        kind: 'ok',
        route: 'read',
        body: {
          path: call.args.path,
          start_line: call.args.start_line,
          end_line: call.args.end_line,
        },
      };
    case 'sandbox_write_file':
      return {
        kind: 'ok',
        route: 'write',
        body: {
          path: call.args.path,
          content: call.args.content,
          expected_version: call.args.expected_version,
        },
      };
    case 'sandbox_list_dir':
      return {
        kind: 'ok',
        route: 'list',
        body: { path: call.args.path ?? '.' },
      };
    case 'sandbox_diff':
      return { kind: 'ok', route: 'diff', body: {} };

    // Everything below needs either richer argument shaping (patchset,
    // edits) or belongs to the Orchestrator rather than the Coder.
    // Phase 1 PR #3a keeps them explicitly unwired; PR #3b broadens
    // the set as the UI path exercises them.
    case 'sandbox_search':
    case 'sandbox_find_references':
    case 'sandbox_show_commit':
    case 'sandbox_edit_range':
    case 'sandbox_search_replace':
    case 'sandbox_edit_file':
    case 'sandbox_apply_patchset':
    case 'sandbox_commit':
    case 'prepare_push':
    case 'sandbox_push':
    case 'sandbox_run_tests':
    case 'sandbox_check_types':
    case 'sandbox_verify_workspace':
    case 'sandbox_read_symbols':
      return { kind: 'not_implemented_yet' };

    case 'sandbox_create_branch': {
      // Slice 3: route through the existing `exec` handler with a
      // constructed `git checkout -b` command rather than adding a new
      // worker route. The branch state mutation lives at the git level;
      // both foreground and background converge on the same effect.
      // Validation is enforced here (defense in depth — the foreground
      // path validates separately in `sandbox-tools.ts`).
      if (isInvalidGitRef(call.args.name)) {
        return {
          kind: 'invalid_arg',
          field: 'name',
          value: call.args.name,
          detail: GIT_REF_VALIDATION_DETAIL,
        };
      }
      if (call.args.from !== undefined && isInvalidGitRef(call.args.from)) {
        return {
          kind: 'invalid_arg',
          field: 'from',
          value: call.args.from,
          detail: GIT_REF_VALIDATION_DETAIL,
        };
      }
      // Atomic form: failure leaves HEAD untouched. Same construction
      // as the foreground handler in `sandbox-tools.ts`.
      const cmd = call.args.from
        ? `cd /workspace && git checkout -b ${shellEscape(call.args.name)} ${shellEscape(call.args.from)}`
        : `cd /workspace && git checkout -b ${shellEscape(call.args.name)}`;
      return {
        kind: 'ok',
        route: 'exec',
        // `allow_direct_git: true` so the command bypasses the worker's
        // git guard the same way the model would with an explicit opt-in.
        // The branch-create form is allowed by design; the guard is a
        // sandbox_exec-level brake on ad-hoc git, not a sandbox-wide one.
        body: { command: cmd, allow_direct_git: true },
      };
    }

    case 'sandbox_download':
    case 'sandbox_save_draft':
    case 'sandbox_switch_branch':
    case 'promote_to_github':
      return { kind: 'unsupported' };
  }
}

// ---------------------------------------------------------------------------
// Handler round-trip
// ---------------------------------------------------------------------------

// Upper bound for a single sandbox tool round-trip (handler invocation +
// response body consumption). The Cloudflare Sandbox SDK's `exec` can hang
// indefinitely if the underlying container is stuck after a heavy FS write
// (e.g. `npm install` landing ~tens of thousands of files into /workspace)
// — no abort path fires, and the awaiting `response.text()` never resolves,
// which wedges the entire runLoop since nothing above this call enforces a
// deadline. Turning that deadlock into a surfaced error lets the kernel see
// a structured TIMEOUT, the runLoop reach its `finally`, and the SSE stream
// emit a terminal event so the browser isn't stuck waiting forever.
//
// 180s is comfortably above observed long-but-successful commands (a fresh
// `npm install` runs ~100s in a cold container) so well-behaved calls are
// not affected; pathologically stuck calls now recover in finite time.
export const SANDBOX_TOOL_TIMEOUT_MS = 180_000;

export class SandboxToolTimeoutError extends Error {
  readonly route: string;
  readonly timeoutMs: number;
  constructor(route: string, timeoutMs: number) {
    super(`sandbox tool '${route}' did not complete within ${timeoutMs}ms`);
    this.name = 'SandboxToolTimeoutError';
    this.route = route;
    this.timeoutMs = timeoutMs;
  }
}

async function withSandboxTimeout<T>(
  route: string,
  timeoutMs: number,
  op: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SandboxToolTimeoutError(route, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([op(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface HandlerRequestArgs {
  env: Env;
  origin: string;
  sandboxId: string;
  ownerToken: string;
  jobId: string;
  route: string;
  body: Record<string, unknown>;
}

async function callSandboxHandler({
  env,
  origin,
  sandboxId,
  ownerToken,
  jobId,
  route,
  body,
}: HandlerRequestArgs): Promise<{ status: number; text: string; data: unknown }> {
  const url = `${origin}/api/sandbox-cf/${route}`;
  const req = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Required by validateOrigin inside handleCloudflareSandbox.
      Origin: origin,
      // Give the rate limiter a stable per-job bucket so background
      // tool calls don't all collapse into the fallback 'unknown' IP
      // bucket and 429 each other. Without this header
      // `getClientIp(req)` returns 'unknown' for every synthetic
      // internal Request.
      'X-Forwarded-For': `job:${jobId}`,
    },
    body: JSON.stringify({ sandbox_id: sandboxId, owner_token: ownerToken, ...body }),
  });
  return withSandboxTimeout(route, SANDBOX_TOOL_TIMEOUT_MS, async () => {
    const response = (await handleCloudflareSandbox(
      req as unknown as Parameters<typeof handleCloudflareSandbox>[0],
      env as unknown as Parameters<typeof handleCloudflareSandbox>[1],
      new URL(url) as unknown as Parameters<typeof handleCloudflareSandbox>[2],
      route,
    )) as unknown as Response;
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, text, data };
  });
}

// ---------------------------------------------------------------------------
// Result formatters — shape the handler's JSON into the text surface the
// Coder kernel shows to the model, matching the Web executor's convention.
// ---------------------------------------------------------------------------

interface ExecResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  truncated?: boolean;
}
interface ReadResponse {
  content?: string;
  truncated_at_line?: number;
  remaining_bytes?: number;
}
interface WriteResponse {
  bytes_written?: number;
  sha?: string;
}
interface ListResponse {
  entries?: Array<{ name: string; type?: 'file' | 'dir'; size?: number }>;
}
interface DiffResponse {
  diff?: string;
  changed_files?: string[];
}
interface ErrorResponse {
  error?: string;
  code?: string;
}

function formatResult(call: SandboxToolCall, data: unknown, status: number): string {
  if (status >= 400) {
    const err = data as ErrorResponse;
    return `[Tool Error — ${call.tool}] ${err.error ?? `HTTP ${status}`}`;
  }

  switch (call.tool) {
    case 'sandbox_exec': {
      const r = data as ExecResponse;
      const parts: string[] = [`[Tool Result — sandbox_exec] exit=${r.exit_code ?? 0}`];
      if (r.stdout) parts.push(`[stdout]\n${r.stdout}`);
      if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
      if (r.truncated) parts.push('[note] output truncated');
      return parts.join('\n');
    }
    case 'sandbox_read_file': {
      const r = data as ReadResponse;
      const parts: string[] = [`[Tool Result — sandbox_read_file]`];
      if (r.content !== undefined) parts.push(r.content);
      if (r.truncated_at_line) {
        parts.push(
          `[note] truncated at line ${r.truncated_at_line}, ${r.remaining_bytes ?? 0} bytes remaining`,
        );
      }
      return parts.join('\n');
    }
    case 'sandbox_write_file': {
      const r = data as WriteResponse;
      return `[Tool Result — sandbox_write_file] wrote ${r.bytes_written ?? 0} bytes to ${call.args.path}${
        r.sha ? ` (sha=${r.sha.slice(0, 12)})` : ''
      }`;
    }
    case 'sandbox_list_dir': {
      const r = data as ListResponse;
      const entries = (r.entries ?? []).map((e) => `${e.type === 'dir' ? 'd' : 'f'} ${e.name}`);
      return `[Tool Result — sandbox_list_dir]\n${entries.join('\n')}`;
    }
    case 'sandbox_diff': {
      // routeDiff can return HTTP 200 with an `error` field when the
      // underlying git commands fail (e.g. /workspace isn't a git
      // repo). Caller treats the returned structuredError to decide.
      const r = data as DiffResponse & ErrorResponse;
      if (r.error) {
        return `[Tool Error — sandbox_diff] ${r.error}`;
      }
      return r.diff
        ? `[Tool Result — sandbox_diff]\n${r.diff}`
        : `[Tool Result — sandbox_diff] no uncommitted changes`;
    }
    default:
      // Shouldn't reach here — caller filters via mapCallToRoute first.
      return `[Tool Result — ${call.tool}] ${JSON.stringify(data)}`;
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createWebExecutorAdapter(args: WebExecutorAdapterArgs): CoderJobExecutorAdapter {
  // Strip trailing slash so URL construction can't produce
  // `https://host//api/...` when the caller passes a normalized origin
  // with a trailing slash.
  const origin = args.origin.replace(/\/$/, '');
  const protectMain = args.protectMain ?? true;
  return {
    executeSandboxToolCall: async (call, sandboxId) => {
      const mapping = mapCallToRoute(call, protectMain);
      if (mapping.kind === 'not_implemented_yet') {
        return {
          text:
            `[Tool Blocked — ${call.tool}] This tool isn't wired for background jobs yet ` +
            `(Phase 1 PR #3a covers a subset). Stop trying it and summarize progress with the ` +
            `tools you have (sandbox_exec, sandbox_read_file, sandbox_write_file, ` +
            `sandbox_list_dir, sandbox_diff).`,
          structuredError: {
            type: 'APPROVAL_GATE_BLOCKED',
            retryable: false,
            message: `${call.tool} not yet wired for background jobs`,
          },
        };
      }
      if (mapping.kind === 'unsupported') {
        return {
          text:
            `[Tool Blocked — ${call.tool}] This tool is Orchestrator-only and can't run in a ` +
            `background Coder job.`,
          structuredError: {
            type: 'APPROVAL_GATE_BLOCKED',
            retryable: false,
            message: `${call.tool} is not available in background Coder jobs`,
          },
        };
      }
      if (mapping.kind === 'git_blocked') {
        // Guidance keyed on WHY it was blocked (see GitBlockCategory). Only the
        // `escapable` category may suggest allowDirectGit — telling the model to
        // retry it on a forbidden / protected-push op would just loop.
        const guidance =
          mapping.category === 'branch-create'
            ? `Use sandbox_create_branch({"name": "<branch-name>"}) — it creates the branch in the sandbox and keeps Push's branch state in sync. Pass "from": "<base>" to branch from a specific ref instead of HEAD.`
            : mapping.category === 'branch-switch'
              ? `Branch switching isn't available in background Coder jobs. Stop trying it and continue work on the current branch, or use sandbox_create_branch to make a new branch from here.`
              : mapping.category === 'forbidden'
                ? `Push doesn't run this op locally (no "allowDirectGit" escape). Commit with sandbox_commit and ship via prepare_push; integrate branches through the GitHub PR flow. Don't retry with allowDirectGit — it won't apply.`
                : mapping.category === 'protected-push'
                  ? `Protect Main is on: direct \`git push\` is blocked here even with allowDirectGit (it would bypass the audited push gate and land on the protected branch). Switch to a feature branch and ship via prepare_push.`
                  : `Use sandbox_commit to commit and prepare_push to ship (the Auditor runs at push), or retry this call with "allowDirectGit": true if you've already decided direct git is necessary.`;
        const messageSuffix =
          mapping.category === 'branch-create'
            ? ' — use sandbox_create_branch'
            : mapping.category === 'branch-switch'
              ? ' — branch switching unsupported in background jobs'
              : mapping.category === 'forbidden'
                ? ' — no allowDirectGit escape'
                : mapping.category === 'protected-push'
                  ? ' — Protect Main on'
                  : ' without allowDirectGit';
        return {
          text: `[Tool Blocked — sandbox_exec] Direct "${mapping.op}" is blocked in background Coder jobs. ${guidance}`,
          structuredError: {
            type: 'APPROVAL_GATE_BLOCKED',
            retryable: false,
            message: `direct ${mapping.op} is blocked${messageSuffix}`,
          },
        };
      }
      if (mapping.kind === 'invalid_arg') {
        return {
          text:
            `[Tool Error — ${call.tool}] Invalid ${mapping.field} "${mapping.value}". ` +
            mapping.detail,
          structuredError: {
            type: 'INVALID_ARG',
            retryable: false,
            message: `Invalid ${mapping.field}: ${mapping.value}`,
          },
        };
      }

      try {
        const { status, data } = await callSandboxHandler({
          env: args.env,
          origin,
          sandboxId,
          ownerToken: args.ownerToken,
          jobId: args.jobId,
          route: mapping.route,
          body: mapping.body,
        });
        if (status >= 400) {
          const err = data as ErrorResponse;
          // Classify the sandbox-handler error into a structured tool error
          // the kernel can act on. Three buckets, narrowest first:
          //
          //   1. NOT_FOUND at the HTTP layer uniquely signals the sandbox
          //      container is gone — emitted by the owner-token gate's
          //      `verifySandboxOwnerToken` after a destroy, by `/connect`'s
          //      liveness probe, and by the route-level catch arm via
          //      `classifyCfError('no such ...')` in `worker-cf-sandbox.ts`.
          //      These all mean "the sandbox is unreachable from my POV";
          //      map to SANDBOX_UNREACHABLE and tag `fatal: true` so the
          //      kernel's loss tracker throws on the FIRST occurrence
          //      (without `fatal`, the threshold-of-2 waits for a second
          //      consecutive failing call that models which gracefully
          //      summarize after one error — kimi-k2.6 — never make).
          //      `routeRead` also uses `code: 'NOT_FOUND'` for missing files
          //      but returns it with HTTP 200, so it never enters this
          //      branch — file-not-found stays distinct.
          //
          //   2. HTTP 429 (rate-limited) does NOT carry a `code` field — the
          //      response is `{ error: 'Rate limit exceeded…' }`. The
          //      previous default-to-SANDBOX_UNREACHABLE would falsely trip
          //      the kernel's loss tracker on two consecutive 429s and burn
          //      a resume budget on a healthy sandbox. Map explicitly to
          //      RATE_LIMITED + retryable so the kernel sees the right shape.
          //
          //   3. Other 4xx without an `err.code` is treated as an unknown
          //      bad-request shape — default to `UNKNOWN` (not retryable,
          //      definitely not SANDBOX_UNREACHABLE). 5xx without a code
          //      still defaults to SANDBOX_UNREACHABLE: backend trouble on
          //      the sandbox handler IS the sandbox being unreachable from
          //      the kernel's POV, and retryable=true gives the resume path
          //      a chance.
          const isSandboxGone = err.code === 'NOT_FOUND';
          const is4xxNoCode = status >= 400 && status < 500 && !err.code;
          let type: string;
          if (isSandboxGone) {
            type = 'SANDBOX_UNREACHABLE';
          } else if (status === 429) {
            type = 'RATE_LIMITED';
          } else if (is4xxNoCode) {
            type = 'UNKNOWN';
          } else {
            type = err.code ?? 'SANDBOX_UNREACHABLE';
          }
          return {
            text: formatResult(call, data, status),
            structuredError: {
              type,
              // A dead sandbox is recoverable via the DO's restore path;
              // rate limits are recoverable after a backoff; everything
              // else carries the previous `status >= 500` heuristic.
              retryable:
                type === 'SANDBOX_UNREACHABLE' || type === 'RATE_LIMITED' ? true : status >= 500,
              message: err.error ?? `HTTP ${status}`,
              ...(isSandboxGone ? { fatal: true } : {}),
            },
          };
        }
        // sandbox_diff is the one handler that returns HTTP 200 with an
        // `error` field when git fails. Surface that as a structured
        // error so the model doesn't treat broken git as a clean tree.
        if (call.tool === 'sandbox_diff') {
          const diffErr = (data as ErrorResponse).error;
          if (diffErr) {
            return {
              text: formatResult(call, data, status),
              structuredError: {
                type: 'SANDBOX_GIT_ERROR',
                retryable: false,
                message: diffErr,
              },
            };
          }
        }
        // sandbox_create_branch: routed through `exec`, but we own the
        // result shape — surface a clean tool-result message and (on
        // success) the headless-side `meta.branchCreated` observability
        // signal. No `branchSwitch` is emitted from the background path
        // by design (foreground-only routing rule, see SandboxToolMeta).
        if (call.tool === 'sandbox_create_branch') {
          const r = data as ExecResponse;
          if ((r.exit_code ?? 0) !== 0) {
            const reason = r.stderr || r.stdout || 'git checkout -b failed';
            return {
              text: `[Tool Error — sandbox_create_branch]\n${reason}`,
              structuredError: {
                type: 'WRITE_FAILED',
                retryable: false,
                message: reason,
              },
            };
          }
          return {
            text:
              `[Tool Result — sandbox_create_branch] Created and switched to ` +
              `${call.args.name}${call.args.from ? ` from ${call.args.from}` : ''}.`,
            meta: { branchCreated: { name: call.args.name } },
          };
        }
        return { text: formatResult(call, data, status) };
      } catch (err) {
        const isTimeout = err instanceof SandboxToolTimeoutError;
        const message = err instanceof Error ? err.message : String(err);
        return {
          text: isTimeout
            ? `[Tool Timeout — ${call.tool}] Sandbox did not respond within ${err.timeoutMs}ms. ` +
              `The command may still be running in the container, but the job won't wait for it. ` +
              `Try a faster command or investigate why the sandbox is unresponsive.`
            : `[Tool Error — ${call.tool}] ${message}`,
          structuredError: {
            type: isTimeout ? 'TIMEOUT' : 'SANDBOX_UNREACHABLE',
            retryable: true,
            message,
          },
        };
      }
    },
    executeWebSearch: async () => ({
      text:
        `[Tool Blocked — web_search] Web search isn't wired for background jobs yet. Use ` +
        `sandbox_exec + grep / find for codebase questions instead.`,
      structuredError: {
        type: 'APPROVAL_GATE_BLOCKED',
        retryable: false,
        message: 'web_search not yet wired for background jobs',
      },
    }),
    sandboxStatus: async (sandboxId) => {
      try {
        const { status, data } = await callSandboxHandler({
          env: args.env,
          origin,
          sandboxId,
          ownerToken: args.ownerToken,
          jobId: args.jobId,
          route: 'diff',
          body: {},
        });
        if (status >= 400) {
          const err = data as ErrorResponse;
          return {
            error: err.error ?? `HTTP ${status}`,
            head: '',
            changedFiles: [],
          };
        }
        const r = data as DiffResponse;
        return {
          head: '',
          changedFiles: r.changed_files ?? [],
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          head: '',
          changedFiles: [],
        };
      }
    },
  };
}
