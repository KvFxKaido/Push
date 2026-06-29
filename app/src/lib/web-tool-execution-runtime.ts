/**
 * Web-side implementation of `ToolExecutionRuntime`.
 *
 * Wraps the existing per-source executors (`executeToolCall`,
 * `executeSandboxToolCall`, `executeWebSearch`) and preserves the full
 * pre/post-hook + approval-gate + Protect Main pipeline that
 * `executeAnyToolCall` used to run inline.
 *
 * This module is the Phase 5B Web binding. `app/src/lib/tool-dispatch.ts`
 * keeps a thin `executeAnyToolCall` shim for existing callers that is
 * implemented in terms of this class.
 */

import type { ToolExecutionRuntime, ToolExecutionContext } from '@push/lib/tool-execution-runtime';
import { enforceRoleCapability, formatRoleCapabilityDenial } from '@push/lib/capabilities';
import { getExecutionMode } from '@push/lib/tool-execution-runtime';
import { resolveToolName } from '@push/lib/tool-registry';

import type {
  ChatMessage,
  StructuredToolError,
  ToolErrorType,
  ToolHookContext,
  ToolExecutionResult,
} from '@/types';
import type { ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import { evaluatePreHooks, evaluatePostHooks, type ToolHookRegistry } from './tool-hooks';
import { getDefaultWebHookRegistry } from './web-default-hooks';
import type { ApprovalGateRegistry } from './approval-gates';
import { executeToolCall } from './github-tools';
import { mapSandboxReadToGitHubCall } from './sandbox-read-github-fallback';
import { executeSandboxToolCall } from './sandbox-tools';
import { executeWebSearch } from './web-search-tools';
import { executeArtifactToolCall } from './artifact-tools';
import { runMemoryGrep, runMemoryExpand } from '@push/lib/memory-tool-exec';
import { getDefaultMemoryStore } from '@push/lib/context-memory-store';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { getApprovalMode } from './approval-mode';
import { type AnyToolCall } from './tool-dispatch';
import { execInSandbox } from './sandbox-client';
import type { ArtifactAuthor, ArtifactScope } from '@push/lib/artifacts/types';

// ---------------------------------------------------------------------------
// Pure helpers — private to the Web adapter.
// These formerly lived in tool-dispatch.ts. `AnyToolCall` is still a
// Web-side discriminated union, so the helpers stay in Web too.
// ---------------------------------------------------------------------------

export function getHookToolName(toolCall: AnyToolCall): string {
  return toolCall.call.tool;
}

export function getHookToolArgs(toolCall: AnyToolCall): Record<string, unknown> {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
    case 'ask-user':
    case 'artifacts':
      return { ...toolCall.call.args };
    case 'scratchpad':
      return toolCall.call.content ? { content: toolCall.call.content } : {};
    case 'todo':
      if (toolCall.call.tool === 'todo_write') {
        return { todos: toolCall.call.todos };
      }
      return {};
    default:
      return {};
  }
}

export function applyHookToolArgs(
  toolCall: AnyToolCall,
  modifiedArgs: Record<string, unknown>,
): void {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
    case 'ask-user':
    case 'artifacts':
      Object.assign(toolCall.call.args, modifiedArgs);
      return;
    case 'scratchpad':
      if (typeof modifiedArgs.content === 'string') {
        toolCall.call.content = modifiedArgs.content;
      }
      return;
    case 'todo':
      // Todo calls are executed in the chat hook and don't flow through the
      // hook-arg-mutation pipeline; nothing to apply here.
      return;
    default:
      return;
  }
}

/**
 * Read-tier fallback (decision §11): when a cloud-sandbox read can't run
 * because the sandbox is unavailable, degrade to the GitHub-tier equivalent
 * instead of dead-ending on `SANDBOX_UNREACHABLE`. Returns the GitHub read
 * result (annotated as last-pushed state) on success, or `null` when no
 * fallback applies — in which case the caller keeps the original sandbox error.
 *
 * Every branch emits a symmetric structured log so ops can tell a served
 * fallback from a skip-no-repo / skip-no-equivalent / GitHub-also-failed.
 */
async function tryGitHubReadFallback(
  sandboxCall: { tool: string; args?: Record<string, unknown> },
  ctx: { allowedRepo?: string; currentBranch?: string; defaultBranch?: string },
  reason: 'no_sandbox' | 'sandbox_unreachable',
): Promise<ToolExecutionResult | null> {
  const repo = ctx.allowedRepo;
  if (!repo) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'read_tier_github_fallback_skipped',
        tool: sandboxCall.tool,
        reason,
        cause: 'no_active_repo',
      }),
    );
    return null;
  }
  const branch = ctx.currentBranch ?? ctx.defaultBranch;
  const githubCall = mapSandboxReadToGitHubCall(sandboxCall, repo, branch);
  if (!githubCall) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'read_tier_github_fallback_skipped',
        tool: sandboxCall.tool,
        reason,
        cause: 'no_github_equivalent',
      }),
    );
    return null;
  }
  // `search_files` maps to GitHub's `/search/code`, which is NOT branch-aware —
  // it only indexes the default branch and ignores `&ref`. On a non-default
  // feature branch the search would return default-branch (stale / no-match)
  // results as a *success*, hiding the retryable sandbox error — especially
  // misleading for a references lookup. Decline so the caller keeps
  // SANDBOX_UNREACHABLE. (read_file / list_dir use the branch-aware contents
  // API, so they're unaffected.)
  if (
    githubCall.tool === 'search_files' &&
    ctx.currentBranch &&
    ctx.defaultBranch &&
    ctx.currentBranch !== ctx.defaultBranch
  ) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'read_tier_github_fallback_skipped',
        tool: sandboxCall.tool,
        reason,
        cause: 'code_search_not_branch_aware',
        branch: ctx.currentBranch,
      }),
    );
    return null;
  }
  try {
    const result = await executeToolCall(githubCall, repo);
    // The GitHub executor reports many failures (404s, repo mismatch, "path is
    // a directory") as `[Tool Error] …` *text* with no `structuredError`.
    // Treat either signal as a failed fallback so we keep the original, more
    // relevant sandbox error instead of swapping in a misleading GitHub miss.
    const failed =
      Boolean(result.structuredError) || (result.text ?? '').trimStart().startsWith('[Tool Error]');
    if (failed) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'read_tier_github_fallback_failed',
          from: sandboxCall.tool,
          to: githubCall.tool,
          reason,
          error_type: result.structuredError?.type ?? 'tool_error_text',
        }),
      );
      return null;
    }
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'read_tier_github_fallback',
        from: sandboxCall.tool,
        to: githubCall.tool,
        reason,
        branch: branch ?? null,
      }),
    );
    return {
      ...result,
      text: `[Read tier] Sandbox unavailable — served ${githubCall.tool} from GitHub (branch "${branch ?? 'default'}", last pushed state; uncommitted working-tree edits are NOT reflected).\n${result.text}`,
    };
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'read_tier_github_fallback_failed',
        from: sandboxCall.tool,
        to: githubCall.tool,
        reason,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/**
 * Sandbox tools that have a `pushd` daemon implementation today.
 *
 * For a `kind: 'local-pc'` session (binding present, `sandboxId: null`),
 * routing an unsupported tool to the cloud handler would call
 * `execInSandbox('')` against a nonexistent sandbox and surface a
 * confusing error. The runtime layer refuses these calls with a
 * structured `LOCAL_DAEMON_TOOL_UNSUPPORTED` error.
 *
 * Shipped daemon paths:
 *   - `sandbox_exec` (PR #511 / 3c.1)
 *   - `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir` /
 *     `sandbox_diff` (PR 3c.3)
 *
 * Extend this set in lockstep with each tool's per-pushd handler +
 * `local-daemon-sandbox-client` method + dispatch fork case.
 */
const LOCAL_DAEMON_SUPPORTED_TOOLS = new Set([
  'sandbox_exec',
  'sandbox_read_file',
  'sandbox_write_file',
  'sandbox_list_dir',
  'sandbox_diff',
]);

async function readSandboxBranch(sandboxId: string): Promise<string | null> {
  try {
    const result = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
    if (result.exitCode === 0 && result.stdout?.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Best-effort — fail-safe (return null → will block).
  }
  return null;
}

// ---------------------------------------------------------------------------
// Web-bound context alias — keeps call sites readable without changing
// the generic interface shape in lib.
// ---------------------------------------------------------------------------

type WebToolExecutionContext = ToolExecutionContext<ToolHookRegistry, ApprovalGateRegistry>;

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export class WebToolExecutionRuntime
  implements
    ToolExecutionRuntime<AnyToolCall, ToolExecutionResult, ToolHookRegistry, ApprovalGateRegistry>
{
  async execute(
    toolCall: AnyToolCall,
    context: WebToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const toolName = getHookToolName(toolCall);
    const toolArgs = getHookToolArgs(toolCall);
    const activeProvider = context.activeProvider as ActiveProvider | undefined;
    const sandboxIdForBranch = context.sandboxId;
    const hookContext: ToolHookContext = {
      sandboxId: context.sandboxId,
      allowedRepo: context.allowedRepo,
      activeProvider,
      activeModel: context.activeModel,
      capabilityLedger: context.capabilityLedger,
      defaultBranch: context.defaultBranch,
      // Push-tracked branch — sandbox-independent. Memory/artifact scoping
      // prefer it; Protect Main consults it only when no live reader exists at
      // all (never as a fallback for an unreadable live HEAD — that fails
      // closed, so a desynced session can't bypass the gate via stale state).
      currentBranch: context.currentBranch,
      isMainProtected: context.isMainProtected,
      // Branch reader is lazy — hooks that don't need it never pay the
      // sandbox round-trip. Only Protect Main currently calls it.
      getCurrentBranch: sandboxIdForBranch
        ? () => this.getSandboxBranch(sandboxIdForBranch)
        : undefined,
    };

    context.emit?.toolExecutionStart({
      toolName,
      source: toolCall.source,
      toolCallId: (toolCall.call as { id?: string }).id ?? '',
    });
    const startTime = Date.now();

    try {
      // --- Runtime invariant: role capability check ---
      //
      // Enforces the role's capability grant at the runtime layer —
      // *before* hooks, approval gates, or Protect Main run. The check
      // is unconditional: a binding that fails to declare a role on the
      // context gets denied with `ROLE_REQUIRED` rather than silently
      // bypassing enforcement. This is the kernel invariant that closes
      // audit item #3 from the OpenCode silent-failure inventory.
      //
      // The type system enforces this for TypeScript callers
      // (`ToolExecutionContext.role` is required); the runtime check
      // catches stragglers from JS callers (CLI) and provides a
      // structured `ROLE_REQUIRED` error if anyone slips through.
      //
      // Fail-open for unmapped tools (forward-compat) is preserved by
      // `enforceRoleCapability` — only the missing-role branch is
      // fail-closed.
      {
        const canonicalName = resolveToolName(toolName) ?? toolName;
        // Derive the named execution mode at the runtime edge. Bindings
        // are a transport detail; the mode is the policy input the
        // capability gate consumes. See `getExecutionMode` for the
        // single-seam-to-change rationale.
        const executionMode = getExecutionMode(context);
        const check = enforceRoleCapability(context.role, canonicalName, executionMode);
        if (!check.ok) {
          const err: StructuredToolError = {
            type: check.type,
            retryable: false,
            message: check.message,
            detail: check.detail,
          };
          // Pair the start event with a matching complete event so any
          // attached observer sees the block as a terminal tool lifecycle
          // rather than an in-flight tool stuck forever. The other
          // pre-execution denial paths in this function (pre-hook,
          // approval gate, Protect Main) omit the complete emit today —
          // that is a pre-existing inconsistency, out of scope here;
          // the new code path at least gets it right.
          context.emit?.toolExecutionComplete({
            toolName,
            durationMs: Date.now() - startTime,
            error: { type: err.type, message: err.message, retryable: err.retryable },
          });
          return {
            text: formatRoleCapabilityDenial(toolName, check),
            structuredError: err,
          };
        }
      }

      // --- Pre-hooks ---
      // Default web hooks (git guard, …) apply to every call; caller-
      // supplied hooks (e.g. Explorer's read-only allowlist) layer on
      // top. First deny across either set short-circuits.
      const preRegistries: ToolHookRegistry[] = [getDefaultWebHookRegistry()];
      if (context.hooks && context.hooks.pre.length > 0) {
        preRegistries.push(context.hooks);
      }
      for (const registry of preRegistries) {
        const preResult = await evaluatePreHooks(registry, toolName, toolArgs, hookContext);
        if (preResult?.decision === 'deny') {
          const reason = preResult.reason || 'Blocked by pre-execution hook.';
          // Promote a hook-supplied `errorType` into a real
          // `StructuredToolError` for telemetry + downstream
          // classification. Falls back to a generic code when the hook
          // didn't supply one — the model still sees the same human-
          // readable block, just without the specific taxonomy entry.
          // `errorType` is typed `string` in lib (hooks aren't forced
          // to import the rich `ToolErrorType` union); the registered
          // hooks emit codes that are members of the union — cast
          // here at the boundary where the relationship holds.
          const err: StructuredToolError = {
            type: (preResult.errorType as ToolErrorType | undefined) ?? 'PRE_HOOK_BLOCKED',
            retryable: false,
            message: reason,
          };
          return {
            text: `[Tool Blocked] ${reason}`,
            structuredError: err,
          };
        }
        if (preResult?.modifiedArgs) {
          Object.assign(toolArgs, preResult.modifiedArgs);
          applyHookToolArgs(toolCall, preResult.modifiedArgs);
        }
      }

      // --- Approval gates ---
      if (context.approvalGates) {
        const gateResult = await context.approvalGates.evaluate(toolName, toolArgs, hookContext);
        if (gateResult) {
          if (gateResult.decision === 'blocked') {
            const err: StructuredToolError = {
              type: 'APPROVAL_GATE_BLOCKED',
              retryable: false,
              message: gateResult.reason,
              detail: gateResult.recoveryPath,
            };
            return {
              text: `[Tool Blocked — ${toolName}] ${gateResult.reason}\n\nRecovery: ${gateResult.recoveryPath}`,
              structuredError: err,
            };
          }
          if (gateResult.decision === 'ask_user') {
            if (context.approvalCallback) {
              const approved = await context.approvalCallback({
                toolName,
                reason: gateResult.reason,
                recoveryPath: gateResult.recoveryPath,
                category: gateResult.category,
                args: toolArgs,
              });
              if (!approved) {
                return {
                  text: `[Approval Denied — ${toolName}] User denied approval.\n\nReason: ${gateResult.reason}`,
                };
              }
              // Approved — fall through to normal tool execution.
            } else {
              return {
                text: `[Approval Required — ${toolName}] This action requires explicit user approval.\n\nReason: ${gateResult.reason}\n\nUse ask_user to request permission before proceeding. Explain what you want to do and why.\n\nRecovery: ${gateResult.recoveryPath}`,
                structuredError: {
                  type: 'APPROVAL_GATE_BLOCKED',
                  retryable: true,
                  message: gateResult.reason,
                  detail: `Use ask_user to get approval. ${gateResult.recoveryPath}`,
                },
              };
            }
          }
        }
      }

      // Protect Main ran as a `PreToolUse` hook (see
      // `lib/default-pre-hooks.ts:createProtectMainPreHook`). The
      // `hookContext.getCurrentBranch` callback above lets the hook read
      // the sandbox branch lazily — only paid when a commit/push tool
      // actually dispatches.

      // --- Execute through the appropriate handler ---
      let result: ToolExecutionResult;

      switch (toolCall.source) {
        case 'github':
          result = await executeToolCall(toolCall.call, context.allowedRepo);
          break;

        case 'sandbox': {
          // The chat screens now pass `liveBinding ?? binding` through
          // `setLocalDaemonBinding`, so the runtime value can be either
          // a plain params binding or a `LiveDaemonBinding` wrapper.
          // The `LOCAL_DAEMON_SUPPORTED_TOOLS` gate below cares only
          // about presence (truthy / falsy), so this widening doesn't
          // change behaviour — but it stops the cast from lying about
          // the shape for any future code that wants to inspect it.
          const localDaemonBinding = context.localDaemonBinding as ToolDispatchBinding | undefined;
          if (!context.sandboxId && !localDaemonBinding) {
            // No read substrate at all (sandbox not started, no paired daemon).
            // Read-tier fallback (§11): degrade a read to GitHub rather than
            // blocking on a sandbox that doesn't exist yet.
            const fallback = await tryGitHubReadFallback(toolCall.call, context, 'no_sandbox');
            if (fallback) {
              result = fallback;
              break;
            }
            const err: StructuredToolError = {
              type: 'SANDBOX_UNREACHABLE',
              retryable: true,
              message: 'No active sandbox session',
              detail: `Attempted tool: ${toolCall.call.tool}`,
            };
            result = {
              text: `[Tool Error] No active sandbox. The sandbox may still be starting — wait a moment and retry. If this persists, the user needs to start a sandbox from the UI.\nerror_type: ${err.type}\nretryable: ${err.retryable}`,
              structuredError: err,
            };
            break;
          }
          // Local-PC sessions (binding present, no cloud sandboxId) can
          // only route tools that have a daemon implementation. Without
          // this gate, e.g. `sandbox_read_file` would reach the cloud
          // dispatcher with `sandboxId: ''` and fail against a nonexistent
          // sandbox instead of returning a clean "not yet supported" error.
          // See Codex P2 on PR #514. Extend LOCAL_DAEMON_SUPPORTED_TOOLS
          // as each tool's daemon path lands (PR 3c.3+).
          if (
            localDaemonBinding &&
            !context.sandboxId &&
            !LOCAL_DAEMON_SUPPORTED_TOOLS.has(toolCall.call.tool)
          ) {
            const err: StructuredToolError = {
              type: 'LOCAL_DAEMON_TOOL_UNSUPPORTED',
              retryable: false,
              message: `Tool "${toolCall.call.tool}" is not yet available on Local PC sessions.`,
              detail: `Only ${Array.from(LOCAL_DAEMON_SUPPORTED_TOOLS).join(', ')} routes through the paired daemon today. Per-tool daemon handlers land in PR 3c.3+.`,
            };
            result = {
              text: `[Tool Error — ${toolCall.call.tool}] ${err.message}\n${err.detail}`,
              structuredError: err,
            };
            break;
          }
          result = await executeSandboxToolCall(toolCall.call, context.sandboxId ?? '', {
            auditorProviderOverride: activeProvider,
            auditorModelOverride: context.activeModel,
            currentBranch: context.currentBranch,
            defaultBranch: context.defaultBranch,
            isMainProtected: context.isMainProtected,
            localDaemonBinding,
            abortSignal: context.abortSignal,
            onExecProgress: context.onExecProgress,
            memoryScope: {
              repoFullName: context.allowedRepo,
              branch: context.currentBranch,
              chatId: context.chatId,
            },
          });
          // Read-tier fallback (§11): a cloud sandbox that went unreachable
          // mid-session should not fail a read the GitHub tier can serve.
          // Cloud-only — local-PC daemon reads have their own re-pair path and
          // GitHub can't see the local working tree.
          if (context.sandboxId && result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
            const fallback = await tryGitHubReadFallback(
              toolCall.call,
              context,
              'sandbox_unreachable',
            );
            if (fallback) result = fallback;
          }
          break;
        }

        case 'delegate':
          result = { text: '[Tool Error] Delegation must be handled by the chat hook.' };
          break;

        case 'scratchpad':
          result = { text: '[Tool Error] Scratchpad must be handled by the chat hook.' };
          break;

        case 'todo':
          result = { text: '[Tool Error] Todo must be handled by the chat hook.' };
          break;

        case 'web-search': {
          const provider = activeProvider || getActiveProvider();
          result = await executeWebSearch(toolCall.call.args.query, provider);
          break;
        }

        case 'ask-user': {
          // Full Auto has no human at the keyboard, so a question card would
          // sit unanswered — and, worse, hidden inside a collapsed tool group —
          // while the model either stalls or silently answers for itself. The
          // FULL_AUTO_BLOCK prompt already says "never use ask_user," but a
          // prompt can't enforce it; honor the contract in the runtime so the
          // loop keeps moving. Paired with the card-emitting branch below so
          // ops can tell the two outcomes apart.
          if (getApprovalMode() === 'full-auto') {
            console.log(
              JSON.stringify({
                level: 'info',
                event: 'ask_user_auto_resolved',
                mode: 'full-auto',
                question: toolCall.call.args.question.slice(0, 160),
              }),
            );
            result = {
              text: '[Tool Result — ask_user] Full Auto mode: no user is available to answer. Choose the most reasonable option yourself and continue without asking.',
            };
            break;
          }
          console.log(
            JSON.stringify({
              level: 'info',
              event: 'ask_user_card_emitted',
              mode: getApprovalMode(),
            }),
          );
          result = {
            text: '[Tool Result] Question sent to user. The system will wait for their response.',
            card: { type: 'ask-user', data: toolCall.call.args },
          };
          break;
        }

        case 'artifacts': {
          if (!context.allowedRepo) {
            const err: StructuredToolError = {
              type: 'INVALID_ARG',
              retryable: false,
              message: 'Artifact creation requires an active repo.',
              detail: `NO_ACTIVE_REPO — Attempted tool: ${toolCall.call.tool}`,
            };
            result = {
              text: `[Tool Error] ${err.message}`,
              structuredError: err,
            };
            break;
          }
          // Web artifacts must be chat-scoped. The CLI files under
          // repo+branch by design (no chatId), but on the web the wider
          // scope causes cross-chat list pollution, so the runtime
          // refuses to persist a web artifact without one. Surface
          // misconfigured callers immediately as a non-retryable
          // INVALID_ARG rather than silently filing branch-scoped.
          if (!context.chatId) {
            const err: StructuredToolError = {
              type: 'INVALID_ARG',
              retryable: false,
              message: 'Artifact creation on the web surface requires a chat id.',
              detail: `MISSING_CHAT_ID — Attempted tool: ${toolCall.call.tool}`,
            };
            result = {
              text: `[Tool Error] ${err.message}`,
              structuredError: err,
            };
            break;
          }
          // Branch is best-effort: prefer the Push-tracked branch (sandbox-
          // independent), fall back to a live sandbox read, then to null. The
          // Worker accepts `branch: null` (CLI sessions outside a git repo do
          // the same), so an artifact filed before a sandbox warms up — or
          // while it's down — still persists, just under a wider scope.
          const branch =
            context.currentBranch ??
            (context.sandboxId ? await this.getSandboxBranch(context.sandboxId) : null);
          const scope: ArtifactScope = {
            repoFullName: context.allowedRepo,
            branch,
            chatId: context.chatId,
          };
          const author: ArtifactAuthor = {
            surface: 'web',
            role: context.role,
            createdAt: Date.now(),
          };
          result = await executeArtifactToolCall(toolCall.call.args, scope, author);
          break;
        }

        case 'memory': {
          if (!context.allowedRepo) {
            const err: StructuredToolError = {
              type: 'INVALID_ARG',
              retryable: false,
              message: 'Memory tools require an active repo.',
              detail: `NO_ACTIVE_REPO — Attempted tool: ${toolCall.call.tool}`,
            };
            result = {
              text: `[Tool Error — ${toolCall.call.tool}] ${err.message}`,
              structuredError: err,
            };
            break;
          }
          // Scope reads to the active repo/branch/chat from session context —
          // never from model args — so the model can't reach another repo's
          // memory. Prefer the Push-tracked branch so recall keeps working when
          // the sandbox is slow or down (memory is an availability surface, not
          // a safety gate); fall back to a live sandbox read, then to null.
          // Branch is best-effort (null when nothing is warm yet, or for
          // local-daemon sessions). The `chatId` filter still bounds reads to
          // the repo-scoped conversation; branch narrows the scope when known
          // but is no longer chat identity.
          const memBranch =
            context.currentBranch ??
            (context.sandboxId ? await this.getSandboxBranch(context.sandboxId) : null);
          const memCtx = {
            scope: {
              repoFullName: context.allowedRepo,
              branch: memBranch ?? undefined,
              chatId: context.chatId,
            },
            store: getDefaultMemoryStore(),
          };
          const memResult =
            toolCall.call.tool === 'memory_grep'
              ? await runMemoryGrep(toolCall.call.args, memCtx)
              : await runMemoryExpand(toolCall.call.args, memCtx);
          result = { text: memResult.text };
          break;
        }

        default:
          result = { text: '[Tool Error] Unknown tool source.' };
      }

      // --- Capability ledger ---
      if (context.capabilityLedger) {
        context.capabilityLedger.recordToolUse(toolName);
      }

      // --- Post-hooks ---
      if (context.hooks && context.hooks.post.length > 0) {
        const postResult = await evaluatePostHooks(
          context.hooks,
          toolName,
          toolArgs,
          result,
          hookContext,
        );
        if (postResult?.resultOverride) {
          result = { ...result, text: postResult.resultOverride };
        }
        if (postResult?.systemMessage) {
          result = { ...result, text: `${result.text}\n\n[Hook] ${postResult.systemMessage}` };
        }
        if (postResult?.action === 'inject' && postResult.injectMessage) {
          // injectMessage is typed `unknown` in lib so hooks aren't forced
          // to import the rich ChatMessage type. Web hooks construct
          // ChatMessage values; cast at the boundary where we know that's
          // what they passed.
          result = { ...result, postHookInject: postResult.injectMessage as ChatMessage };
        }
        if (postResult?.action === 'halt' && postResult.haltSummary) {
          result = { ...result, postHookHalt: postResult.haltSummary };
        }
      }

      context.emit?.toolExecutionComplete({
        toolName,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const structuredError: StructuredToolError = {
        type: 'UNKNOWN',
        retryable: true,
        message: `Unexpected error executing ${toolName}: ${message}`,
      };
      context.emit?.toolExecutionComplete({
        toolName,
        durationMs: Date.now() - startTime,
        error: structuredError,
      });
      return {
        text: `[Tool Error] ${structuredError.message}`,
        structuredError,
      };
    }
  }

  async getSandboxBranch(sandboxId: string): Promise<string | null> {
    return readSandboxBranch(sandboxId);
  }
}
