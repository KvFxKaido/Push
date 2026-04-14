/**
 * CorrelationContext — the canonical shape for passive cross-surface
 * correlation tags (run ids, chat ids, tool-call ids, surface labels).
 *
 * See `docs/decisions/CorrelationContext Contract.md` for the full
 * contract, field semantics, and the hard rule that this module exists
 * to codify. The short version lives here as JSDoc so that reaching for
 * intellisense surfaces it at the call site.
 *
 * ## The hard rule
 *
 * A `CorrelationContext` is **passive observability metadata only**.
 *
 * The fields on this object MUST NOT be used to:
 *
 *   1. alter tool call arguments or results,
 *   2. alter prompt text or system prompt composition,
 *   3. alter pushd wire payloads beyond the existing envelope fields
 *      (`sessionId`, optional `runId`) that the protocol already defines,
 *   4. alter sandbox commands, filesystem state, or workspace behavior,
 *   5. gate branches in business logic (policy, permission, approval).
 *
 * A correlation context is something you read, log, attach to an OTel
 * span, and pass forward. It is never something you branch on. If a
 * feature needs to branch on an id, that id belongs somewhere other
 * than here — usually on the domain object itself (a `RunEvent`, a
 * `MemoryScope`, a `SessionEvent` envelope).
 *
 * ## What this module is and is not
 *
 * This module is:
 *
 *   - a single `interface` that names the eight canonical correlation
 *     fields once, with one set of semantics everyone agrees on;
 *   - a small set of pure helpers (`extendCorrelation`,
 *     `correlationToSpanAttributes`) so that callers do not reinvent
 *     the merge and attribute-shaping dance in twelve different places;
 *   - a single source of truth for the span-attribute key names used by
 *     the tracing spine (step 3 of the Architecture Remediation Plan).
 *
 * This module is **not**:
 *
 *   - a tracing span wrapper — that lives in `app/src/lib/tracing.ts`
 *     (`withActiveSpan`, `setSpanAttributes`);
 *   - a runtime context injector — step 1 of the remediation plan is
 *     docs-and-types, so nothing in the kernel or the shells imports
 *     this file yet;
 *   - a replacement for `MemoryScope` or `SessionEvent.runId` — those
 *     remain the authoritative, domain-specific identifier carriers
 *     for memory retrieval and wire envelopes. `CorrelationContext` is
 *     the shape we reach for when we want to carry those ids **across**
 *     subsystems without pulling in either dependency.
 */

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * Which process / runtime boundary a correlation context was captured in.
 *
 * - `web`     — the browser-side React app (`app/src/**`).
 * - `cli`     — the terminal client (`cli/cli.ts`, `cli/tui.ts`).
 * - `daemon`  — the pushd long-running daemon (`cli/pushd.ts`).
 * - `sandbox` — code executing inside the remote sandbox worker (Modal /
 *               the Cloudflare Worker sandbox bridge).
 *
 * These are the four process boundaries that tool calls, delegations,
 * and verification runs cross today. Adding a new value here means a
 * new long-lived process joined the system — update the contract doc
 * alongside it.
 */
export type CorrelationSurface = 'web' | 'cli' | 'daemon' | 'sandbox';

// ---------------------------------------------------------------------------
// CorrelationContext
// ---------------------------------------------------------------------------

/**
 * The canonical shape for passive correlation metadata.
 *
 * All fields are optional because a context can be captured at many
 * levels of nesting: a span at the tool-call layer has a `toolCallId`
 * and probably an `executionId`, but may not know the enclosing
 * `taskGraphId`; a span at the run-engine layer has a `runId` and a
 * `chatId`, but no `toolCallId`.
 *
 * Fields should follow one implicit containment order, loosest to
 * tightest:
 *
 *     surface
 *       └── sessionId          (pushd daemon session, CLI-only)
 *             └── chatId       (user-visible conversation)
 *                   └── runId  (one assistant turn sequence)
 *                         ├── taskGraphId
 *                         │     └── taskId
 *                         ├── executionId     (delegation, tool, task-graph exec)
 *                         │     └── toolCallId (leaf tool invocation)
 *
 * Callers that hold a tighter id should also hold its parents whenever
 * possible. The `extendCorrelation` helper exists to make that cheap:
 * each layer adds what it knows without rewriting what the parent knew.
 */
export interface CorrelationContext {
  /** Where this context was captured. See {@link CorrelationSurface}. */
  surface?: CorrelationSurface;

  /**
   * The pushd daemon session id.
   *
   * Present on CLI attach flows; absent on web today (web does not go
   * through pushd). This is **not** the chat id — a single pushd
   * session can host many chats, and a single chat is not bound to any
   * pushd session from the web's perspective. Matches the `sessionId`
   * field on `SessionEvent` envelopes in `cli/session-store.ts`.
   */
  sessionId?: string;

  /**
   * The user-visible conversation / chat id.
   *
   * Same semantics as `MemoryScope.chatId` and the `chatId` field on
   * the `RUN_STARTED` event in `run-engine-contract.ts`.
   */
  chatId?: string;

  /**
   * The run id for one assistant turn sequence.
   *
   * Same semantics as `RUN_STARTED.runId` in `run-engine-contract.ts`
   * and the optional `runId` on the pushd envelope. A chat may have
   * many runs over its lifetime; a run belongs to at most one chat.
   */
  runId?: string;

  /**
   * The task graph id when the caller is executing inside a task graph.
   *
   * Same semantics as `MemoryScope.taskGraphId`. Nested `taskId` is
   * meaningful only in combination with this value.
   */
  taskGraphId?: string;

  /**
   * The task node id within a task graph.
   *
   * Same semantics as `MemoryScope.taskId`. Only meaningful when
   * `taskGraphId` is also set.
   */
  taskId?: string;

  /**
   * The execution id shared by delegation, task-graph, and tool
   * execution events.
   *
   * This is the field the Architecture Remediation Plan originally
   * called `delegationId`. The codebase has been using `executionId`
   * since the `RunEvent` union landed (see `subagent.started`,
   * `subagent.completed`, `task_graph.*`, `tool.execution_*` arms in
   * `lib/runtime-contract.ts`). We reconcile on the existing name so
   * that span attributes, logs, and tests all line up without a
   * synonym to translate.
   */
  executionId?: string;

  /**
   * The id of a single tool invocation.
   *
   * Same semantics as `ToolExecutionStartEvent.toolCallId` in
   * `lib/tool-execution-runtime.ts`. Distinct from `executionId`:
   *
   *   - `executionId` is the id of the **runtime granule** that owns
   *     the work (a delegation, a task-graph node, a tool execution
   *     round);
   *   - `toolCallId` is the id of the **specific tool call** the model
   *     emitted, which is what the provider hands back in tool-result
   *     envelopes.
   *
   * One execution may dispatch many tool calls, so `toolCallId` is
   * always "at or below" `executionId` in the containment order.
   */
  toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Span attribute keys
// ---------------------------------------------------------------------------

/**
 * The canonical OTel span-attribute keys for each correlation field.
 *
 * The `push.*` namespace and `snake_case` suffix match the convention
 * already in use across `app/src/hooks/useAgentDelegation.ts`
 * (`push.execution_id`, `push.agent.role`, etc.) and
 * `app/src/lib/tracing.ts` (`push.cancelled`). Keep this table in
 * sync with any new field added to `CorrelationContext`.
 *
 * Exposed as a readonly const so tests can assert on the exact keys
 * without duplicating the strings.
 */
export const CORRELATION_SPAN_ATTRIBUTE_KEYS = {
  surface: 'push.surface',
  sessionId: 'push.session_id',
  chatId: 'push.chat_id',
  runId: 'push.run_id',
  taskGraphId: 'push.task_graph_id',
  taskId: 'push.task_id',
  executionId: 'push.execution_id',
  toolCallId: 'push.tool_call_id',
} as const satisfies Record<keyof CorrelationContext, string>;

/** The full set of correlation field names, in containment order. */
export const CORRELATION_FIELD_NAMES = [
  'surface',
  'sessionId',
  'chatId',
  'runId',
  'taskGraphId',
  'taskId',
  'executionId',
  'toolCallId',
] as const satisfies ReadonlyArray<keyof CorrelationContext>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A correlation context with every field unset. Safe to share. */
export const EMPTY_CORRELATION_CONTEXT: Readonly<CorrelationContext> = Object.freeze({});

/**
 * Return a new context that combines `base` with the fields set on
 * `patch`. Undefined fields in `patch` do **not** overwrite their
 * counterparts in `base` — that is, the patch is a set of additions,
 * not a full replacement.
 *
 * Pure: never mutates `base` or `patch`. Safe to call inside React
 * render paths.
 *
 * @example
 *   const ctx = extendCorrelation(
 *     { surface: 'web', chatId: 'c1' },
 *     { runId: 'r42' },
 *   );
 *   // ctx === { surface: 'web', chatId: 'c1', runId: 'r42' }
 */
export function extendCorrelation(
  base: CorrelationContext,
  patch: CorrelationContext,
): CorrelationContext {
  const next: CorrelationContext = { ...base };
  for (const key of CORRELATION_FIELD_NAMES) {
    const value = patch[key];
    if (value !== undefined) {
      // `as any` is localized: we've just indexed by a literal union
      // of keys of CorrelationContext, so the assignment is sound.
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/**
 * Convert a correlation context into an OTel span-attribute record.
 *
 * Only fields with a defined value are emitted, so the returned object
 * can be passed directly into `span.setAttributes(...)` without
 * worrying about clobbering upstream attributes with `undefined`.
 *
 * The attribute keys come from `CORRELATION_SPAN_ATTRIBUTE_KEYS`; do
 * not rebuild this mapping in call sites.
 */
export function correlationToSpanAttributes(ctx: CorrelationContext): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of CORRELATION_FIELD_NAMES) {
    const value = ctx[key];
    if (typeof value === 'string' && value.length > 0) {
      attrs[CORRELATION_SPAN_ATTRIBUTE_KEYS[key]] = value;
    }
  }
  return attrs;
}

/** True when `ctx` has at least one correlation field set. */
export function hasAnyCorrelation(ctx: CorrelationContext): boolean {
  for (const key of CORRELATION_FIELD_NAMES) {
    if (ctx[key] !== undefined) return true;
  }
  return false;
}

/**
 * True when `ctx` has a `runId` (the minimal shape for "this log line
 * belongs to a specific run").
 */
export function hasRunCorrelation(
  ctx: CorrelationContext,
): ctx is CorrelationContext & { runId: string } {
  return typeof ctx.runId === 'string' && ctx.runId.length > 0;
}
