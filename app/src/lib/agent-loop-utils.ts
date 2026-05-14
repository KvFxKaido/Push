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
import {
  correlationToSpanAttributes,
  EMPTY_CORRELATION_CONTEXT,
  type CorrelationContext,
} from '@push/lib/correlation-context';
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
 * Required parameters for `executeReadOnlyTool`'s options bag.
 *
 * `role` is required because `WebToolExecutionRuntime.execute` now
 * unconditionally enforces the role capability check at the kernel
 * level. The previous opt-in semantics (where callers could omit `role`
 * and silently bypass enforcement) closed audit item #3 from the
 * OpenCode silent-failure inventory.
 */
export interface ExecuteReadOnlyToolOptions {
  capabilityLedger?: import('./capabilities').CapabilityLedger;
  runtime?: WebRuntime;
  /**
   * Agent role making the call. Threaded into the runtime's
   * `ToolExecutionContext` so the kernel-level capability check fires
   * unconditionally. Explorer passes `'explorer'`; Deep Reviewer
   * passes `'reviewer'` (with `web:search` now granted to reviewer —
   * see `lib/capabilities.ts:ROLE_CAPABILITIES`).
   */
  role: AgentRole;
  /**
   * Passive correlation tags to attach to the tool-execution span as
   * `push.*` attributes (see `lib/correlation-context.ts`). Never alters
   * tool behavior.
   */
  correlation?: CorrelationContext;
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
  options: ExecuteReadOnlyToolOptions,
): Promise<{ resultText: string; card?: ChatCard }> {
  const { capabilityLedger, runtime, role, correlation } = options;
  return withActiveSpan(
    'tool.execute',
    {
      scope: 'push.tools',
      kind: SpanKind.INTERNAL,
      attributes: {
        ...correlationToSpanAttributes(correlation ?? EMPTY_CORRELATION_CONTEXT),
        'push.tool.name': toolCall.call.tool,
        'push.tool.source': toolCall.source,
        'push.provider': activeProvider,
        'push.model': activeModel,
        'push.agent.role': role,
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
