/**
 * Shared utilities for agent loops (Explorer, Deep Reviewer).
 *
 * Extracted from explorer-agent.ts to avoid duplication across
 * read-only investigation agents.
 */

import type { ChatCard, ToolExecutionResult } from '@/types';
import { createDefaultApprovalGates, type ApprovalGateRegistry } from './approval-gates';
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
  capabilityLedger?: import('./capabilities').CapabilityLedger,
  runtime?: WebRuntime,
): Promise<{ resultText: string; card?: ChatCard }> {
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
        'push.agent.role': 'explorer',
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
