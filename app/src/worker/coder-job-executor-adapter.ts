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
import { detectBlockedGitCommand } from '@/lib/sandbox-tool-utils';
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
  /** Unique per-job id — used to produce a stable rate-limit bucket
   * (`X-Forwarded-For: job:<jobId>`) so background-job traffic doesn't
   * collapse into the global `'unknown'` IP bucket and spuriously 429
   * other jobs. */
  jobId: string;
}

// ---------------------------------------------------------------------------
// Tool → sandbox-cf route mapping.
// ---------------------------------------------------------------------------

type RouteMapping =
  | { kind: 'ok'; route: string; body: Record<string, unknown> }
  | { kind: 'git_blocked'; op: string }
  | { kind: 'not_implemented_yet' }
  | { kind: 'unsupported' };

function mapCallToRoute(call: SandboxToolCall): RouteMapping {
  switch (call.tool) {
    case 'sandbox_exec': {
      // Mirror the Web executor's git guard — direct
      // `git commit/push/merge/rebase` in `sandbox_exec` is blocked
      // unless the model opts in via `allowDirectGit: true`. The
      // audited flow is `sandbox_prepare_commit` + `sandbox_push`.
      // Background jobs run under `approvalMode='full-auto'`, but we
      // keep the guard on regardless so background jobs can't silently
      // mutate repo history bypassing the audit trail the foreground
      // loop enforces.
      const blockedGitOp = detectBlockedGitCommand(call.args.command);
      if (blockedGitOp && !call.args.allowDirectGit) {
        return { kind: 'git_blocked', op: blockedGitOp };
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
    case 'sandbox_edit_range':
    case 'sandbox_search_replace':
    case 'sandbox_edit_file':
    case 'sandbox_apply_patchset':
    case 'sandbox_prepare_commit':
    case 'sandbox_push':
    case 'sandbox_run_tests':
    case 'sandbox_check_types':
    case 'sandbox_verify_workspace':
    case 'sandbox_read_symbols':
      return { kind: 'not_implemented_yet' };

    case 'sandbox_download':
    case 'sandbox_save_draft':
    case 'promote_to_github':
      return { kind: 'unsupported' };
  }
}

// ---------------------------------------------------------------------------
// Handler round-trip
// ---------------------------------------------------------------------------

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
  return {
    executeSandboxToolCall: async (call, sandboxId) => {
      const mapping = mapCallToRoute(call);
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
        return {
          text:
            `[Tool Blocked — sandbox_exec] Direct "${mapping.op}" is blocked in background ` +
            `Coder jobs. Use sandbox_prepare_commit + sandbox_push for the audited flow, or ` +
            `retry this call with "allowDirectGit": true if you've already decided direct git ` +
            `is necessary.`,
          structuredError: {
            type: 'APPROVAL_GATE_BLOCKED',
            retryable: false,
            message: `direct ${mapping.op} is blocked without allowDirectGit`,
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
          return {
            text: formatResult(call, data, status),
            structuredError: {
              type: err.code ?? 'SANDBOX_UNREACHABLE',
              retryable: status >= 500,
              message: err.error ?? `HTTP ${status}`,
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
        return { text: formatResult(call, data, status) };
      } catch (err) {
        return {
          text: `[Tool Error — ${call.tool}] ${err instanceof Error ? err.message : String(err)}`,
          structuredError: {
            type: 'SANDBOX_UNREACHABLE',
            retryable: true,
            message: err instanceof Error ? err.message : String(err),
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
