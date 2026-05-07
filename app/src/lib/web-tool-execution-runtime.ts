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
import { getToolCapabilities, ROLE_CAPABILITIES, roleCanUseTool } from '@push/lib/capabilities';
import { resolveToolName } from '@push/lib/tool-registry';

import type { StructuredToolError, ToolHookContext, ToolExecutionResult } from '@/types';
import { evaluatePreHooks, evaluatePostHooks, type ToolHookRegistry } from './tool-hooks';
import type { ApprovalGateRegistry } from './approval-gates';
import { executeToolCall } from './github-tools';
import { executeSandboxToolCall } from './sandbox-tools';
import { executeWebSearch } from './web-search-tools';
import { executeArtifactToolCall } from './artifact-tools';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
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

// ---------------------------------------------------------------------------
// Protect Main
// ---------------------------------------------------------------------------

const PROTECTED_MAIN_TOOLS = new Set(['sandbox_prepare_commit', 'sandbox_push']);

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
    const hookContext: ToolHookContext = {
      sandboxId: context.sandboxId,
      allowedRepo: context.allowedRepo,
      activeProvider,
      activeModel: context.activeModel,
      capabilityLedger: context.capabilityLedger,
    };

    context.emit?.toolExecutionStart({
      toolName,
      source: toolCall.source,
      toolCallId: (toolCall.call as { id?: string }).id ?? '',
    });
    const startTime = Date.now();

    try {
      // --- Runtime invariant: role capability check (step 6 of the
      // Architecture Remediation Plan) ---
      //
      // When the caller has declared a role on the context, enforce the
      // role's capability grant at the runtime layer — *before* hooks,
      // approval gates, or Protect Main run. The point of this check is
      // that it fires even when the policy-shaped hook was not registered
      // and when the prompt-side tool registry is wrong: the runtime is
      // the last line of defense, and the "Explorer cannot mutate"
      // invariant stops being a convention that depends on every caller
      // wiring it correctly.
      //
      // Fail-open for unknown tools so forward-compat stays intact
      // (`roleCanUseTool` already does this under the hood; the explicit
      // canonical-name resolve here protects against aliases and public
      // names reaching the check).
      if (context.role) {
        const canonicalName = resolveToolName(toolName) ?? toolName;
        if (!roleCanUseTool(context.role, canonicalName)) {
          const required = getToolCapabilities(canonicalName);
          const granted = Array.from(ROLE_CAPABILITIES[context.role] ?? []);
          const err: StructuredToolError = {
            type: 'ROLE_CAPABILITY_DENIED',
            retryable: false,
            message: `Role "${context.role}" is not allowed to use tool "${toolName}".`,
            detail: `Required: ${required.join(', ') || '(none)'} | Granted: ${granted.join(', ') || '(none)'}`,
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
            text: `[Tool Blocked — ${toolName}] ${err.message}\n\n${err.detail}`,
            structuredError: err,
          };
        }
      }

      // --- Pre-hooks ---
      if (context.hooks && context.hooks.pre.length > 0) {
        const preResult = await evaluatePreHooks(context.hooks, toolName, toolArgs, hookContext);
        if (preResult?.decision === 'deny') {
          return {
            text: `[Tool Blocked] ${preResult.reason || 'Blocked by pre-execution hook.'}`,
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
              const approved = await context.approvalCallback(
                toolName,
                gateResult.reason,
                gateResult.recoveryPath,
              );
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

      // --- Protect Main: block commit/push tools when on the default branch ---
      if (
        context.isMainProtected &&
        toolCall.source === 'sandbox' &&
        PROTECTED_MAIN_TOOLS.has(toolCall.call.tool) &&
        context.sandboxId
      ) {
        const currentBranch = await this.getSandboxBranch(context.sandboxId);
        const mainBranches = new Set(['main', 'master']);
        if (context.defaultBranch) mainBranches.add(context.defaultBranch);
        if (!currentBranch || mainBranches.has(currentBranch)) {
          return {
            text: `[Tool Error] Protect Main is enabled. Commits and pushes to the main/default branch are blocked. Create a new branch first (e.g. sandbox_exec with "git checkout -b feature/my-change"), then retry.`,
          };
        }
      }

      // --- Execute through the appropriate handler ---
      let result: ToolExecutionResult;

      switch (toolCall.source) {
        case 'github':
          result = await executeToolCall(toolCall.call, context.allowedRepo);
          break;

        case 'sandbox': {
          if (!context.sandboxId) {
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
          result = await executeSandboxToolCall(toolCall.call, context.sandboxId, {
            auditorProviderOverride: activeProvider,
            auditorModelOverride: context.activeModel,
          });
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

        case 'ask-user':
          result = {
            text: '[Tool Result] Question sent to user. The system will wait for their response.',
            card: { type: 'ask-user', data: toolCall.call.args },
          };
          break;

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
          // Branch is best-effort: fall back to null when no sandbox is
          // attached. The Worker accepts `branch: null` (CLI sessions
          // outside a git repo do the same), so an artifact filed before
          // a sandbox warms up still persists, just under a wider scope.
          const branch = context.sandboxId ? await this.getSandboxBranch(context.sandboxId) : null;
          const scope: ArtifactScope = {
            repoFullName: context.allowedRepo,
            branch,
            chatId: context.chatId,
          };
          const author: ArtifactAuthor = {
            surface: 'web',
            role: context.role ?? 'orchestrator',
            createdAt: Date.now(),
          };
          result = await executeArtifactToolCall(toolCall.call.args, scope, author);
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
          result = { ...result, postHookInject: postResult.injectMessage };
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
