/**
 * Coder agent bindings — shared DI-wiring layer between Web and server
 * (Durable Object) runtimes.
 *
 * `app/src/lib/coder-agent.ts` historically built three interlocking
 * closures inline — the tool-exec closure, the Coder-specific detector
 * composition, and the after-model policy bridge — each deeply coupled
 * to the 10 `CoderAgentOptions` DI slots of `lib/coder-agent.ts`. The
 * background-jobs Phase 1 plan (see
 * `docs/runbooks/Background Coder Tasks Phase 1.md`) needs the same
 * closures available in a Durable Object context, with Web-only
 * dependencies (localStorage approval mode, browser tracing, client
 * HTTP helpers) replaced by server equivalents.
 *
 * This module exposes the three closure builders against a small
 * structural services interface. Types are duck-typed deliberately to
 * avoid dragging Web-side definitions (`ChatMessage`, OTel `SpanKind`)
 * into `lib/`. The Web shim's concrete `TurnPolicyRegistry`,
 * `TurnContext`, and OTel primitives satisfy these interfaces
 * structurally; the DO side will assemble its own stubs from scratch.
 *
 * No behavior change from the pre-extraction inline closures — this is
 * a mechanical lift of the same logic with the call boundary named.
 */

import { type CapabilityLedger, enforceRoleCapability } from './capabilities.js';
import {
  correlationToSpanAttributes,
  EMPTY_CORRELATION_CONTEXT,
  type CorrelationContext,
} from './correlation-context.js';
import type {
  CoderAfterModelResult,
  CoderToolExecResult,
  DetectedToolCalls,
} from './coder-agent.js';

// ---------------------------------------------------------------------------
// Structural duck-types — match the Web shim's concrete types without
// importing them. `TurnContext` and `TurnPolicyRegistry` live in
// `app/src/lib/turn-policy.ts` and pull in `ChatMessage` (a Web type) via
// `AfterModelResult.message`. The Web concrete types satisfy these
// interfaces by return-type covariance.
// ---------------------------------------------------------------------------

/** Mutable per-turn context threaded into every policy check.
 *
 * `role` is kept as `string` rather than a literal so the Web shim's
 * broader `AgentRole` union (`'orchestrator' | 'coder' | ...`)
 * structurally satisfies this interface without a cast. */
export interface CoderTurnContext {
  role: string;
  round: number;
  phase?: string;
  maxRounds: number;
  sandboxId: string | null;
  allowedRepo: string;
  activeProvider?: string;
  activeModel?: string;
  signal?: AbortSignal;
}

/** Minimal after-tool / after-model directive — Web's policy registry
 * returns a richer `ChatMessage`, which structurally satisfies the
 * narrower `{ content: string }` shape this builder actually reads. */
export type CoderPolicyInjectOrHalt =
  | { action: 'inject'; message: { content: string } }
  | { action: 'halt'; summary: string }
  | null;

export interface CoderPolicyAdapter {
  evaluateBeforeTool(
    tool: string,
    args: Record<string, unknown>,
    ctx: CoderTurnContext,
  ): Promise<{ action: 'deny'; reason: string } | null>;
  evaluateAfterTool(
    tool: string,
    args: Record<string, unknown>,
    resultText: string,
    hasError: boolean,
    ctx: CoderTurnContext,
  ): Promise<CoderPolicyInjectOrHalt>;
  evaluateAfterModel(
    response: string,
    messages: readonly unknown[],
    ctx: CoderTurnContext,
  ): Promise<CoderPolicyInjectOrHalt>;
}

/** Minimal OTel span surface the tool-exec closure reads. */
export interface CoderSpan {
  setStatus(status: { code: unknown; message?: string }): void;
}

/** Tracing adapter — Web passes the real OTel wiring, DO passes no-ops. */
export interface CoderTracingAdapter {
  withActiveSpan<T>(
    name: string,
    options: {
      scope?: string;
      kind?: unknown;
      attributes?: Record<string, unknown>;
    },
    fn: (span: CoderSpan) => Promise<T>,
  ): Promise<T>;
  setSpanAttributes(span: CoderSpan, attributes: Record<string, unknown>): void;
  /** Well-known `SpanKind.INTERNAL` value (OTel: enum member). */
  spanKindInternal: unknown;
  /** Well-known `SpanStatusCode.OK` value. */
  spanStatusOk: unknown;
  /** Well-known `SpanStatusCode.ERROR` value. */
  spanStatusError: unknown;
}

/** Headless-side observability metadata for branch-affecting tools.
 *
 * The boundary rule: foreground tools emit `branchSwitch` for UI routing
 * (conversation migration / chat selection); background-job tools emit
 * `meta` for logs and future observability features only — no chat or
 * routing side effects fire from a background result.
 *
 * Shape is intentionally broad so future headless branch-affecting
 * producers (e.g. a backgrounded `sandbox_switch_branch`) inherit the
 * contract without churn. Slice 3 wires only the `branchCreated`
 * producer; `branchSwitched` is reserved.
 */
export interface SandboxToolMeta {
  branchCreated?: { name: string };
  branchSwitched?: { name: string };
}

/** Minimal sandbox/web-search tool-execution result shape the
 * tool-exec closure consumes. The richer Web `ToolExecutionResult`
 * satisfies this structurally. */
export interface SandboxToolExecResult<TCard> {
  text: string;
  card?: TCard;
  structuredError?: {
    type: string;
    retryable: boolean;
    message: string;
  };
  /** Background-side observability for branch-affecting tools. See
   *  `SandboxToolMeta`. Undefined for foreground results — those use
   *  the richer `branchSwitch` field on the Web `ToolExecutionResult`
   *  instead, which carries UI-routing semantics. */
  meta?: SandboxToolMeta;
}

export interface SandboxStatusResult {
  error?: string;
  head: string;
  changedFiles: readonly unknown[];
}

/** Tagged call discriminators understood by the Coder closure.
 *
 * `TCoderCall` is expected to have at least `source` and `call.tool`.
 * `call.args` is read as `unknown` by the builder and coerced to
 * `Record<string, unknown>` at the policy/HTTP call sites, so we don't
 * constrain its shape here — concrete tagged-call types whose args have
 * nominal types (e.g. `CoderDelegationArgs`) still satisfy this. */
export interface TaggedCallShape {
  source: string;
  call: { tool: string; args?: unknown };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Services the Coder closures need. Grouped into three loose clusters:
 *  - control-plane state: policy, capability ledger, turnCtx, statusFn
 *  - tracing: wrapper + span kind/status constants
 *  - execution: sandbox/web HTTP callers + detectors
 *
 * `TSandboxCall` is the Web's `SandboxToolCall` (or the DO's equivalent);
 * `TWebSearchCall` is the detected web-search payload shape; `TCoderCall`
 * is the tagged-union superset both tags fall under.
 */
export interface CoderBindingServices<
  TCoderCall extends TaggedCallShape,
  TSandboxCall,
  TWebSearchCall extends { args: { query: string } },
  TCard,
> {
  // --- control plane ---
  policy: CoderPolicyAdapter;
  capabilityLedger: CapabilityLedger;
  turnCtx: CoderTurnContext;
  onStatus: (phase: string, detail?: string) => void;
  correlation?: CorrelationContext;
  activeProvider: string;
  activeModel: string | undefined;
  sandboxId: string;

  // --- tracing ---
  tracing: CoderTracingAdapter;

  // --- execution ---
  executeSandboxToolCall: (
    call: TSandboxCall,
    sandboxId: string,
    opts: { auditorProviderOverride: string; auditorModelOverride: string | undefined },
  ) => Promise<SandboxToolExecResult<TCard>>;
  executeWebSearch: (query: string, provider: string) => Promise<SandboxToolExecResult<TCard>>;
  sandboxStatus: (sandboxId: string) => Promise<SandboxStatusResult>;

  // --- detectors ---
  /** Raw sandbox-call detector. Web shim tags the result as
   * `{ source: 'sandbox', call }` via `tagSandboxCall`. */
  detectSandboxToolCall: (text: string) => TSandboxCall | null;
  detectWebSearchToolCall: (text: string) => TWebSearchCall | null;
  /** Full tagged-detector (used for fallback recovery and the multi-call
   * parallel-reads detector). Returns any source; Coder filters to
   * sandbox/web-search. */
  detectAnyToolCall: (text: string) => TCoderCall | null;
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCoderCall>;
  /** Pure factories that wrap a raw detection into the tagged shape. */
  tagSandboxCall: (call: TSandboxCall) => TCoderCall;
  tagWebSearchCall: (call: TWebSearchCall) => TCoderCall;
}

// ---------------------------------------------------------------------------
// buildCoderDetectors — produces the filtered detector pair the lib kernel
// consumes. Sandbox-only parallel reads; web-search allowed as a single call.
// ---------------------------------------------------------------------------

export function buildCoderDetectors<
  TCoderCall extends TaggedCallShape,
  TSandboxCall,
  TWebSearchCall extends { args: { query: string } },
  TCard,
>(
  services: CoderBindingServices<TCoderCall, TSandboxCall, TWebSearchCall, TCard>,
): {
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCoderCall>;
  detectAnyToolCall: (text: string) => TCoderCall | null;
} {
  const detectAllToolCalls = (text: string): DetectedToolCalls<TCoderCall> => {
    const raw = services.detectAllToolCalls(text);
    const sandboxReads = raw.readOnly.filter((c) => c.source === 'sandbox');
    const sandboxFileMutations = raw.fileMutations.filter((c) => c.source === 'sandbox');
    const sandboxMutating = raw.mutating?.source === 'sandbox' ? raw.mutating : null;
    return {
      readOnly: sandboxReads,
      fileMutations: sandboxFileMutations,
      mutating: sandboxMutating,
      extraMutations: raw.extraMutations,
    };
  };

  const detectAnyToolCall = (text: string): TCoderCall | null => {
    const sandboxCall = services.detectSandboxToolCall(text);
    if (sandboxCall) return services.tagSandboxCall(sandboxCall);

    const webSearchCall = services.detectWebSearchToolCall(text);
    if (webSearchCall) return services.tagWebSearchCall(webSearchCall);

    const recovered = services.detectAnyToolCall(text);
    if (recovered?.source === 'sandbox' || recovered?.source === 'web-search') {
      return recovered;
    }
    return null;
  };

  return { detectAllToolCalls, detectAnyToolCall };
}

// ---------------------------------------------------------------------------
// buildCoderEvaluateAfterModel — thin adapter from the policy registry's
// `AfterModelResult` to the lib kernel's flattened `CoderAfterModelResult`.
// ---------------------------------------------------------------------------

export function buildCoderEvaluateAfterModel<
  TCoderCall extends TaggedCallShape,
  TSandboxCall,
  TWebSearchCall extends { args: { query: string } },
  TCard,
>(
  services: CoderBindingServices<TCoderCall, TSandboxCall, TWebSearchCall, TCard>,
): (response: string, round: number) => Promise<CoderAfterModelResult> {
  return async (response: string, round: number): Promise<CoderAfterModelResult> => {
    services.turnCtx.round = round;
    // Coder policy's afterModelCall hooks ignore `messages`; passing an
    // empty buffer keeps the lib kernel free of ChatMessage coupling.
    const result = await services.policy.evaluateAfterModel(response, [], services.turnCtx);
    if (!result) return null;
    if (result.action === 'halt') {
      return { action: 'halt', summary: result.summary };
    }
    return { action: 'inject', content: result.message.content };
  };
}

// ---------------------------------------------------------------------------
// buildCoderToolExec — the beefy tool-exec closure. Bakes policy pre/post
// hooks, capability-ledger enforcement, OTel span attributes, and the
// sandbox-unreachable health probe into the lib kernel's flattened
// `CoderToolExecResult` shape.
// ---------------------------------------------------------------------------

export function buildCoderToolExec<
  TCoderCall extends TaggedCallShape,
  TSandboxCall,
  TWebSearchCall extends { args: { query: string } },
  TCard,
>(
  services: CoderBindingServices<TCoderCall, TSandboxCall, TWebSearchCall, TCard>,
): (
  call: TCoderCall,
  execCtx: { round: number; phase?: string },
) => Promise<CoderToolExecResult<TCard>> {
  const {
    policy,
    capabilityLedger,
    turnCtx,
    onStatus,
    correlation,
    activeProvider,
    activeModel,
    sandboxId,
    tracing,
    executeSandboxToolCall,
    executeWebSearch,
    sandboxStatus,
  } = services;

  return async (
    call: TCoderCall,
    execCtx: { round: number; phase?: string },
  ): Promise<CoderToolExecResult<TCard>> => {
    turnCtx.round = execCtx.round;
    turnCtx.phase = execCtx.phase;

    if (call.source !== 'sandbox' && call.source !== 'web-search') {
      return {
        kind: 'denied',
        reason: `Coder can only execute sandbox and web_search tools. "${call.call.tool}" is not available to Coder.`,
      };
    }

    // --- Kernel role-capability check ---
    //
    // The Coder web path bypasses `WebToolExecutionRuntime` entirely
    // (the tool-exec closure dispatches directly to
    // `executeSandboxToolCall` / `executeWebSearch`). Without this
    // inline check, the kernel role gate that fires elsewhere on the
    // web surface — and on the CLI — would skip Coder, leaving
    // capability enforcement binding-dependent for this path. Closes
    // the remaining loophole from audit item #3 in the OpenCode
    // silent-failure inventory.
    //
    // `coder` is hardcoded because this binding is single-role by
    // construction (the builder is only instantiated from
    // `runCoderAgent`). Fail-open for unmapped tool names is preserved
    // by `enforceRoleCapability` so a new sandbox/web-search tool that
    // hasn't been added to TOOL_CAPABILITIES yet doesn't break the
    // delegation.
    const roleCheck = enforceRoleCapability('coder', call.call.tool);
    if (!roleCheck.ok) {
      return {
        kind: 'denied',
        reason: `${roleCheck.message} ${roleCheck.detail}`,
      };
    }

    // --- Phase-aware tool gating ---
    const beforeResult = await policy.evaluateBeforeTool(
      call.call.tool,
      (call.call.args ?? {}) as Record<string, unknown>,
      turnCtx,
    );
    if (beforeResult?.action === 'deny') {
      return { kind: 'denied', reason: beforeResult.reason };
    }

    // --- Web search path ---
    if (call.source === 'web-search') {
      const wsArgs = call.call.args as { query: string };
      const wsResult = await tracing.withActiveSpan(
        'tool.execute',
        {
          scope: 'push.coder',
          kind: tracing.spanKindInternal,
          attributes: {
            ...correlationToSpanAttributes(correlation ?? EMPTY_CORRELATION_CONTEXT),
            'push.agent.role': 'coder',
            'push.round': execCtx.round,
            'push.tool.name': 'web_search',
            'push.tool.source': 'web-search',
            'push.provider': activeProvider,
            'push.model': activeModel,
          },
        },
        async (span) => {
          if (!capabilityLedger.isToolAllowed('web_search')) {
            const missing = capabilityLedger.getMissingCapabilities('web_search');
            return {
              text: `[Tool Blocked — web_search] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
              structuredError: {
                type: 'APPROVAL_GATE_BLOCKED',
                retryable: false,
                message: `Capability violation: ${missing.join(', ')} not declared`,
              },
            } satisfies SandboxToolExecResult<TCard>;
          }
          const inner = await executeWebSearch(wsArgs.query, activeProvider);
          capabilityLedger.recordToolUse('web_search');
          tracing.setSpanAttributes(span, {
            'push.tool.error_type': inner.structuredError?.type,
            'push.tool.retryable': inner.structuredError?.retryable,
          });
          if (inner.structuredError) {
            span.setStatus({
              code: tracing.spanStatusError,
              message: inner.structuredError.message,
            });
          } else {
            span.setStatus({ code: tracing.spanStatusOk });
          }
          return inner;
        },
      );

      const afterToolResult = await policy.evaluateAfterTool(
        'web_search',
        (call.call.args ?? {}) as Record<string, unknown>,
        wsResult.text,
        Boolean(wsResult.structuredError),
        turnCtx,
      );
      const policyPost =
        afterToolResult?.action === 'inject'
          ? { kind: 'inject' as const, content: afterToolResult.message.content }
          : afterToolResult?.action === 'halt'
            ? { kind: 'halt' as const, summary: afterToolResult.summary }
            : undefined;

      return {
        kind: 'executed',
        resultText: wsResult.text,
        card: wsResult.card,
        errorType: wsResult.structuredError?.type,
        policyPost,
      };
    }

    // --- Sandbox path ---
    const sandboxCall = call.call as { tool: string; args?: Record<string, unknown> };
    const sbResult = await tracing.withActiveSpan(
      'tool.execute',
      {
        scope: 'push.coder',
        kind: tracing.spanKindInternal,
        attributes: {
          ...correlationToSpanAttributes(correlation ?? EMPTY_CORRELATION_CONTEXT),
          'push.agent.role': 'coder',
          'push.round': execCtx.round,
          'push.tool.name': sandboxCall.tool,
          'push.tool.source': 'sandbox',
          'push.provider': activeProvider,
          'push.model': activeModel,
        },
      },
      async (span) => {
        if (!capabilityLedger.isToolAllowed(sandboxCall.tool)) {
          const missing = capabilityLedger.getMissingCapabilities(sandboxCall.tool);
          return {
            text: `[Tool Blocked — ${sandboxCall.tool}] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
            structuredError: {
              type: 'APPROVAL_GATE_BLOCKED',
              retryable: false,
              message: `Capability violation: ${missing.join(', ')} not declared`,
            },
          } satisfies SandboxToolExecResult<TCard>;
        }
        const inner = await executeSandboxToolCall(
          (call as unknown as { call: TSandboxCall }).call,
          sandboxId,
          {
            auditorProviderOverride: activeProvider,
            auditorModelOverride: activeModel,
          },
        );
        capabilityLedger.recordToolUse(sandboxCall.tool);
        tracing.setSpanAttributes(span, {
          'push.tool.error_type': inner.structuredError?.type,
          'push.tool.retryable': inner.structuredError?.retryable,
        });
        if (inner.structuredError) {
          span.setStatus({
            code: tracing.spanStatusError,
            message: inner.structuredError.message,
          });
        } else {
          span.setStatus({ code: tracing.spanStatusOk });
        }
        return inner;
      },
    );

    // --- Sandbox health probe on SANDBOX_UNREACHABLE ---
    let sandboxProbePolicyPost:
      | { kind: 'inject'; content: string }
      | { kind: 'halt'; summary: string }
      | undefined;
    if (sbResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
      onStatus('Health check', 'Sandbox unreachable — validating...');
      try {
        const status = await sandboxStatus(sandboxId);
        const healthMsg = status.error
          ? `Sandbox health check failed: ${status.error}. Container may be expired or terminated.`
          : `Sandbox is reachable. HEAD=${status.head}, ${status.changedFiles.length} dirty file(s). Previous error may have been transient.`;
        sandboxProbePolicyPost = {
          kind: 'inject',
          content: `[SANDBOX_HEALTH_CHECK]\n${healthMsg}\nIf the container is unstable, stop mutation attempts and summarize your progress so far.\n[/SANDBOX_HEALTH_CHECK]`,
        };
      } catch {
        sandboxProbePolicyPost = {
          kind: 'halt',
          summary: `[Coder stopped — sandbox is unreachable. Container may have expired or terminated. Task is incomplete.]`,
        };
      }
    }

    // --- afterTool policy hook ---
    const afterToolResult = await policy.evaluateAfterTool(
      sandboxCall.tool,
      (sandboxCall.args ?? {}) as Record<string, unknown>,
      sbResult.text,
      Boolean(sbResult.structuredError),
      turnCtx,
    );
    const policyFromAfter =
      afterToolResult?.action === 'inject'
        ? { kind: 'inject' as const, content: afterToolResult.message.content }
        : afterToolResult?.action === 'halt'
          ? { kind: 'halt' as const, summary: afterToolResult.summary }
          : undefined;

    // Prefer the sandbox health probe over the afterTool policy — health
    // probe is the more urgent signal and the original inline code ran it
    // first.
    const policyPost = sandboxProbePolicyPost ?? policyFromAfter;

    return {
      kind: 'executed',
      resultText: sbResult.text,
      card: sbResult.card,
      errorType: sbResult.structuredError?.type,
      policyPost,
    };
  };
}
