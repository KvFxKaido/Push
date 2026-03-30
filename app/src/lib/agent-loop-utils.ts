/**
 * Shared utilities for agent loops (Explorer, Deep Reviewer).
 *
 * Extracted from explorer-agent.ts to avoid duplication across
 * read-only investigation agents.
 */

import type { ChatCard } from '@/types';
import { createDefaultApprovalGates } from './approval-gates';
import {
  executeAnyToolCall,
  type AnyToolCall,
} from './tool-dispatch';
import type { ToolHookRegistry } from './tool-hooks';
import type { ActiveProvider } from './orchestrator';
import { formatToolResultEnvelope } from './tool-call-recovery';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from './tracing';

const MAX_TOOL_RESULT_SIZE = 8_000;
const DEFAULT_APPROVAL_GATES = createDefaultApprovalGates();

/** Truncate content with a descriptive tail marker. */
export function truncateAgentContent(content: string, maxLen: number, label = 'content'): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}\n\n[${label} truncated at ${maxLen.toLocaleString()} chars]`;
}

/** Wrap a tool result in the `[TOOL_RESULT]` envelope agents expect. */
export function formatAgentToolResult(result: string): string {
  return formatToolResultEnvelope(truncateAgentContent(result, MAX_TOOL_RESULT_SIZE, 'tool result'));
}

/** Wrap a parse/dispatch error in the same envelope so it reaches the model cleanly. */
export function formatAgentParseError(message: string): string {
  return formatToolResultEnvelope(message);
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
): Promise<{ resultText: string; card?: ChatCard }> {
  return withActiveSpan('tool.execute', {
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
  }, async (span) => {
    let resultText = '';
    const card: ChatCard | undefined = undefined;

    if (toolCall.source === 'github' && !allowedRepo) {
      resultText = '[Tool Error] No active repo selected — GitHub inspection tools are unavailable in this workspace.';
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'No active repo selected.',
      });
      return { resultText, card };
    }

    const result = await executeAnyToolCall(
      toolCall,
      allowedRepo,
      sandboxId,
      false,
      undefined,
      activeProvider,
      activeModel,
      hooks,
      DEFAULT_APPROVAL_GATES,
    );
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
  });
}
