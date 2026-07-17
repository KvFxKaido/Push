/** Web `ChatMessage` adapter for the shared surface-neutral Coder policy. */

import type { ChatMessage } from '@/types';
import {
  BACKPRESSURE_MUTATION_THRESHOLD,
  createCoderPolicy as createSharedCoderPolicy,
  detectCognitiveDrift,
  VERIFICATION_COMMAND_PATTERN,
  type CoderPolicyAfterResult,
} from '@push/lib/coder-policy';
import type { TurnContext, TurnPolicy } from '../turn-policy';

export { BACKPRESSURE_MUTATION_THRESHOLD, detectCognitiveDrift, VERIFICATION_COMMAND_PATTERN };

function messageIdFor(result: Exclude<CoderPolicyAfterResult, null>, round: number): string {
  switch (result.code) {
    case 'cognitive_drift':
      return `policy-drift-correction-${round}`;
    case 'incomplete_completion':
      return `policy-no-fake-completion-${round}`;
    case 'announced_no_action':
      return `policy-announced-no-action-${round}`;
    case 'mutation_hard_failure':
      return `policy-mutation-hard-failure-${round}`;
    case 'verification_backpressure':
      return `policy-backpressure-${round}`;
    default:
      return `policy-${result.code}-${round}`;
  }
}

function adaptAfterResult(
  result: CoderPolicyAfterResult,
  ctx: TurnContext,
): { action: 'inject'; message: ChatMessage } | { action: 'halt'; summary: string } | null {
  if (!result) return null;
  if (result.action === 'halt') return { action: 'halt', summary: result.summary };
  return {
    action: 'inject',
    message: {
      id: messageIdFor(result, ctx.round),
      role: 'user',
      content: result.content,
      timestamp: Date.now(),
    },
  };
}

export function createCoderPolicy(): TurnPolicy {
  const shared = createSharedCoderPolicy({
    onEvent: (event) => {
      console.log(
        JSON.stringify({ level: event.event.endsWith('exhausted') ? 'warn' : 'info', ...event }),
      );
    },
  });

  return {
    name: 'coder-core',
    role: 'coder',
    beforeToolExec: [
      async (toolName, args, ctx) => {
        const result = await shared.evaluateBeforeTool(toolName, args, ctx);
        return result ? { action: 'deny', reason: result.reason } : null;
      },
    ],
    afterModelCall: [
      async (response, messages, ctx) =>
        adaptAfterResult(await shared.evaluateAfterModel(response, messages, ctx), ctx),
    ],
    afterToolExec: [
      async (toolName, args, resultText, hasError, ctx) =>
        adaptAfterResult(
          await shared.evaluateAfterTool(toolName, args, resultText, hasError, ctx),
          ctx,
        ),
    ],
  };
}
