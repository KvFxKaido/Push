/**
 * DO-side assembly of `CoderBindingServices` for the background Coder
 * kernel. Takes the three adapters (detector / executor / stream) plus
 * per-run control-plane state and returns the shape
 * `lib/coder-agent-bindings.ts` expects.
 *
 * Intentional no-ops specific to the DO runtime:
 *  - Tracing adapter is a no-op (DO has no OTel wiring in PR #2).
 *  - Policy adapter is a permissive no-op — the DO runs with a
 *    pre-approved tool allowlist in Phase 1 per the runbook, so no
 *    per-turn gating is needed. `approvalModeBlock` is fixed to
 *    `full-auto` by the caller.
 *
 * The `CapabilityLedger` is constructed per-run in the DO's runLoop;
 * the Web shim's post-run `.snapshot()` call does not apply to
 * background jobs in Phase 1 (no client waiting synchronously to
 * attach it to a result object).
 */

import type {
  CoderBindingServices,
  CoderPolicyAdapter,
  CoderSpan,
  CoderTracingAdapter,
  CoderTurnContext,
} from '@push/lib/coder-agent-bindings';
import { CapabilityLedger } from '@push/lib/capabilities';
import type { CorrelationContext } from '@push/lib/correlation-context';
import type { ChatCard } from '@/types';
import type {
  AnyToolCall,
  CoderJobDetectorAdapter,
  SandboxToolCall,
  WebSearchToolCall,
} from './coder-job-detector-adapter';
import type { CoderJobExecutorAdapter } from './coder-job-executor-adapter';

/** All the DO-side inputs needed to stamp out a `CoderBindingServices`. */
export interface BuildCoderJobServicesArgs {
  detectors: CoderJobDetectorAdapter;
  executor: CoderJobExecutorAdapter;
  capabilityLedger: CapabilityLedger;
  turnCtx: CoderTurnContext;
  onStatus: (phase: string, detail?: string) => void;
  correlation?: CorrelationContext;
  activeProvider: string;
  activeModel: string | undefined;
  sandboxId: string;
}

export function buildCoderJobServices(
  args: BuildCoderJobServicesArgs,
): CoderBindingServices<AnyToolCall, SandboxToolCall, WebSearchToolCall, ChatCard> {
  return {
    policy: createNoOpPolicyAdapter(),
    capabilityLedger: args.capabilityLedger,
    turnCtx: args.turnCtx,
    onStatus: args.onStatus,
    correlation: args.correlation,
    activeProvider: args.activeProvider,
    activeModel: args.activeModel,
    sandboxId: args.sandboxId,
    tracing: createNoOpTracingAdapter(),
    executeSandboxToolCall: args.executor.executeSandboxToolCall,
    executeWebSearch: args.executor.executeWebSearch,
    sandboxStatus: args.executor.sandboxStatus,
    detectSandboxToolCall: args.detectors.detectSandboxToolCall,
    detectWebSearchToolCall: args.detectors.detectWebSearchToolCall,
    detectAnyToolCall: args.detectors.detectAnyToolCall,
    detectAllToolCalls: args.detectors.detectAllToolCalls,
    tagSandboxCall: args.detectors.tagSandboxCall,
    tagWebSearchCall: args.detectors.tagWebSearchCall,
  };
}

// ---------------------------------------------------------------------------
// No-op adapters
// ---------------------------------------------------------------------------

function createNoOpPolicyAdapter(): CoderPolicyAdapter {
  return {
    evaluateBeforeTool: async () => null,
    evaluateAfterTool: async () => null,
    evaluateAfterModel: async () => null,
  };
}

function createNoOpTracingAdapter(): CoderTracingAdapter {
  const noOpSpan: CoderSpan = { setStatus: () => {} };
  return {
    withActiveSpan: async <T>(
      _name: string,
      _options: unknown,
      fn: (span: CoderSpan) => Promise<T>,
    ): Promise<T> => fn(noOpSpan),
    setSpanAttributes: () => {},
    spanKindInternal: 0,
    spanStatusOk: 0,
    spanStatusError: 0,
  };
}
