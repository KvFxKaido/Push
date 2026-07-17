/**
 * Direct-kernel adapter for hosts that do not use `coder-agent-bindings`.
 *
 * The Web and Worker runtimes already route policy through the bindings layer.
 * CLI daemon delegations hand a native executor directly to `runCoderAgent`,
 * so this adapter owns the otherwise-repeated before-tool, after-tool, and
 * after-model translation without pulling CLI types into the shared policy.
 */

import type {
  CoderAfterModelResult,
  CoderToolExecContext,
  CoderToolExecResult,
} from './coder-agent.js';
import {
  createCoderPolicy,
  type CoderPolicyContext,
  type CoderRuntimePolicy,
} from './coder-policy.js';
import type { ToolCard } from './tool-cards.js';

interface StructuralToolCall {
  tool?: unknown;
  args?: unknown;
}

export interface CoderPolicyKernelAdapterOptions<TCard extends ToolCard = ToolCard> {
  context: CoderPolicyContext;
  execute: (
    call: unknown,
    execContext: CoderToolExecContext,
  ) => Promise<CoderToolExecResult<TCard>>;
  policy?: CoderRuntimePolicy;
}

export interface CoderPolicyKernelAdapter<TCard extends ToolCard = ToolCard> {
  policy: CoderRuntimePolicy;
  context: CoderPolicyContext;
  toolExec: (
    call: unknown,
    execContext: CoderToolExecContext,
  ) => Promise<CoderToolExecResult<TCard>>;
  evaluateAfterModel: (response: string, round: number) => Promise<CoderAfterModelResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function unwrapToolCall(call: unknown): StructuralToolCall | null {
  const wrapper = asRecord(call);
  if (!wrapper) return null;
  return (asRecord(wrapper.call) ?? wrapper) as StructuralToolCall;
}

function toPolicyPost(
  result: Awaited<ReturnType<CoderRuntimePolicy['evaluateAfterTool']>>,
): { kind: 'inject'; content: string } | { kind: 'halt'; summary: string } | undefined {
  if (!result) return undefined;
  return result.action === 'inject'
    ? { kind: 'inject', content: result.content }
    : { kind: 'halt', summary: result.summary };
}

export function createCoderPolicyKernelAdapter<TCard extends ToolCard = ToolCard>(
  options: CoderPolicyKernelAdapterOptions<TCard>,
): CoderPolicyKernelAdapter<TCard> {
  const policy = options.policy ?? createCoderPolicy();
  const context = options.context;

  return {
    policy,
    context,
    async evaluateAfterModel(response, round) {
      context.round = round;
      const result = await policy.evaluateAfterModel(response, [], context);
      if (!result) return null;
      if (result.action === 'halt') return { action: 'halt', summary: result.summary };
      return {
        action: 'inject',
        content: result.content,
        forceToolChoiceNextRound: result.code === 'announced_no_action',
      };
    },
    async toolExec(call, execContext) {
      context.round = execContext.round;
      context.phase = execContext.phase;

      const rawCall = unwrapToolCall(call);
      const toolName = typeof rawCall?.tool === 'string' ? rawCall.tool : '';
      const args = asRecord(rawCall?.args) ?? {};

      if (toolName) {
        const before = await policy.evaluateBeforeTool(toolName, args, context);
        if (before) return { kind: 'denied', reason: before.reason };
      }

      const result = await options.execute(call, execContext);
      if (result.kind !== 'executed' || !toolName) return result;

      const after = await policy.evaluateAfterTool(
        toolName,
        args,
        result.resultText,
        Boolean(result.errorType),
        context,
      );
      const policyPost = toPolicyPost(after);
      return policyPost ? { ...result, policyPost } : result;
    },
  };
}
