import type {
  ToolExecutionRuntime,
  ToolExecutionContext,
  AnyToolCall as RuntimeAnyToolCall,
  ToolExecutionResult as RuntimeToolExecutionResult,
} from '@push/lib/tool-execution-runtime';

import type { StructuredToolError, ToolHookContext, ToolExecutionResult } from '@/types';
import { evaluatePreHooks, evaluatePostHooks, type ToolHookRegistry } from './tool-hooks';
import type { ApprovalGateRegistry } from './approval-gates';
import { executeToolCall } from './github-tools';
import { executeSandboxToolCall } from './sandbox-tools';
import { executeWebSearch } from './web-search-tools';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { type AnyToolCall } from './tool-dispatch';
import { execInSandbox } from './sandbox-client';

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
      return { ...toolCall.call.args };
    case 'scratchpad':
      return toolCall.call.content ? { content: toolCall.call.content } : {};
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
      Object.assign(toolCall.call.args, modifiedArgs);
      return;
    case 'scratchpad':
      if (typeof modifiedArgs.content === 'string') {
        toolCall.call.content = modifiedArgs.content;
      }
      return;
    default:
      return;
  }
}

const PROTECTED_MAIN_TOOLS = new Set(['sandbox_prepare_commit', 'sandbox_push']);

export async function getSandboxBranch(sandboxId: string): Promise<string | null> {
  try {
    const result = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
    if (result.exitCode === 0 && result.stdout?.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Best-effort — fail-safe (return null → will block)
  }
  return null;
}
import type { CapabilityLedger } from './capabilities';

/**
 * Web-specific implementation of the ToolExecutionRuntime interface.
 * Wraps the existing per-source executors (github, sandbox, web-search)
 * and evaluates pre/post hooks, approval gates, and protect-main rules.
 */
export class WebToolExecutionRuntime implements ToolExecutionRuntime {
  async execute(
    toolCall: RuntimeAnyToolCall,
    context: ToolExecutionContext,
  ): Promise<RuntimeToolExecutionResult> {
    const typedToolCall = toolCall as AnyToolCall;
    const typedContext = context as ToolExecutionContext & {
      hooks?: ToolHookRegistry;
      approvalGates?: ApprovalGateRegistry;
      capabilityLedger?: CapabilityLedger;
      activeProvider?: ActiveProvider;
    };

    const toolName = getHookToolName(typedToolCall);
    const toolArgs = getHookToolArgs(typedToolCall);
    const hookContext: ToolHookContext = {
      sandboxId: context.sandboxId,
      allowedRepo: context.allowedRepo,
      activeProvider: typedContext.activeProvider,
      activeModel: context.activeModel,
      capabilityLedger: typedContext.capabilityLedger,
    };

    // Emit start event
    if (context.emit) {
      context.emit.toolExecutionStart({
        toolName,
        source: typedToolCall.source,
        toolCallId: (typedToolCall.call as { id?: string }).id ?? '',
      });
    }
    const startTime = Date.now();

    try {
      // --- Pre-hooks evaluation ---
      if (typedContext.hooks && typedContext.hooks.pre.length > 0) {
        const preResult = await evaluatePreHooks(
          typedContext.hooks,
          toolName,
          toolArgs,
          hookContext,
        );

        if (preResult?.decision === 'deny') {
          return {
            text: `[Tool Blocked] ${preResult.reason || 'Blocked by pre-execution hook.'}`,
          } as RuntimeToolExecutionResult;
        }

        // Apply modified args if a hook rewrote them
        if (preResult?.modifiedArgs) {
          Object.assign(toolArgs, preResult.modifiedArgs);
          applyHookToolArgs(typedToolCall, preResult.modifiedArgs);
        }
      }

      // --- Approval gate evaluation ---
      if (typedContext.approvalGates) {
        const gateResult = await typedContext.approvalGates.evaluate(
          toolName,
          toolArgs,
          hookContext,
        );
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
            } as RuntimeToolExecutionResult;
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
                } as RuntimeToolExecutionResult;
              }
              // Approved — fall through to normal tool execution below.
            } else {
              return {
                text: `[Approval Required — ${toolName}] This action requires explicit user approval.\n\nReason: ${gateResult.reason}\n\nUse ask_user to request permission before proceeding. Explain what you want to do and why.\n\nRecovery: ${gateResult.recoveryPath}`,
                structuredError: {
                  type: 'APPROVAL_GATE_BLOCKED',
                  retryable: true,
                  message: gateResult.reason,
                  detail: `Use ask_user to get approval. ${gateResult.recoveryPath}`,
                },
              } as RuntimeToolExecutionResult;
            }
          }
        }
      }

      // Enforce Protect Main: block commit/push tools when on the default branch
      if (
        context.isMainProtected &&
        typedToolCall.source === 'sandbox' &&
        PROTECTED_MAIN_TOOLS.has(typedToolCall.call.tool) &&
        context.sandboxId
      ) {
        const currentBranch = await this.getSandboxBranch(context.sandboxId);
        const mainBranches = new Set(['main', 'master']);
        if (context.defaultBranch) mainBranches.add(context.defaultBranch);
        // Block if we can't determine the branch (fail-safe) or if we're on the default branch
        if (!currentBranch || mainBranches.has(currentBranch)) {
          return {
            text: `[Tool Error] Protect Main is enabled. Commits and pushes to the main/default branch are blocked. Create a new branch first (e.g. sandbox_exec with "git checkout -b feature/my-change"), then retry.`,
          } as RuntimeToolExecutionResult;
        }
      }

      // Execute through the appropriate handler
      let result: ToolExecutionResult;

      switch (typedToolCall.source) {
        case 'github':
          result = await executeToolCall(
            typedToolCall.call as import('./github-tools').ToolCall,
            context.allowedRepo,
          );
          break;

        case 'sandbox':
          if (!context.sandboxId) {
            const err: StructuredToolError = {
              type: 'SANDBOX_UNREACHABLE',
              retryable: true,
              message: 'No active sandbox session',
              detail: `Attempted tool: ${typedToolCall.call.tool}`,
            };
            result = {
              text: `[Tool Error] No active sandbox. The sandbox may still be starting — wait a moment and retry. If this persists, the user needs to start a sandbox from the UI.\nerror_type: ${err.type}\nretryable: ${err.retryable}`,
              structuredError: err,
            };
            break;
          }
          result = await executeSandboxToolCall(
            typedToolCall.call as import('./sandbox-tools').SandboxToolCall,
            context.sandboxId,
            {
              auditorProviderOverride: typedContext.activeProvider,
              auditorModelOverride: context.activeModel,
            },
          );
          break;

        case 'delegate':
          result = { text: '[Tool Error] Delegation must be handled by the chat hook.' };
          break;

        case 'scratchpad':
          result = { text: '[Tool Error] Scratchpad must be handled by the chat hook.' };
          break;

        case 'web-search': {
          const provider = typedContext.activeProvider || getActiveProvider();
          result = await executeWebSearch(
            (typedToolCall.call as import('./web-search-tools').WebSearchToolCall).args.query,
            provider,
          );
          break;
        }

        case 'ask-user':
          result = {
            text: '[Tool Result] Question sent to user. The system will wait for their response.',
            card: {
              type: 'ask-user',
              data: (typedToolCall.call as import('./ask-user-tools').AskUserToolCall).args,
            },
          };
          break;

        default:
          result = { text: '[Tool Error] Unknown tool source.' };
      }

      // --- Record capability usage ---
      if (typedContext.capabilityLedger) {
        typedContext.capabilityLedger.recordToolUse(toolName);
      }

      // --- Post-hooks evaluation ---
      if (typedContext.hooks && typedContext.hooks.post.length > 0) {
        const postResult = await evaluatePostHooks(
          typedContext.hooks,
          toolName,
          toolArgs,
          result,
          hookContext,
        );

        if (postResult?.resultOverride) {
          result = { ...result, text: postResult.resultOverride };
        }
        // systemMessage is returned to the caller for injection into the conversation
        if (postResult?.systemMessage) {
          result = { ...result, text: `${result.text}\n\n[Hook] ${postResult.systemMessage}` };
        }
        // Policy actions: inject/halt flow through ToolExecutionResult to the caller
        if (postResult?.action === 'inject' && postResult.injectMessage) {
          result = { ...result, postHookInject: postResult.injectMessage };
        }
        if (postResult?.action === 'halt' && postResult.haltSummary) {
          result = { ...result, postHookHalt: postResult.haltSummary };
        }
      }

      if (context.emit) {
        context.emit.toolExecutionComplete({
          toolName,
          durationMs: Date.now() - startTime,
        });
      }

      return result as RuntimeToolExecutionResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const structuredError: StructuredToolError = {
        type: 'UNKNOWN',
        retryable: true,
        message: `Unexpected error executing ${toolName}: ${message}`,
      };
      if (context.emit) {
        context.emit.toolExecutionComplete({
          toolName,
          durationMs: Date.now() - startTime,
          error: structuredError,
        });
      }
      return {
        text: `[Tool Error] ${structuredError.message}`,
        structuredError,
      } as RuntimeToolExecutionResult;
    }
  }

  async getSandboxBranch(sandboxId: string): Promise<string | null> {
    return getSandboxBranch(sandboxId);
  }
}
