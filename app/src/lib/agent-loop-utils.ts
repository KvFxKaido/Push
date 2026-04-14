/**
 * Shared utilities for agent loops (Explorer, Deep Reviewer).
 *
 * Extracted from explorer-agent.ts to avoid duplication across
 * read-only investigation agents.
 */

import type { ChatCard, ToolExecutionResult } from '@/types';
import { createDefaultApprovalGates, type ApprovalGateRegistry } from './approval-gates';
import type { AgentRole } from '@push/lib/runtime-contract';
import type { ToolExecutionRuntime } from '@push/lib/tool-execution-runtime';
import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import { type AnyToolCall } from './tool-dispatch';
import type { ToolHookRegistry } from './tool-hooks';
import type { ActiveProvider } from './orchestrator';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from './tracing';

export {
  truncateAgentContent,
  formatAgentToolResult,
  formatAgentParseError,
  MAX_TOOL_RESULT_SIZE,
} from '@push/lib/agent-loop-utils';

type WebRuntime = ToolExecutionRuntime<
  AnyToolCall,
  ToolExecutionResult,
  ToolHookRegistry,
  ApprovalGateRegistry
>;

const DEFAULT_APPROVAL_GATES = createDefaultApprovalGates();

/**
 * Optional tail parameters for `executeReadOnlyTool`.
 *
 * Promoted to an options bag so new opt-in fields (like the step-6
 * runtime invariant `role`) can be added without making call sites
 * pass positional `undefined` placeholders. The required per-run
 * bindings (repo, sandbox, provider, model, hooks) stay positional
 * because every caller has to know them.
 */
export interface ExecuteReadOnlyToolOptions {
  capabilityLedger?: import('./capabilities').CapabilityLedger;
  runtime?: WebRuntime;
  /**
   * Opt in to the runtime-level role capability check in
   * `WebToolExecutionRuntime`. When set, the runtime refuses any tool
   * the role cannot use — independent of whether the policy hook was
   * registered and independent of whether the read-only tool registry
   * was wired correctly for this call site.
   *
   * Explorer opts in. Deep Reviewer does not opt in yet because the
   * `reviewer` role's capability grant does not currently include
   * `web:search` but the deep-reviewer flow emits web-search tool
   * calls — that mismatch needs its own audit first.
   */
  role?: AgentRole;
}

/**
 * Execute a single read-only tool call with a no-repo guard.
 * Thin wrapper around executeAnyToolCall used by Explorer and Deep Reviewer.
 */
export async function executeReadOnlyTool(
  toolCall: AnyToolCall,
  allowedRepo: string,
  sandboxId: string | null,
  activeProvider: ActiveProvider,
  activeModel: string | undefined,
  hooks: ToolHookRegistry,
  options: ExecuteReadOnlyToolOptions = {},
): Promise<{ resultText: string; card?: ChatCard }> {
  const { capabilityLedger, runtime, role } = options;
  return withActiveSpan(
    'tool.execute',
    {
      scope: 'push.tools',
      kind: SpanKind.INTERNAL,
      attributes: {
        'push.tool.name': toolCall.call.tool,
        'push.tool.source': toolCall.source,
        'push.provider': activeProvider,
        'push.model': activeModel,
        // Default 'explorer' preserves the pre-existing span label for
        // callers that do not pass an explicit role (deep-reviewer today).
        'push.agent.role': role ?? 'explorer',
        'push.has_repo': Boolean(allowedRepo),
        'push.has_sandbox': Boolean(sandboxId),
      },
    },
    async (span) => {
      let resultText = '';
      const card: ChatCard | undefined = undefined;

      if (toolCall.source === 'github' && !allowedRepo) {
        resultText =
          '[Tool Error] No active repo selected — GitHub inspection tools are unavailable in this workspace.';
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'No active repo selected.',
        });
        return { resultText, card };
      }

      const executor: WebRuntime = runtime ?? new WebToolExecutionRuntime();
      const result = await executor.execute(toolCall, {
        allowedRepo,
        sandboxId,
        isMainProtected: false,
        activeProvider,
        activeModel,
        hooks,
        approvalGates: DEFAULT_APPROVAL_GATES,
        capabilityLedger,
        role,
      });
      resultText = result.text;
      const resultCard = result.card;

      setSpanAttributes(span, {
        'push.tool.error_type': result.structuredError?.type,
        'push.tool.retryable': result.structuredError?.retryable,
        'push.tool.card_type': resultCard?.type,
      });
      if (result.structuredError) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.structuredError.message,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      return { resultText, card: resultCard };
    },
  );
}
