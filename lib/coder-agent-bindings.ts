/**
 * Coder agent bindings — shared DI-wiring layer between Web and server
 * (Durable Object) runtimes.
 *
 * `app/src/lib/coder-agent.ts` historically built three interlocking
 * closures inline — the tool-exec closure, the Coder-specific detector
 * composition, and the after-model policy bridge — each deeply coupled
 * to the 10 `CoderAgentOptions` DI slots of `lib/coder-agent.ts`. The
 * background-jobs Phase 1 plan (see
 * `docs/archive/runbooks/Background Coder Tasks Phase 1.md`) needs the same
 * closures available in a Durable Object context, with Web-only
 * dependencies (localStorage approval mode, browser tracing, client
 * HTTP helpers) replaced by server equivalents.
 *
 * This module exposes the three closure builders against a small
 * structural services interface. Types are duck-typed deliberately to
 * avoid dragging Web-side definitions (`ChatMessage`, OTel `SpanKind`)
 * into `lib/`. The shared Coder policy and each shell's OTel/tool primitives
 * satisfy these interfaces structurally.
 *
 * No behavior change from the pre-extraction inline closures — this is
 * a mechanical lift of the same logic with the call boundary named.
 */

import type { ToolCard } from './tool-cards.js';
import {
  type CapabilityLedger,
  enforceRoleCapability,
  formatRoleCapabilityDenial,
  getEffectiveCapabilities,
  getToolCapabilities,
} from './capabilities.js';
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
import { isAnnouncedNoActionPolicyMessage } from './tool-call-recovery.js';

// ---------------------------------------------------------------------------
// Structural duck-types keep shell message and tracing types out of `lib/`.
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
  /** False for conversational lead turns; task-only policy guards stay quiet. */
  taskInFlight?: boolean;
  /** Leads challenge explicit completion claims; delegated Coders stay strict. */
  completionGuard?: 'strict' | 'claims_only';
  signal?: AbortSignal;
}

/** Surface-neutral after-tool / after-model directive. */
export type CoderPolicyInjectOrHalt =
  | { action: 'inject'; content: string }
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
 * (active-conversation branch updates); background-job tools emit `meta` for
 * logs and future observability features only — no chat or routing side
 * effects fire from a background result.
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
export interface SandboxToolExecResult<TCard extends ToolCard = ToolCard> {
  text: string;
  card?: TCard;
  structuredError?: {
    type: string;
    retryable: boolean;
    message: string;
    /** Marks a result as definitively (not transiently) unrecoverable on
     *  the same sandbox — e.g. the sandbox container has been destroyed
     *  and the auth gate returns `NOT_FOUND`. The kernel uses this to
     *  short-circuit the `SANDBOX_LOSS_THRESHOLD` counter and throw
     *  `SandboxUnreachableError` on the FIRST occurrence rather than
     *  waiting for the model to make a second consecutive tool call —
     *  some models (kimi-k2.6 on Workers AI) gracefully summarize after
     *  one error and never give the counter a second chance, which would
     *  otherwise silently bypass the DO's resume path. Optional and
     *  omitted by default so the threshold-of-2 behavior still applies
     *  to transient SDK blips. */
    fatal?: boolean;
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
  TCard extends ToolCard = ToolCard,
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
  /**
   * Execute a memory tool (`memory_grep` / `memory_expand`). Optional — when
   * omitted, memory calls are denied (older callers that don't thread a scope).
   * The CALLER bakes the read scope (repo / branch / chat) into this closure
   * from session context; the model's args never carry scope, so a Coder
   * can't reach another repo's memory (LCM security invariant). Mirrors the
   * `memory` case in `WebToolExecutionRuntime`.
   */
  executeMemory?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<SandboxToolExecResult<TCard>>;
  sandboxStatus: (sandboxId: string) => Promise<SandboxStatusResult>;

  /**
   * Tool sources this run may execute beyond the Coder's historical
   * sandbox/web-search/memory surface. Empty/absent for the delegated Coder.
   * The Inline Foreground Lane threads `{ 'github', 'ask-user', 'artifacts' }`
   * so the collapsed single lead matches the Orchestrator's tool surface. The
   * Coder role grant already carries the matching capabilities (`pr:*`,
   * `workflow:*`, `user:ask`, `artifacts:write`), so the kernel role check
   * passes; this set is what opens the source gate and the detector filters.
   */
  extraToolSources?: ReadonlySet<string>;
  /**
   * Execute an extra-source tool call (one of the sources named in
   * `extraToolSources`). Required when `extraToolSources` is non-empty. The
   * CALLER injects the surface executor (Web: `WebToolExecutionRuntime`) so
   * this binding stays surface-agnostic; the result uses the same
   * `SandboxToolExecResult` shape as the sandbox/web-search executors.
   */
  executeExtraToolCall?: (
    call: TCoderCall,
    ctx: { round: number; phase?: string },
  ) => Promise<SandboxToolExecResult<TCard>>;

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
  TCard extends ToolCard = ToolCard,
>(
  services: CoderBindingServices<TCoderCall, TSandboxCall, TWebSearchCall, TCard>,
): {
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCoderCall>;
  detectAnyToolCall: (text: string) => TCoderCall | null;
} {
  // Lead-surface sources (Inline Foreground Lane: github / ask-user /
  // artifacts) ride the same buckets the shared web detector already
  // classified them into — github reads land in `readOnly`, github mutations
  // / ask_user / create_artifact land in `mutating`. Empty set → identical to
  // the historical sandbox/web/memory-only Coder surface.
  const allowsExtra = (source: string): boolean => services.extraToolSources?.has(source) ?? false;

  const detectAllToolCalls = (text: string): DetectedToolCalls<TCoderCall> => {
    const raw = services.detectAllToolCalls(text);
    // Memory reads (`memory_grep`/`memory_expand`) are read-only and ride the
    // parallel-reads path alongside sandbox reads (LCM web-Coder support).
    const sandboxReads = raw.readOnly.filter(
      (c) => c.source === 'sandbox' || c.source === 'memory' || allowsExtra(c.source),
    );
    const sandboxFileMutations = raw.fileMutations.filter(
      (c) => c.source === 'sandbox' || allowsExtra(c.source),
    );
    const sandboxSideEffects = raw.sideEffects.filter(
      (c) => c.source === 'sandbox' || allowsExtra(c.source),
    );
    // Parallel-safe delegations (Inline Foreground Lane: concurrent Explorers)
    // ride the `delegate` extra source. Empty on surfaces that don't opt into
    // the bucket, so this is a no-op for the delegated Coder.
    const parallelDelegations = (raw.parallelDelegations ?? []).filter((c) =>
      allowsExtra(c.source),
    );
    // The web detector keeps file-mutation batch overflow in its own field
    // (unlike the CLI, which folds it into `extraMutations`); pass it through
    // with the same source filter as `fileMutations` so the kernel ledger can
    // record the skipped writes as rejected instead of reporting a clean batch.
    const rawBatchOverflow = (raw as { batchOverflow?: TCoderCall[] }).batchOverflow ?? [];
    const sandboxBatchOverflow = rawBatchOverflow.filter(
      (c) => c.source === 'sandbox' || allowsExtra(c.source),
    );
    return {
      readOnly: sandboxReads,
      parallelDelegations,
      fileMutations: sandboxFileMutations,
      sideEffects: sandboxSideEffects,
      ...(sandboxBatchOverflow.length > 0 ? { batchOverflow: sandboxBatchOverflow } : {}),
      extraMutations: raw.extraMutations,
      // Filter Coder-internal tools out of droppedCandidates so the
      // parse-error guard in lib/coder-agent.ts doesn't false-positive
      // on them. `coder_update_state` and `coder_checkpoint` are
      // recognized tool names handled outside the source-detector
      // pipeline (detectUpdateStateCall / detectCheckpointCall in the
      // Coder loop), so the dispatcher's `extractBareToolJsonObjects`
      // sees them as `tool: "<name>"` but the source detectors return
      // null and they land in droppedCandidates with
      // resolvedToolName=null. Without this filter, a model that emits
      // a state-update alongside its real edit gets the whole batch
      // bailed and wastes a round. PR #605.
      droppedCandidates: raw.droppedCandidates.filter(
        (c) => !isCoderInternalToolName(c.rawToolName),
      ),
    };
  };

  const detectAnyToolCall = (text: string): TCoderCall | null => {
    const sandboxCall = services.detectSandboxToolCall(text);
    if (sandboxCall) return services.tagSandboxCall(sandboxCall);

    const webSearchCall = services.detectWebSearchToolCall(text);
    if (webSearchCall) return services.tagWebSearchCall(webSearchCall);

    const recovered = services.detectAnyToolCall(text);
    if (
      recovered?.source === 'sandbox' ||
      recovered?.source === 'web-search' ||
      recovered?.source === 'memory' ||
      (recovered != null && allowsExtra(recovered.source))
    ) {
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
  TCard extends ToolCard = ToolCard,
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
    return {
      action: 'inject',
      content: result.content,
      forceToolChoiceNextRound: isAnnouncedNoActionPolicyMessage(result.content),
    };
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
  TCard extends ToolCard = ToolCard,
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
    executeMemory,
    executeExtraToolCall,
    extraToolSources,
    sandboxStatus,
  } = services;

  return async (
    call: TCoderCall,
    execCtx: { round: number; phase?: string },
  ): Promise<CoderToolExecResult<TCard>> => {
    turnCtx.round = execCtx.round;
    turnCtx.phase = execCtx.phase;

    const isExtraSource = extraToolSources?.has(call.source) ?? false;
    if (
      call.source !== 'sandbox' &&
      call.source !== 'web-search' &&
      call.source !== 'memory' &&
      !isExtraSource
    ) {
      return {
        kind: 'denied',
        reason: `Coder can only execute sandbox, web_search, and memory tools. "${call.call.tool}" is not available to Coder.`,
      };
    }
    if (call.source === 'memory' && !executeMemory) {
      // No scope was threaded by this caller — deny rather than run an
      // unscoped memory read. Symmetric with the web runtime's NO_ACTIVE_REPO
      // guard; surfaced as a denial the model can see.
      return {
        kind: 'denied',
        reason: `Memory tools are not available in this run (no memory scope). "${call.call.tool}" cannot be executed.`,
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
      // Symmetric structured log so a delegated-Coder denial is greppable in
      // ops. Without it, a misconfigured Coder grant would bounce every
      // delegated call back to the model as `reason` — visible to the model,
      // invisible to operators — which is exactly the silent token-burn failure
      // the OpenCode audit called out at the subagent layer. The event name and
      // payload shape match the CLI Explorer gate (`cli/pushd.ts`) so one
      // grep/dashboard covers both; the *stream* follows the Symmetric
      // structured logs convention for shared `lib/` — `console.error` with a
      // semantic `level` field, decoupled (cf. `lib/context-memory.ts` /
      // `lib/verbatim-retain.ts`), keeping it off the CLI's --json stdout.
      try {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'role_capability_denied',
            type: roleCheck.type,
            role: 'coder',
            tool: call.call.tool,
            required: getToolCapabilities(call.call.tool),
            granted: Array.from(getEffectiveCapabilities('coder')),
          }),
        );
      } catch {
        // JSON.stringify cycle guard — never let logging crash the executor.
      }
      // Use the shared formatter so the denial body matches byte-for-byte
      // what the web runtime and CLI kernel emit. The Coder result shape
      // surfaces this as `reason` rather than a structured tool result,
      // but the model still sees the same denial envelope across surfaces.
      return {
        kind: 'denied',
        reason: formatRoleCapabilityDenial(call.call.tool, roleCheck),
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

    // --- Extra lead-surface path (github / ask-user / artifacts) ---
    // The Inline Foreground Lane routes these through the injected
    // `executeExtraToolCall` (Web: `WebToolExecutionRuntime`), wrapped in the
    // same tracing + capability-ledger + after-tool-policy pipeline as the
    // sandbox/web-search paths. The role-capability gate above already
    // confirmed the Coder grant covers the tool; the ledger check here guards
    // the per-run declared budget.
    if (isExtraSource) {
      const extraTool = call.call.tool;
      const extraArgs = (call.call.args ?? {}) as Record<string, unknown>;
      if (!executeExtraToolCall) {
        return {
          kind: 'denied',
          reason: `Tool "${extraTool}" requires an extra-source executor that was not wired for this run.`,
        };
      }
      const exResult = await tracing.withActiveSpan(
        'tool.execute',
        {
          scope: 'push.coder',
          kind: tracing.spanKindInternal,
          attributes: {
            ...correlationToSpanAttributes(correlation ?? EMPTY_CORRELATION_CONTEXT),
            'push.agent.role': 'coder',
            'push.round': execCtx.round,
            'push.tool.name': extraTool,
            'push.tool.source': call.source,
            'push.provider': activeProvider,
            'push.model': activeModel,
          },
        },
        async (span) => {
          if (!capabilityLedger.isToolAllowed(extraTool)) {
            const missing = capabilityLedger.getMissingCapabilities(extraTool);
            return {
              text: `[Tool Blocked — ${extraTool}] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
              structuredError: {
                type: 'APPROVAL_GATE_BLOCKED',
                retryable: false,
                message: `Capability violation: ${missing.join(', ')} not declared`,
              },
            } satisfies SandboxToolExecResult<TCard>;
          }
          const inner = await executeExtraToolCall(call, execCtx);
          capabilityLedger.recordToolUse(extraTool);
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
        extraTool,
        extraArgs,
        exResult.text,
        Boolean(exResult.structuredError),
        turnCtx,
      );
      const policyPost =
        afterToolResult?.action === 'inject'
          ? { kind: 'inject' as const, content: afterToolResult.content }
          : afterToolResult?.action === 'halt'
            ? { kind: 'halt' as const, summary: afterToolResult.summary }
            : undefined;

      return {
        kind: 'executed',
        resultText: exResult.text,
        card: exResult.card,
        errorType: exResult.structuredError?.type,
        policyPost,
      };
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
          ? { kind: 'inject' as const, content: afterToolResult.content }
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

    // --- Memory path (memory_grep / memory_expand) ---
    if (call.source === 'memory') {
      const memTool = call.call.tool;
      const memArgs = (call.call.args ?? {}) as Record<string, unknown>;
      const memResult = await tracing.withActiveSpan(
        'tool.execute',
        {
          scope: 'push.coder',
          kind: tracing.spanKindInternal,
          attributes: {
            ...correlationToSpanAttributes(correlation ?? EMPTY_CORRELATION_CONTEXT),
            'push.agent.role': 'coder',
            'push.round': execCtx.round,
            'push.tool.name': memTool,
            'push.tool.source': 'memory',
            'push.provider': activeProvider,
            'push.model': activeModel,
          },
        },
        async (span) => {
          if (!capabilityLedger.isToolAllowed(memTool)) {
            const missing = capabilityLedger.getMissingCapabilities(memTool);
            return {
              text: `[Tool Blocked — ${memTool}] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
              structuredError: {
                type: 'APPROVAL_GATE_BLOCKED',
                retryable: false,
                message: `Capability violation: ${missing.join(', ')} not declared`,
              },
            } satisfies SandboxToolExecResult<TCard>;
          }
          // executeMemory is guaranteed defined here: the source gate above
          // denies memory calls when no scope was threaded.
          const inner = await executeMemory!(memTool, memArgs);
          capabilityLedger.recordToolUse(memTool);
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
        memTool,
        memArgs,
        memResult.text,
        Boolean(memResult.structuredError),
        turnCtx,
      );
      const policyPost =
        afterToolResult?.action === 'inject'
          ? { kind: 'inject' as const, content: afterToolResult.content }
          : afterToolResult?.action === 'halt'
            ? { kind: 'halt' as const, summary: afterToolResult.summary }
            : undefined;

      return {
        kind: 'executed',
        resultText: memResult.text,
        card: memResult.card,
        errorType: memResult.structuredError?.type,
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
        ? { kind: 'inject' as const, content: afterToolResult.content }
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
      // Propagate the fatal flag so the kernel's sandbox-loss tracker can
      // throw `SandboxUnreachableError` on the FIRST occurrence — see the
      // `fatal` field on `SandboxToolExecResult.structuredError` and the
      // corresponding `CoderToolExecResult` field for the rationale.
      fatal: sbResult.structuredError?.fatal,
      policyPost,
    };
  };
}

/**
 * The set of "Coder-internal" tool names handled by the Coder loop's
 * own pre-parse detectors (`detectUpdateStateCall`,
 * `detectCheckpointCall`) rather than by the source-detector pipeline.
 * The dispatcher's `extractBareToolJsonObjects` still finds these in
 * the model output and the source detectors correctly return null —
 * but if we leave them in `droppedCandidates`, the Coder's parse-
 * error guard bails on the whole batch. They are valid tool calls,
 * just not routed through the dispatcher, so we filter them here at
 * the bindings layer. The orchestrator's universe stays strict
 * because nothing in this layer affects the orchestrator's
 * `detectAllToolCalls` call site. Exported so tests can pin the
 * exact list. See PR #605.
 */
export const CODER_INTERNAL_TOOL_NAMES = new Set<string>([
  'coder_update_state',
  'coder_checkpoint',
]);

export function isCoderInternalToolName(name: string): boolean {
  return CODER_INTERNAL_TOOL_NAMES.has(name);
}
