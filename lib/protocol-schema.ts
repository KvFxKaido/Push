/**
 * protocol-schema.ts — Runtime validators for pushd wire envelopes.
 *
 * Problem this solves: pushd's NDJSON envelope format is defined by
 * convention (see `cli/pushd.ts:broadcastEvent` + `cli/session-store.ts`),
 * but there was no runtime check that the shape of an emitted envelope
 * matched the shape an attached client expects. Three regressions in
 * recent PRs (`runId: null` instead of omitted; out-of-order `seq` on
 * parallel task-graph progress; stale `lastSeenSeq` after token regen)
 * escaped CI because the tests asserted coarse behaviour, not envelope
 * shape.
 *
 * Design:
 *
 *   - `validateEventEnvelope(event)` checks the envelope layer (v,
 *     kind, sessionId, runId?, seq, ts, type, payload) against the
 *     contract defined in `cli/session-store.ts:SessionEvent`. This is
 *     the shape every `broadcastEvent` / `appendSessionEvent` call
 *     should produce, regardless of event type.
 *
 *   - `validateRunEventPayload(type, payload)` layers per-type checks
 *     on top of the envelope. Covers the nine delegation event types
 *     that come from the shared `RunEvent` union in
 *     `lib/runtime-contract.ts` (subagent.* × 3, task_graph.* × 6) —
 *     these are the ones that have their own shape contract and the
 *     ones where we've had recent regressions.
 *
 *   - `validateEvent(event)` is the top-level entry that runs both and
 *     returns a combined list of `ValidationIssue` entries.
 *
 *   - `assertValidEvent(event)` throws a well-formatted error if
 *     validation fails. Used in strict-mode `broadcastEvent` wiring.
 *
 *   - `isStrictModeEnabled()` reads the `PUSH_PROTOCOL_STRICT` env var
 *     at call time (not at import time) so tests can flip the flag
 *     per-process without restarting the module graph.
 *
 * Non-goals for this module:
 *
 *   - Request/response envelope validation. Handlers already do their
 *     own ad-hoc input validation (`if (!sessionId) INVALID_REQUEST`)
 *     and restructuring them into a schema-driven pipeline is a
 *     larger refactor.
 *
 *   - Payload validation for events that carry no required payload the
 *     surfaces read — e.g. `assistant_done` / `assistant_thinking_done`.
 *     These stay envelope-only on purpose; there is nothing to schema-
 *     validate beyond the envelope. Everything with a meaningful payload
 *     contract — daemon-owned lifecycle / session-mutation / recovery
 *     events AND the `RunEventInput` passthrough the run loop forwards
 *     (`assistant.turn_*`, `job.*`, `user.follow_up_*`) — now has a
 *     per-type schema; see `PAYLOAD_VALIDATORS`.
 *
 *   - External schema libraries for *wire-envelope* validation. The
 *     hand-rolled validators here stay dependency-free and are simple
 *     enough for the envelope scope. (Note: `lib/structured-output.ts`
 *     does adopt `zod` for validating *model JSON output* — the auditor
 *     and reviewer payloads — where hand-rolled coercion had drifted
 *     across sites. That carve-out is deliberate and scoped to model
 *     output; envelope validation deliberately stays hand-rolled.)
 *
 * The validators are intentionally permissive about *extra* fields on
 * both the envelope and the payload — adding a new optional field
 * should not break a schema check. We only fail on missing required
 * fields or fields with the wrong type.
 */

/**
 * The wire-protocol version tag pinned on every envelope. Bump this
 * when introducing a breaking change to the envelope shape or the
 * dispatch contract — clients negotiate compatibility against it in
 * the `hello` handshake.
 *
 * Lives here (next to the validators) so the shared-runtime layer
 * owns the protocol-version constant alongside the envelope schema.
 * Re-exported by `cli/session-store.ts` for back-compat with existing
 * CLI importers that previously got it from there.
 */
export const PROTOCOL_VERSION = 'push.runtime.v1';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** Dotted path into the envelope where the issue was found. */
  path: string;
  /** Human-readable description of what went wrong. */
  message: string;
}

// ---------------------------------------------------------------------------
// Strict mode flag
// ---------------------------------------------------------------------------

/**
 * True when `PUSH_PROTOCOL_STRICT=1` is set. Tests enable this globally
 * at module load so every `broadcastEvent` call runs through the
 * validator; production leaves it unset for zero runtime cost.
 *
 * Reads `process.env` at call time (not at module import) so a test
 * setup step can flip the flag after importing this module. The
 * `process` reference goes through `globalThis` so the browser-side
 * tsconfig (`types: ["vite/client"]`, no Node types) can compile this
 * module — a bare `process.env` would fail typecheck and crash at
 * runtime in the browser where no such global exists.
 */
export function isStrictModeEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (!env) return false;
  const raw = env.PUSH_PROTOCOL_STRICT;
  return raw === '1' || raw === 'true';
}

/**
 * True unless `PUSH_PROTOCOL_OBSERVE=0` (or `false`) is set — i.e. ON by
 * default in any Node context. Observe mode is the production counterpart to
 * strict mode: the daemon's broadcast path validates every outbound envelope
 * and emits a structured `protocol_drift_detected` log on failure, but does
 * NOT throw — so a drifted envelope is surfaced to ops instead of being
 * dropped for every attached client (fail-open, matching the secret-scan's
 * "infra trouble fails open with structured logs" posture).
 *
 * Strict mode takes precedence: when `PUSH_PROTOCOL_STRICT` is on, the
 * broadcast path throws and observe never runs, so CI still fails loud while
 * prod stays fail-open. The envelope checks are ~8 comparisons plus a dict
 * miss for non-delegation types, negligible against the per-event JSON
 * serialize + WS send, so validating on the hot path costs effectively
 * nothing — but `PUSH_PROTOCOL_OBSERVE=0` is the escape hatch if profiling
 * ever says otherwise.
 *
 * Returns false where there is no `process` (browser): only the daemon
 * broadcast path consults this, so it stays inert on the web surface. Reads
 * `process.env` at call time via `globalThis` for the same browser-compat
 * reason as {@link isStrictModeEnabled}.
 */
export function isProtocolObserveEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (!env) return false;
  const raw = env.PUSH_PROTOCOL_OBSERVE;
  return raw !== '0' && raw !== 'false';
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate that `event` matches the `SessionEvent` contract from
 * `cli/session-store.ts`:
 *
 *     interface SessionEvent {
 *       v: string;
 *       kind: 'event';
 *       sessionId: string;
 *       runId?: string;   // present-or-absent, never null
 *       seq: number;      // non-negative integer
 *       ts: number;       // milliseconds since epoch
 *       type: string;
 *       payload: unknown;
 *     }
 *
 * Returns an array of issues (empty on success). Callers that want a
 * boolean result can check `issues.length === 0`.
 */
export function validateEventEnvelope(event: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(event)) {
    issues.push({ path: '', message: `expected plain object, got ${typeof event}` });
    return issues;
  }

  if (event.v !== PROTOCOL_VERSION) {
    issues.push({
      path: 'v',
      message: `expected "${PROTOCOL_VERSION}", got ${JSON.stringify(event.v)}`,
    });
  }

  if (event.kind !== 'event') {
    issues.push({
      path: 'kind',
      message: `expected "event", got ${JSON.stringify(event.kind)}`,
    });
  }

  if (!isNonEmptyString(event.sessionId)) {
    issues.push({
      path: 'sessionId',
      message: `expected non-empty string, got ${JSON.stringify(event.sessionId)}`,
    });
  }

  // `runId` is optional but if present must be a non-empty string.
  // Serialising `runId: null` is an active regression (PR #276 review) —
  // the field should be omitted entirely when there is no run id.
  if ('runId' in event) {
    if (event.runId !== undefined && !isNonEmptyString(event.runId)) {
      issues.push({
        path: 'runId',
        message: `expected non-empty string or omitted, got ${JSON.stringify(event.runId)}`,
      });
    }
  }

  if (!isFiniteNonNegativeInt(event.seq)) {
    issues.push({
      path: 'seq',
      message: `expected non-negative integer, got ${JSON.stringify(event.seq)}`,
    });
  }

  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts) || event.ts <= 0) {
    issues.push({
      path: 'ts',
      message: `expected positive finite number (ms since epoch), got ${JSON.stringify(event.ts)}`,
    });
  }

  if (!isNonEmptyString(event.type)) {
    issues.push({
      path: 'type',
      message: `expected non-empty string, got ${JSON.stringify(event.type)}`,
    });
  }

  // Require the `payload` key AND a non-undefined value. A bare
  // `payload: undefined` passes `'payload' in event` but gets dropped
  // by `JSON.stringify` on the wire, so the downstream receiver sees
  // an envelope missing the field — a silent contract violation that
  // strict mode should catch at emission time.
  if (!('payload' in event) || event.payload === undefined) {
    issues.push({
      path: 'payload',
      message: 'missing required field (must be present and not undefined)',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Per-type payload validation (delegation events)
// ---------------------------------------------------------------------------

type PayloadValidator = (payload: unknown, basePath: string) => ValidationIssue[];

// NOTE: Gemini suggested extracting the repeated `if (!isPlainObject(...)) { ... return; }`
// block into a single `expectPlainObject` helper. Tried that — TypeScript loses the
// `unknown → Record<string, unknown>` narrowing through a helper's return type
// without a type-predicate signature, which forced a `payload as Record<...>` cast
// in every caller. One extra cast per validator eats most of the boilerplate win,
// so the inline pattern stays. If the set of payload validators grows significantly,
// revisit with an explicit type predicate.

function expectNonEmptyString(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  if (!isNonEmptyString(obj[field])) {
    return {
      path: `${basePath}.${field}`,
      message: `expected non-empty string, got ${JSON.stringify(obj[field])}`,
    };
  }
  return null;
}

function expectOptionalString(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  if (field in obj && obj[field] !== undefined && typeof obj[field] !== 'string') {
    return {
      path: `${basePath}.${field}`,
      message: `expected string or omitted, got ${JSON.stringify(obj[field])}`,
    };
  }
  return null;
}

function expectOptionalFiniteNumber(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  if (field in obj && obj[field] !== undefined) {
    if (typeof obj[field] !== 'number' || !Number.isFinite(obj[field] as number)) {
      return {
        path: `${basePath}.${field}`,
        message: `expected finite number or omitted, got ${JSON.stringify(obj[field])}`,
      };
    }
  }
  return null;
}

function expectOptionalNonNegativeInteger(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  if (field in obj && obj[field] !== undefined) {
    const value = obj[field];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      return {
        path: `${basePath}.${field}`,
        message: `expected non-negative integer or omitted, got ${JSON.stringify(value)}`,
      };
    }
  }
  return null;
}

function expectNonNegativeInteger(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  if (!isFiniteNonNegativeInt(obj[field])) {
    return {
      path: `${basePath}.${field}`,
      message: `expected non-negative integer, got ${JSON.stringify(obj[field])}`,
    };
  }
  return null;
}

function expectNonEmptyStringArray(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0) {
    return [
      {
        path: `${basePath}.${field}`,
        message: `expected non-empty string array, got ${JSON.stringify(value)}`,
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  value.forEach((element, index) => {
    if (!isNonEmptyString(element)) {
      issues.push({
        path: `${basePath}.${field}[${index}]`,
        message: `expected non-empty string, got ${JSON.stringify(element)}`,
      });
    }
  });
  return issues;
}

// Required finite number, but NOT constrained to non-negative — duration-style
// fields (e.g. `markerAge = Date.now() - startedAt`) can legitimately go
// negative under clock skew, and rejecting that would be a false-positive in
// observe mode.
function expectFiniteNumber(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
): ValidationIssue | null {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      path: `${basePath}.${field}`,
      message: `expected finite number, got ${JSON.stringify(value)}`,
    };
  }
  return null;
}

// Validate that `obj[field]` is an array of plain objects, each carrying the
// given required non-empty-string keys. Element index is included in the path
// so a drift log points at the exact bad entry.
function expectObjectArray(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
  requiredStringKeys: readonly string[],
): ValidationIssue[] {
  const value = obj[field];
  if (!Array.isArray(value)) {
    return [
      { path: `${basePath}.${field}`, message: `expected array, got ${JSON.stringify(value)}` },
    ];
  }
  const issues: ValidationIssue[] = [];
  value.forEach((element, index) => {
    const elementPath = `${basePath}.${field}[${index}]`;
    if (!isPlainObject(element)) {
      issues.push({ path: elementPath, message: `expected plain object, got ${typeof element}` });
      return;
    }
    for (const key of requiredStringKeys) {
      const issue = expectNonEmptyString(element, key, elementPath);
      if (issue) issues.push(issue);
    }
  });
  return issues;
}

function expectAgentValue(
  obj: Record<string, unknown>,
  field: string,
  basePath: string,
  allowed: readonly string[],
): ValidationIssue | null {
  const value = obj[field];
  if (!isNonEmptyString(value) || !allowed.includes(value)) {
    return {
      path: `${basePath}.${field}`,
      message: `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`,
    };
  }
  return null;
}

/**
 * Allowed values for the `agent` field on `subagent.*` event payloads.
 * Mirrors `RunEventSubagent` in `lib/runtime-contract.ts` — kept in
 * sync by a regex-extracting guard-rail test in
 * `cli/tests/protocol-schema.test.mjs` so drift between this list and
 * the source-of-truth type declaration lands as a test failure.
 */
export const SUBAGENT_AGENTS = [
  'planner',
  'coder',
  'explorer',
  'reviewer',
  'deep_reviewer',
  'auditor',
  'task_graph',
] as const;

/**
 * Allowed values for the `agent` field on `task_graph.*` event payloads.
 * Mirrors the `agent` field of `TaskGraphNode` in
 * `lib/runtime-contract.ts` — same guard-rail pattern as
 * `SUBAGENT_AGENTS` above.
 */
export const TASK_GRAPH_AGENTS = ['explorer', 'coder'] as const;

export const TURN_ROUTES = ['orchestrator', 'inline-delegation', 'background-mode'] as const;
export const TURN_SUPPRESSED_ROUTES = ['inline-delegation', 'background-mode'] as const;
// `conversational_downgrade` and `conversational_escape_hatch` are LEGACY —
// emitted by pre-Phase-3 / pre-escape-hatch-removal clients and persisted in
// `Conversation.runState.runEvents` (route events pass `shouldPersistRunEvent`).
// Current code emits only `conversational_inline`, but the validator must keep
// ACCEPTING the old values or stored/replayed envelopes from older clients fail
// strict validation after upgrade. Do not remove them; this is a versioned wire
// schema.
export const TURN_ROUTE_REASONS = [
  'conversational_inline',
  'conversational_escape_hatch',
  'conversational_downgrade',
] as const;
export const TURN_INTENTS = ['conversational', 'task'] as const;

function validateTurnRoute(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const route = expectAgentValue(payload, 'route', basePath, TURN_ROUTES);
  if (route) issues.push(route);
  const reason = expectAgentValue(payload, 'reason', basePath, TURN_ROUTE_REASONS);
  if (reason) issues.push(reason);
  if (payload.suppressedRoute !== undefined) {
    const suppressed = expectAgentValue(
      payload,
      'suppressedRoute',
      basePath,
      TURN_SUPPRESSED_ROUTES,
    );
    if (suppressed) issues.push(suppressed);
  }
  const intent = expectAgentValue(payload, 'intent', basePath, TURN_INTENTS);
  if (intent) issues.push(intent);
  if (typeof payload.repoBranchReady !== 'boolean') {
    issues.push({
      path: `${basePath}.repoBranchReady`,
      message: `expected boolean, got ${JSON.stringify(payload.repoBranchReady)}`,
    });
  }
  return issues;
}

function validateSubagentStarted(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const a = expectAgentValue(payload, 'agent', basePath, SUBAGENT_AGENTS);
  if (a) issues.push(a);
  const d = expectOptionalString(payload, 'detail', basePath);
  if (d) issues.push(d);
  return issues;
}

function validateSubagentCompleted(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const a = expectAgentValue(payload, 'agent', basePath, SUBAGENT_AGENTS);
  if (a) issues.push(a);
  const s = expectNonEmptyString(payload, 'summary', basePath);
  if (s) issues.push(s);
  const ob = expectOptionalNonNegativeInteger(payload, 'orchestratorBytes', basePath);
  if (ob) issues.push(ob);
  return issues;
}

function validateSubagentFailed(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const a = expectAgentValue(payload, 'agent', basePath, SUBAGENT_AGENTS);
  if (a) issues.push(a);
  const err = expectNonEmptyString(payload, 'error', basePath);
  if (err) issues.push(err);
  return issues;
}

function validateTaskGraphTaskEvent(
  kind: 'ready' | 'started',
  payload: unknown,
  basePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const t = expectNonEmptyString(payload, 'taskId', basePath);
  if (t) issues.push(t);
  const a = expectAgentValue(payload, 'agent', basePath, TASK_GRAPH_AGENTS);
  if (a) issues.push(a);
  const d = expectOptionalString(payload, 'detail', basePath);
  if (d) issues.push(d);
  // `kind` is unused today but reserved so callers don't lose the
  // per-variant context if we tighten individual shapes later.
  void kind;
  return issues;
}

function validateTaskGraphTaskCompleted(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const t = expectNonEmptyString(payload, 'taskId', basePath);
  if (t) issues.push(t);
  const a = expectAgentValue(payload, 'agent', basePath, TASK_GRAPH_AGENTS);
  if (a) issues.push(a);
  // `summary` is required and should be a string (possibly empty —
  // executor-side we default to `''` when the downstream kernel does
  // not produce one).
  if (typeof payload.summary !== 'string') {
    issues.push({
      path: `${basePath}.summary`,
      message: `expected string, got ${JSON.stringify(payload.summary)}`,
    });
  }
  const elapsed = expectOptionalFiniteNumber(payload, 'elapsedMs', basePath);
  if (elapsed) issues.push(elapsed);
  return issues;
}

function validateTaskGraphTaskFailed(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const t = expectNonEmptyString(payload, 'taskId', basePath);
  if (t) issues.push(t);
  const a = expectAgentValue(payload, 'agent', basePath, TASK_GRAPH_AGENTS);
  if (a) issues.push(a);
  const err = expectNonEmptyString(payload, 'error', basePath);
  if (err) issues.push(err);
  const elapsed = expectOptionalFiniteNumber(payload, 'elapsedMs', basePath);
  if (elapsed) issues.push(elapsed);
  return issues;
}

function validateTaskGraphTaskCancelled(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  const t = expectNonEmptyString(payload, 'taskId', basePath);
  if (t) issues.push(t);
  const a = expectAgentValue(payload, 'agent', basePath, TASK_GRAPH_AGENTS);
  if (a) issues.push(a);
  const r = expectNonEmptyString(payload, 'reason', basePath);
  if (r) issues.push(r);
  const elapsed = expectOptionalFiniteNumber(payload, 'elapsedMs', basePath);
  if (elapsed) issues.push(elapsed);
  return issues;
}

function validateTaskGraphGraphCompleted(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  const e = expectNonEmptyString(payload, 'executionId', basePath);
  if (e) issues.push(e);
  if (typeof payload.summary !== 'string') {
    issues.push({
      path: `${basePath}.summary`,
      message: `expected string, got ${JSON.stringify(payload.summary)}`,
    });
  }
  if (typeof payload.success !== 'boolean') {
    issues.push({
      path: `${basePath}.success`,
      message: `expected boolean, got ${JSON.stringify(payload.success)}`,
    });
  }
  if (typeof payload.aborted !== 'boolean') {
    issues.push({
      path: `${basePath}.aborted`,
      message: `expected boolean, got ${JSON.stringify(payload.aborted)}`,
    });
  }
  if (!isFiniteNonNegativeInt(payload.nodeCount)) {
    issues.push({
      path: `${basePath}.nodeCount`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.nodeCount)}`,
    });
  }
  if (!isFiniteNonNegativeInt(payload.totalRounds)) {
    issues.push({
      path: `${basePath}.totalRounds`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.totalRounds)}`,
    });
  }
  if (!isFiniteNonNegativeInt(payload.wallTimeMs)) {
    issues.push({
      path: `${basePath}.wallTimeMs`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.wallTimeMs)}`,
    });
  }
  return issues;
}

export const PROMPT_SNAPSHOT_ROLES = [
  'orchestrator',
  'explorer',
  'coder',
  'reviewer',
  'auditor',
] as const;

function validateAssistantPromptSnapshot(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  if (!isFiniteNonNegativeInt(payload.round)) {
    issues.push({
      path: `${basePath}.round`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.round)}`,
    });
  }
  const r = expectAgentValue(payload, 'role', basePath, PROMPT_SNAPSHOT_ROLES);
  if (r) issues.push(r);
  if (!isFiniteNonNegativeInt(payload.totalChars)) {
    issues.push({
      path: `${basePath}.totalChars`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.totalChars)}`,
    });
  }
  if (!isPlainObject(payload.sections)) {
    issues.push({
      path: `${basePath}.sections`,
      message: `expected plain object, got ${typeof payload.sections}`,
    });
  } else {
    for (const [sectionId, entry] of Object.entries(payload.sections)) {
      const sectionPath = `${basePath}.sections.${sectionId}`;
      if (!isPlainObject(entry)) {
        issues.push({
          path: sectionPath,
          message: `expected plain object, got ${typeof entry}`,
        });
        continue;
      }
      if (typeof entry.hash !== 'number' || !Number.isFinite(entry.hash)) {
        issues.push({
          path: `${sectionPath}.hash`,
          message: `expected finite number, got ${JSON.stringify(entry.hash)}`,
        });
      }
      if (!isFiniteNonNegativeInt(entry.size)) {
        issues.push({
          path: `${sectionPath}.size`,
          message: `expected non-negative integer, got ${JSON.stringify(entry.size)}`,
        });
      }
      if (typeof entry.volatile !== 'boolean') {
        issues.push({
          path: `${sectionPath}.volatile`,
          message: `expected boolean, got ${JSON.stringify(entry.volatile)}`,
        });
      }
    }
  }
  return issues;
}

export const COMPACTION_PHASES = ['summarization', 'digest_drop', 'hard_trim'] as const;
export const COMPACTION_CAUSES = ['tool_output', 'long_message', 'mixed'] as const;

function validateContextCompaction(payload: unknown, basePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(payload)) {
    issues.push({ path: basePath, message: `expected plain object, got ${typeof payload}` });
    return issues;
  }
  if (!isFiniteNonNegativeInt(payload.round)) {
    issues.push({
      path: `${basePath}.round`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.round)}`,
    });
  }
  const ph = expectAgentValue(payload, 'phase', basePath, COMPACTION_PHASES);
  if (ph) issues.push(ph);
  if (!isFiniteNonNegativeInt(payload.beforeTokens)) {
    issues.push({
      path: `${basePath}.beforeTokens`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.beforeTokens)}`,
    });
  }
  if (!isFiniteNonNegativeInt(payload.afterTokens)) {
    issues.push({
      path: `${basePath}.afterTokens`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.afterTokens)}`,
    });
  }
  if (!isFiniteNonNegativeInt(payload.messagesDropped)) {
    issues.push({
      path: `${basePath}.messagesDropped`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.messagesDropped)}`,
    });
  }
  const p = expectOptionalString(payload, 'provider', basePath);
  if (p) issues.push(p);
  // `cause` is optional. When present it must be one of the documented
  // values. Use `expectAgentValue` with the cause enum; tolerate
  // omission by checking field presence first.
  if (payload.cause !== undefined) {
    const c = expectAgentValue(payload, 'cause', basePath, COMPACTION_CAUSES);
    if (c) issues.push(c);
  }
  return issues;
}

/**
 * `session_state_changed` carries the daemon's current session-scoped state
 * after `update_session` or `configure_role_routing` mutates it. Clients
 * mirror their local view from this payload — the daemon is the source of
 * truth for `provider`, `model`, and `roleRouting`.
 *
 * Required: `provider` (non-empty string), `model` (non-empty string).
 * Optional but expected: `roleRouting` (plain object). Validator is
 * permissive about per-role entries because role validation lives in
 * `cli/pushd.ts:handleConfigureRoleRouting` — duplicating it here would
 * couple the schema module to the agent role table.
 */
function validateSessionStateChanged(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected object, got ${JSON.stringify(payload)}` }];
  }
  const issues: ValidationIssue[] = [];
  const provider = expectNonEmptyString(payload, 'provider', basePath);
  if (provider) issues.push(provider);
  const model = expectNonEmptyString(payload, 'model', basePath);
  if (model) issues.push(model);
  if ('roleRouting' in payload && payload.roleRouting !== undefined) {
    if (!isPlainObject(payload.roleRouting)) {
      issues.push({
        path: `${basePath}.roleRouting`,
        message: `expected plain object or omitted, got ${JSON.stringify(payload.roleRouting)}`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Daemon-emitted lifecycle / streaming event validators (PR #4)
// ---------------------------------------------------------------------------
//
// The events covered below all have stable on-the-wire shapes pinned
// by `cli/pushd.ts` (the daemon broadcaster) and read by `cli/tui.ts`
// (`handleEngineEvent`) and `app/src/hooks/chat-*` (web round loop).
// Before this batch the protocol-drift suite only validated the nine
// delegation envelopes + two prompt/compaction envelopes — 40+ other
// daemon-emitted types went through strict mode unchecked, so a
// rename or wrong-type regression survived CI as long as the
// envelope-level fields (v/kind/sessionId/seq/ts/type/payload) were
// well-formed. Each validator below is intentionally narrow about
// the keys it pins (the ones at least one consumer actually reads)
// and permissive about extras so additive payload growth is safe.

/** Tokens streamed back to the TUI/web. Payload carries the chunk text.
 *
 * `text` must be a string (so concat sites never get `undefined`), but
 * may be empty — provider streams legitimately emit zero-length deltas
 * across the content/reasoning boundary, and rejecting them in strict
 * mode killed the daemon's broadcast loop on real runs. */
function validateAssistantTextChunk(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  if (typeof payload.text !== 'string') {
    issues.push({
      path: `${basePath}.text`,
      message: `expected string, got ${JSON.stringify(payload.text)}`,
    });
  }
  return issues;
}

/** Web-search sources (OpenRouter `openrouter:web_search`). The TUI and web
 * both render `payload.citations[]`, so pin the array shape plus the
 * per-citation fields a consumer reads — `url` (required, non-empty),
 * `title` / `content` (strings, may be empty), and the `startIndex` /
 * `endIndex` offsets. Permissive about extras, matching the module. */
function validateAssistantCitations(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(payload.citations)) {
    issues.push({
      path: `${basePath}.citations`,
      message: `expected array, got ${JSON.stringify(payload.citations)}`,
    });
    return issues;
  }
  payload.citations.forEach((c, i) => {
    const p = `${basePath}.citations[${i}]`;
    if (!isPlainObject(c)) {
      issues.push({ path: p, message: `expected plain object, got ${typeof c}` });
      return;
    }
    const u = expectNonEmptyString(c, 'url', p);
    if (u) issues.push(u);
    if (typeof c.title !== 'string') {
      issues.push({
        path: `${p}.title`,
        message: `expected string, got ${JSON.stringify(c.title)}`,
      });
    }
    if (typeof c.content !== 'string') {
      issues.push({
        path: `${p}.content`,
        message: `expected string, got ${JSON.stringify(c.content)}`,
      });
    }
    const si = expectOptionalNonNegativeInteger(c, 'startIndex', p);
    if (si) issues.push(si);
    const ei = expectOptionalNonNegativeInteger(c, 'endIndex', p);
    if (ei) issues.push(ei);
  });
  return issues;
}

/** Tool call announcement. Both `tool_call` and `tool.execution_start`
 * land here because the TUI reads the same fields out of both. */
function validateToolCall(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const n = expectNonEmptyString(payload, 'toolName', basePath);
  if (n) issues.push(n);
  // `args` is required but can be any JSON shape (string keys → any
  // value). We only insist it's *present and an object*; per-tool
  // arg schemas live in `lib/tool-registry.ts` and validate there.
  if (!isPlainObject(payload.args)) {
    issues.push({
      path: `${basePath}.args`,
      message: `expected plain object, got ${JSON.stringify(payload.args)}`,
    });
  }
  return issues;
}

/** Tool call result. Both `tool_result` and `tool.execution_complete`
 * land here. `text` and `preview` are alternates — the TUI's
 * `handleEngineEvent` reads `text || preview`. */
function validateToolResult(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const n = expectNonEmptyString(payload, 'toolName', basePath);
  if (n) issues.push(n);
  if (typeof payload.isError !== 'boolean') {
    issues.push({
      path: `${basePath}.isError`,
      message: `expected boolean, got ${JSON.stringify(payload.isError)}`,
    });
  }
  // text / preview both optional strings (one or the other is usually
  // present; neither being set is legitimate for fire-and-forget
  // tools whose stdout is intentionally discarded).
  const t = expectOptionalString(payload, 'text', basePath);
  if (t) issues.push(t);
  const p = expectOptionalString(payload, 'preview', basePath);
  if (p) issues.push(p);
  const target = expectOptionalString(payload, 'target', basePath);
  if (target) issues.push(target);
  const d = expectOptionalFiniteNumber(payload, 'durationMs', basePath);
  if (d) issues.push(d);
  const b = expectOptionalString(payload, 'branch', basePath);
  if (b) issues.push(b);
  // `diff` — optional structured edit diff for file-mutation tools
  // (edit_file / write_file). Shape is owned by lib/edit-diff.ts; here we
  // pin the envelope-level contract deeply enough that a renderer can
  // trust field types without re-validating per line.
  if ('diff' in payload && payload.diff !== undefined) {
    issues.push(...validateEditDiffField(payload.diff, `${basePath}.diff`));
  }
  return issues;
}

/** Validate the optional `diff` field on tool result payloads. */
function validateEditDiffField(diff: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(diff)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof diff}` }];
  }
  const issues: ValidationIssue[] = [];
  const p = expectNonEmptyString(diff, 'path', basePath);
  if (p) issues.push(p);
  for (const counter of ['adds', 'dels'] as const) {
    if (typeof diff[counter] !== 'number' || !Number.isFinite(diff[counter])) {
      issues.push({
        path: `${basePath}.${counter}`,
        message: `expected finite number, got ${JSON.stringify(diff[counter])}`,
      });
    }
  }
  if (!Array.isArray(diff.lines)) {
    issues.push({
      path: `${basePath}.lines`,
      message: `expected array, got ${typeof diff.lines}`,
    });
    return issues;
  }
  diff.lines.forEach((line, index) => {
    const linePath = `${basePath}.lines[${index}]`;
    if (!isPlainObject(line)) {
      issues.push({ path: linePath, message: `expected plain object, got ${typeof line}` });
      return;
    }
    if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'ctx') {
      issues.push({
        path: `${linePath}.kind`,
        message: `expected 'add' | 'del' | 'ctx', got ${JSON.stringify(line.kind)}`,
      });
    }
    if (typeof line.text !== 'string') {
      issues.push({
        path: `${linePath}.text`,
        message: `expected string, got ${typeof line.text}`,
      });
    }
    for (const numField of ['oldLine', 'newLine'] as const) {
      const numIssue = expectOptionalFiniteNumber(line, numField, linePath);
      if (numIssue) issues.push(numIssue);
    }
  });
  return issues;
}

/** Branch-desync detection after a stamped sandbox_exec result. */
function validateBranchDesync(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const expected = expectNonEmptyString(payload, 'expected', basePath);
  if (expected) issues.push(expected);
  const actual = expectNonEmptyString(payload, 'actual', basePath);
  if (actual) issues.push(actual);
  const command = expectNonEmptyString(payload, 'command', basePath);
  if (command) issues.push(command);
  return issues;
}

/** Parser-side malformed tool call detection. */
function validateToolCallMalformed(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const r = expectNonEmptyString(payload, 'reason', basePath);
  if (r) issues.push(r);
  return issues;
}

/** Runtime error event. */
function validateErrorPayload(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const m = expectNonEmptyString(payload, 'message', basePath);
  if (m) issues.push(m);
  // `code` is optional but, when present, must be a non-empty string —
  // empty/null codes were a regression source on PR #656 because the
  // surface code defaulted to "everything is unknown."
  if ('code' in payload && payload.code !== undefined) {
    if (!isNonEmptyString(payload.code)) {
      issues.push({
        path: `${basePath}.code`,
        message: `expected non-empty string or omitted, got ${JSON.stringify(payload.code)}`,
      });
    }
  }
  if ('retryable' in payload && payload.retryable !== undefined) {
    if (typeof payload.retryable !== 'boolean') {
      issues.push({
        path: `${basePath}.retryable`,
        message: `expected boolean or omitted, got ${JSON.stringify(payload.retryable)}`,
      });
    }
  }
  return issues;
}

/** Soft warning event. At least one of `message` / `code` is required
 * because the TUI renders `event.payload.message || event.payload.code`
 * and an empty warning chip is worse than no event. Both fields are
 * also type-checked when present so a malformed-but-truthy value
 * (e.g. `message: 123`) doesn't slip past the OR-fallback and end up
 * rendered as a non-string transcript entry (codex / copilot review
 * on PR #666). */
function validateWarningPayload(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  if ('message' in payload && payload.message !== undefined && !isNonEmptyString(payload.message)) {
    issues.push({
      path: `${basePath}.message`,
      message: `expected non-empty string or omitted, got ${JSON.stringify(payload.message)}`,
    });
  }
  if ('code' in payload && payload.code !== undefined && !isNonEmptyString(payload.code)) {
    issues.push({
      path: `${basePath}.code`,
      message: `expected non-empty string or omitted, got ${JSON.stringify(payload.code)}`,
    });
  }
  const hasMessage = isNonEmptyString(payload.message);
  const hasCode = isNonEmptyString(payload.code);
  if (!hasMessage && !hasCode) {
    issues.push({
      path: basePath,
      message: 'expected at least one of "message" or "code" to be a non-empty string',
    });
  }
  return issues;
}

/** Status / progress event — same one-of rule as warning since the
 * TUI renders `payload.detail || payload.phase`. Each field also
 * type-checked when present so a truthy non-string can't win the
 * OR-fallback (codex / copilot review on PR #666). */
function validateStatusPayload(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  if ('detail' in payload && payload.detail !== undefined && !isNonEmptyString(payload.detail)) {
    issues.push({
      path: `${basePath}.detail`,
      message: `expected non-empty string or omitted, got ${JSON.stringify(payload.detail)}`,
    });
  }
  if ('phase' in payload && payload.phase !== undefined && !isNonEmptyString(payload.phase)) {
    issues.push({
      path: `${basePath}.phase`,
      message: `expected non-empty string or omitted, got ${JSON.stringify(payload.phase)}`,
    });
  }
  const hasDetail = isNonEmptyString(payload.detail);
  const hasPhase = isNonEmptyString(payload.phase);
  if (!hasDetail && !hasPhase) {
    issues.push({
      path: basePath,
      message: 'expected at least one of "detail" or "phase" to be a non-empty string',
    });
  }
  return issues;
}

/** Approval request. Triggers an approval modal in the TUI / web. */
function validateApprovalRequired(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const id = expectNonEmptyString(payload, 'approvalId', basePath);
  if (id) issues.push(id);
  const kind = expectNonEmptyString(payload, 'kind', basePath);
  if (kind) issues.push(kind);
  const title = expectNonEmptyString(payload, 'title', basePath);
  if (title) issues.push(title);
  if (typeof payload.summary !== 'string') {
    // summary can be empty (e.g. for tools without a free-form
    // detail), but must be a string — older daemons sometimes
    // passed objects/JSON and the modal rendered "[object Object]".
    issues.push({
      path: `${basePath}.summary`,
      message: `expected string, got ${JSON.stringify(payload.summary)}`,
    });
  }
  // `options` is an array of non-empty strings: app consumers
  // (`useApprovalQueue`) iterate it and use the entries as button
  // labels. A non-string element falls back to the default
  // approve/deny pair and silently hides the daemon's intent
  // (copilot review on PR #666). Pin both the array shape AND the
  // per-element type.
  if (!Array.isArray(payload.options) || payload.options.length === 0) {
    issues.push({
      path: `${basePath}.options`,
      message: `expected non-empty array of non-empty strings, got ${JSON.stringify(payload.options)}`,
    });
  } else {
    for (let i = 0; i < payload.options.length; i += 1) {
      if (!isNonEmptyString(payload.options[i])) {
        issues.push({
          path: `${basePath}.options[${i}]`,
          message: `expected non-empty string, got ${JSON.stringify(payload.options[i])}`,
        });
      }
    }
  }
  return issues;
}

/** Approval decision broadcast. */
function validateApprovalReceived(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const id = expectNonEmptyString(payload, 'approvalId', basePath);
  if (id) issues.push(id);
  if (payload.decision !== 'approve' && payload.decision !== 'deny') {
    issues.push({
      path: `${basePath}.decision`,
      message: `expected "approve" or "deny", got ${JSON.stringify(payload.decision)}`,
    });
  }
  // `by` is informational; when present should be a non-empty string.
  if ('by' in payload && payload.by !== undefined) {
    if (!isNonEmptyString(payload.by)) {
      issues.push({
        path: `${basePath}.by`,
        message: `expected non-empty string or omitted, got ${JSON.stringify(payload.by)}`,
      });
    }
  }
  return issues;
}

/** Allowed values for `run_complete.outcome`. Mirrors the union used by
 * the engine's emit sites (`cli/engine.ts` + the daemon's failure
 * fallback in `cli/pushd.ts:handleSendUserMessage`). Kept narrow so a
 * typo at emit time fails strict-mode loudly; expand here when a new
 * outcome ships. */
export const RUN_COMPLETE_OUTCOMES = [
  'success',
  'completed',
  'failed',
  'aborted',
  'max_rounds',
] as const;

/** Run-end event. */
function validateRunComplete(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const outcome = payload.outcome;
  if (typeof outcome !== 'string' || !RUN_COMPLETE_OUTCOMES.includes(outcome as never)) {
    issues.push({
      path: `${basePath}.outcome`,
      message: `expected one of ${JSON.stringify(RUN_COMPLETE_OUTCOMES)}, got ${JSON.stringify(outcome)}`,
    });
  }
  // `summary` and `runId` both optional; daemon-side they're populated
  // when the kernel surfaces a final message.
  const s = expectOptionalString(payload, 'summary', basePath);
  if (s) issues.push(s);
  const r = expectOptionalString(payload, 'runId', basePath);
  if (r) issues.push(r);
  return issues;
}

/** Session-creation marker emitted once at start_session. */
function validateSessionStarted(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const sid = expectNonEmptyString(payload, 'sessionId', basePath);
  if (sid) issues.push(sid);
  if (payload.state !== 'idle' && payload.state !== 'running') {
    issues.push({
      path: `${basePath}.state`,
      message: `expected "idle" or "running", got ${JSON.stringify(payload.state)}`,
    });
  }
  const mode = expectOptionalString(payload, 'mode', basePath);
  if (mode) issues.push(mode);
  const provider = expectOptionalString(payload, 'provider', basePath);
  if (provider) issues.push(provider);
  const sbox = expectOptionalString(payload, 'sandboxProvider', basePath);
  if (sbox) issues.push(sbox);
  return issues;
}

/** User-message echo emitted after `send_user_message`. The web and
 * the TUI both re-render their own message synchronously and ignore
 * this event today (it lives on the `TUI_KNOWN_NOOP_EVENT_TYPES`
 * allowlist) — pinning the shape now prevents a regression where the
 * payload silently flips to something that breaks future consumers. */
function validateUserMessage(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  if (!isFiniteNonNegativeInt(payload.chars)) {
    issues.push({
      path: `${basePath}.chars`,
      message: `expected non-negative integer, got ${JSON.stringify(payload.chars)}`,
    });
  }
  if (typeof payload.preview !== 'string') {
    issues.push({
      path: `${basePath}.preview`,
      message: `expected string, got ${JSON.stringify(payload.preview)}`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Session-mutation broadcasts + recovery/interruption events
//
// Shapes derived from the single emission site for each type in
// `cli/pushd.ts`. The compaction/revert trio is live-broadcast; the recovery
// trio is appended via `appendSessionEvent` (not live-broadcast) but reaches
// clients on reconnect through the replay path, which runs the same validated
// `emitEventWithDowngrade` fan-out — so a payload validator catches drift on
// either path. All fields are required at their (single) emission site.
// ---------------------------------------------------------------------------

function validateAllNonNegativeIntegers(
  payload: unknown,
  basePath: string,
  fields: readonly string[],
): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    const issue = expectNonNegativeInteger(payload, field, basePath);
    if (issue) issues.push(issue);
  }
  return issues;
}

function validateContextCompacted(payload: unknown, basePath: string): ValidationIssue[] {
  return validateAllNonNegativeIntegers(payload, basePath, [
    'preserveTurns',
    'totalTurns',
    'compactedMessages',
    'removedCount',
    'beforeTokens',
    'afterTokens',
  ]);
}

function validateSessionReverted(payload: unknown, basePath: string): ValidationIssue[] {
  return validateAllNonNegativeIntegers(payload, basePath, [
    'turns',
    'removedCount',
    'totalTurns',
    'remainingTurns',
    'remainingMessages',
  ]);
}

function validateSessionUnreverted(payload: unknown, basePath: string): ValidationIssue[] {
  return validateAllNonNegativeIntegers(payload, basePath, ['restoredCount', 'totalMessages']);
}

function validateRunRecovered(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  for (const field of ['originalRunId', 'recoveryRunId', 'policy']) {
    const issue = expectNonEmptyString(payload, field, basePath);
    if (issue) issues.push(issue);
  }
  const age = expectFiniteNumber(payload, 'markerAge', basePath);
  if (age) issues.push(age);
  return issues;
}

function validateRecoverySkipped(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  for (const field of ['originalRunId', 'reason', 'policy']) {
    const issue = expectNonEmptyString(payload, field, basePath);
    if (issue) issues.push(issue);
  }
  const age = expectFiniteNumber(payload, 'markerAge', basePath);
  if (age) issues.push(age);
  return issues;
}

function validateDelegationInterrupted(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  for (const field of ['originalRunId', 'recoveryRunId']) {
    const issue = expectNonEmptyString(payload, field, basePath);
    if (issue) issues.push(issue);
  }
  // collectOrphanedDelegations (cli/pushd.ts) returns objects, not strings:
  // subagents: Array<{ subagentId, agent }>, graphs: Array<{ executionId }>.
  issues.push(...expectObjectArray(payload, 'subagents', basePath, ['subagentId', 'agent']));
  issues.push(...expectObjectArray(payload, 'graphs', basePath, ['executionId']));
  return issues;
}

// ---------------------------------------------------------------------------
// RunEventInput passthrough events
//
// These are forwarded by the run loop through the daemon's broadcast path
// (not daemon-originated). Shapes are the canonical RunEventInput union
// members in lib/runtime-contract.ts, minus the discriminant `type` (which
// lives on the envelope) — the payload is the member's remaining fields, the
// same mapping the existing prompt_snapshot / tool.* / subagent.* validators
// already assume. `role` is `AgentRole`, whose value set is exactly
// PROMPT_SNAPSHOT_ROLES (reused here rather than duplicated).
// ---------------------------------------------------------------------------

export const TURN_END_OUTCOMES = ['completed', 'continued', 'error', 'aborted', 'steered'] as const;

function validateAssistantTurnStart(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issue = expectNonNegativeInteger(payload, 'round', basePath);
  return issue ? [issue] : [];
}

function validateAssistantTurnEnd(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const round = expectNonNegativeInteger(payload, 'round', basePath);
  if (round) issues.push(round);
  const outcome = expectAgentValue(payload, 'outcome', basePath, TURN_END_OUTCOMES);
  if (outcome) issues.push(outcome);
  return issues;
}

function validateHarnessAdaptation(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  for (const field of ['round', 'fromMaxRounds', 'toMaxRounds']) {
    const issue = expectNonNegativeInteger(payload, field, basePath);
    if (issue) issues.push(issue);
  }
  issues.push(...expectNonEmptyStringArray(payload, 'reasons', basePath));
  return issues;
}

function validateJobStarted(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const exec = expectNonEmptyString(payload, 'executionId', basePath);
  if (exec) issues.push(exec);
  const role = expectAgentValue(payload, 'role', basePath, PROMPT_SNAPSHOT_ROLES);
  if (role) issues.push(role);
  const detail = expectOptionalString(payload, 'detail', basePath);
  if (detail) issues.push(detail);
  return issues;
}

function validateJobCompleted(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const exec = expectNonEmptyString(payload, 'executionId', basePath);
  if (exec) issues.push(exec);
  const role = expectAgentValue(payload, 'role', basePath, PROMPT_SNAPSHOT_ROLES);
  if (role) issues.push(role);
  const summary = expectNonEmptyString(payload, 'summary', basePath);
  if (summary) issues.push(summary);
  // delegationOutcome is optional and its shape is owned elsewhere — left
  // unchecked beyond the envelope's "permissive about extra fields" rule.
  return issues;
}

function validateJobFailed(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const exec = expectNonEmptyString(payload, 'executionId', basePath);
  if (exec) issues.push(exec);
  const role = expectAgentValue(payload, 'role', basePath, PROMPT_SNAPSHOT_ROLES);
  if (role) issues.push(role);
  const error = expectNonEmptyString(payload, 'error', basePath);
  if (error) issues.push(error);
  return issues;
}

function validateUserFollowUpQueued(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const round = expectNonNegativeInteger(payload, 'round', basePath);
  if (round) issues.push(round);
  const position = expectNonNegativeInteger(payload, 'position', basePath);
  if (position) issues.push(position);
  if (typeof payload.preview !== 'string') {
    issues.push({
      path: `${basePath}.preview`,
      message: `expected string, got ${JSON.stringify(payload.preview)}`,
    });
  }
  return issues;
}

function validateUserFollowUpSteered(payload: unknown, basePath: string): ValidationIssue[] {
  if (!isPlainObject(payload)) {
    return [{ path: basePath, message: `expected plain object, got ${typeof payload}` }];
  }
  const issues: ValidationIssue[] = [];
  const round = expectNonNegativeInteger(payload, 'round', basePath);
  if (round) issues.push(round);
  if (typeof payload.preview !== 'string') {
    issues.push({
      path: `${basePath}.preview`,
      message: `expected string, got ${JSON.stringify(payload.preview)}`,
    });
  }
  if (typeof payload.replacedPending !== 'boolean') {
    issues.push({
      path: `${basePath}.replacedPending`,
      message: `expected boolean, got ${JSON.stringify(payload.replacedPending)}`,
    });
  }
  return issues;
}

const PAYLOAD_VALIDATORS: Record<string, PayloadValidator> = {
  // Existing delegation + dev observability + state events.
  'assistant.prompt_snapshot': validateAssistantPromptSnapshot,
  'context.compaction': validateContextCompaction,
  session_state_changed: validateSessionStateChanged,
  'subagent.started': validateSubagentStarted,
  'subagent.completed': validateSubagentCompleted,
  'subagent.failed': validateSubagentFailed,
  'task_graph.task_ready': (p, b) => validateTaskGraphTaskEvent('ready', p, b),
  'task_graph.task_started': (p, b) => validateTaskGraphTaskEvent('started', p, b),
  'task_graph.task_completed': validateTaskGraphTaskCompleted,
  'task_graph.task_failed': validateTaskGraphTaskFailed,
  'task_graph.task_cancelled': validateTaskGraphTaskCancelled,
  'task_graph.graph_completed': validateTaskGraphGraphCompleted,

  // PR #4 batch: daemon-emitted lifecycle + streaming events. See the
  // section comment above the validators for the rationale.
  assistant_token: validateAssistantTextChunk,
  assistant_thinking_token: validateAssistantTextChunk,
  assistant_citations: validateAssistantCitations,
  tool_call: validateToolCall,
  'tool.execution_start': validateToolCall,
  tool_result: validateToolResult,
  'tool.execution_complete': validateToolResult,
  branch_desync: validateBranchDesync,
  'tool.call_malformed': validateToolCallMalformed,
  error: validateErrorPayload,
  warning: validateWarningPayload,
  status: validateStatusPayload,
  approval_required: validateApprovalRequired,
  approval_received: validateApprovalReceived,
  run_complete: validateRunComplete,
  session_started: validateSessionStarted,
  user_message: validateUserMessage,

  // Session-mutation broadcasts + recovery/interruption events. The recovery
  // trio is persisted-only but replayed through the validated fan-out on
  // reconnect. Promotes these off this module's former non-goals list.
  context_compacted: validateContextCompacted,
  session_reverted: validateSessionReverted,
  session_unreverted: validateSessionUnreverted,
  run_recovered: validateRunRecovered,
  recovery_skipped: validateRecoverySkipped,
  delegation_interrupted: validateDelegationInterrupted,

  // RunEventInput passthrough events (forwarded by the run loop). Shapes are
  // the canonical union members in lib/runtime-contract.ts.
  'turn.route': validateTurnRoute,
  'assistant.turn_start': validateAssistantTurnStart,
  'assistant.turn_end': validateAssistantTurnEnd,
  'harness.adaptation': validateHarnessAdaptation,
  'job.started': validateJobStarted,
  'job.completed': validateJobCompleted,
  'job.failed': validateJobFailed,
  'user.follow_up_queued': validateUserFollowUpQueued,
  'user.follow_up_steered': validateUserFollowUpSteered,
};

/** The set of event types that have a per-payload schema in this module. */
export const SCHEMA_VALIDATED_EVENT_TYPES = new Set(Object.keys(PAYLOAD_VALIDATORS));

/**
 * Validate a payload against the per-type schema. Returns issues if
 * the schema exists and the payload doesn't match. Returns an empty
 * array for event types with no registered schema (e.g. `assistant_done`,
 * which is intentionally envelope-only — it carries no required payload) —
 * those are handled by envelope validation only.
 */
export function validateRunEventPayload(type: string, payload: unknown): ValidationIssue[] {
  const validator = PAYLOAD_VALIDATORS[type];
  if (!validator) return [];
  return validator(payload, 'payload');
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

/**
 * Run envelope + per-type payload validation. Returns all issues
 * flattened into a single array.
 */
export function validateEvent(event: unknown): ValidationIssue[] {
  const envelopeIssues = validateEventEnvelope(event);
  if (envelopeIssues.length > 0) return envelopeIssues;
  // Envelope passed — now validate the payload if we know its shape.
  const e = event as Record<string, unknown>;
  return validateRunEventPayload(e.type as string, e.payload);
}

/**
 * Throw a formatted error if the event fails validation. Used by the
 * strict-mode wiring in `broadcastEvent` so regressions land as test
 * failures instead of silent wire drift.
 */
export function assertValidEvent(event: unknown): void {
  const issues = validateEvent(event);
  if (issues.length === 0) return;
  const lines = issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`);
  const eventType =
    isPlainObject(event) && typeof event.type === 'string' ? event.type : '(unknown)';
  throw new Error(
    `Protocol schema violation on event "${eventType}":\n${lines.join('\n')}\n` +
      `Full envelope: ${JSON.stringify(event)}`,
  );
}

// ---------------------------------------------------------------------------
// Relay-control envelopes (Phase 2.d.1)
// ---------------------------------------------------------------------------

/**
 * Envelopes the Worker-mediated relay parses out of the forwarded
 * NDJSON stream. Unlike `kind: 'event'` envelopes (which are
 * unidirectional broadcasts with seq/sessionId/etc), these are
 * relay-control messages exchanged between:
 *
 *   - pushd → relay: `relay_phone_allow`, `relay_phone_revoke`
 *     (the hash-keyed allowlist that gates pushd ↔ phone forwarding;
 *     entries are `sha256(bearer)` as base64url, NOT bearer plaintext —
 *     pushd persists only the hash, so the wire can only carry the
 *     hash too).
 *
 *   - phone → relay: `relay_attach`
 *     (carries `lastSeq` for replay; consumed by the buffer in 2.d.2).
 *
 *   - relay → phone: `relay_replay_unavailable`
 *     (emitted when the reconnect gap is larger than the ring buffer;
 *     consumed in 2.d.2).
 *
 * The schema lives in `lib/protocol-schema.ts` per the AGENTS.md "one
 * source of truth per vocabulary" guardrail. Wire version stays
 * `push.runtime.v1` — these are new kinds in the existing vocabulary,
 * not a parallel relay-only vocabulary (per the decision doc's
 * "Extend push.runtime.v1; do not invent a second remote-session
 * vocabulary" implementation rule).
 *
 * The relay enforces these via `validateRelayEnvelope()`; the drift
 * test in `cli/tests/protocol-drift.test.mjs` pins the kind list
 * against `RELAY_ENVELOPE_KINDS` so adding a new kind without a
 * validator update fails CI.
 */

export const RELAY_ENVELOPE_KINDS = [
  'relay_phone_allow',
  'relay_phone_revoke',
  'relay_attach',
  'relay_replay_unavailable',
] as const;

export type RelayEnvelopeKind = (typeof RELAY_ENVELOPE_KINDS)[number];

export interface RelayPhoneAllowEnvelope {
  v: 'push.runtime.v1';
  kind: 'relay_phone_allow';
  /**
   * `sha256(bearer)` base64url-encoded, one per phone the relay
   * should accept forwarded traffic for. pushd persists attach
   * tokens by hash only, so the wire vocabulary matches: bearer
   * plaintext would have nowhere to come from on a fresh daemon
   * boot. The relay computes the same hash on each phone's WS
   * upgrade subprotocol bearer and compares set-membership.
   */
  tokenHashes: readonly string[];
  ts: number;
}

export interface RelayPhoneRevokeEnvelope {
  v: 'push.runtime.v1';
  kind: 'relay_phone_revoke';
  /** Same encoding as {@link RelayPhoneAllowEnvelope.tokenHashes}. */
  tokenHashes: readonly string[];
  ts: number;
}

export interface RelayAttachEnvelope {
  v: 'push.runtime.v1';
  kind: 'relay_attach';
  lastSeq?: number;
  ts: number;
}

export interface RelayReplayUnavailableEnvelope {
  v: 'push.runtime.v1';
  kind: 'relay_replay_unavailable';
  reason: string;
  ts: number;
}

export type RelayEnvelope =
  | RelayPhoneAllowEnvelope
  | RelayPhoneRevokeEnvelope
  | RelayAttachEnvelope
  | RelayReplayUnavailableEnvelope;

/**
 * Quick discriminator: returns true if the value is a plain object
 * with a `kind` matching one of `RELAY_ENVELOPE_KINDS`. Use this
 * before calling `validateRelayEnvelope` to differentiate relay
 * control messages from forwardable runtime events.
 */
export function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  return typeof kind === 'string' && (RELAY_ENVELOPE_KINDS as readonly string[]).includes(kind);
}

/**
 * Strict-mode validator. Returns issues if the envelope fails its
 * per-kind contract. Returns an empty array on success.
 *
 * Intentionally permissive about extra fields — adding new optional
 * fields on a relay envelope should not break validation for
 * existing consumers.
 */
export function validateRelayEnvelope(env: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(env)) {
    issues.push({ path: '', message: `expected plain object, got ${typeof env}` });
    return issues;
  }

  if (env.v !== PROTOCOL_VERSION) {
    issues.push({
      path: 'v',
      message: `expected "${PROTOCOL_VERSION}", got ${JSON.stringify(env.v)}`,
    });
  }

  const kind = env.kind;
  if (typeof kind !== 'string' || !(RELAY_ENVELOPE_KINDS as readonly string[]).includes(kind)) {
    issues.push({
      path: 'kind',
      message: `expected one of ${RELAY_ENVELOPE_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`,
    });
    return issues;
  }

  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts) || env.ts < 0) {
    issues.push({
      path: 'ts',
      message: `expected non-negative finite number (ms since epoch), got ${JSON.stringify(env.ts)}`,
    });
  }

  if (kind === 'relay_phone_allow' || kind === 'relay_phone_revoke') {
    if (!Array.isArray(env.tokenHashes)) {
      issues.push({
        path: 'tokenHashes',
        message: `expected array of strings, got ${JSON.stringify(env.tokenHashes)}`,
      });
    } else {
      for (let i = 0; i < env.tokenHashes.length; i += 1) {
        const hash = env.tokenHashes[i];
        if (typeof hash !== 'string' || hash.length === 0) {
          issues.push({
            path: `tokenHashes[${i}]`,
            message: `expected non-empty string, got ${JSON.stringify(hash)}`,
          });
        }
      }
    }
  } else if (kind === 'relay_attach') {
    if ('lastSeq' in env && env.lastSeq !== undefined && !isFiniteNonNegativeInt(env.lastSeq)) {
      issues.push({
        path: 'lastSeq',
        message: `expected non-negative integer or omitted, got ${JSON.stringify(env.lastSeq)}`,
      });
    }
  } else if (kind === 'relay_replay_unavailable') {
    if (!isNonEmptyString(env.reason)) {
      issues.push({
        path: 'reason',
        message: `expected non-empty string, got ${JSON.stringify(env.reason)}`,
      });
    }
  }

  return issues;
}

/**
 * Reserved field name the Worker relay DO stamps onto every phone→pushd
 * frame it forwards, carrying a per-connection sender id minted at WS upgrade
 * (`RelaySessionDO`). It is the ONLY trustworthy phone-identity signal pushd
 * has: the relay forwards frames without otherwise exposing which phone sent
 * them, and a phone setting this field itself is overwritten by the DO before
 * forwarding. pushd reads it to scope per-phone run ownership (so one paired
 * phone can't cancel another's `sandbox_exec` by guessing its runId) — see
 * the Remote Control Surface Audit, finding #3.
 *
 * Underscore-prefixed and pinned here (one source of truth per vocabulary, per
 * AGENTS.md) so the DO writer and the pushd reader can't drift; the
 * `cli/tests/protocol-drift.test.mjs` suite pins the value.
 */
export const RELAY_SENDER_FIELD = '_relaySender' as const;

/**
 * Workspace-patch card — a serialized snapshot of the uncommitted working
 * tree, persisted next to the assistant turn that produced it so the diff
 * can survive sandbox reclaim and be replayed against a fresh container on
 * the next session.
 *
 * Lives in the protocol-schema module (instead of `app/src/types/index.ts`)
 * because both the web app and the CLI need to round-trip the card without
 * one surface importing the other's UI types. The web app re-exports the
 * type from `app/src/types/index.ts` and wires it into the `ChatCard`
 * union; the CLI consumes the validator for drift detection.
 *
 * **V1 scope** is intentionally narrow: the card is *shaped* for future
 * `repoFullName + branch` lookups (so a fresh CLI run can find prior
 * work), but PR 1 stores nothing — capture and replay land in later PRs.
 * The schema itself is the contract.
 */

/** Schema-version tag. Bump when the on-disk shape changes; replay code
 *  must refuse cards with an unrecognised version. */
export const WORKSPACE_PATCH_CARD_SCHEMA_VERSION = 1 as const;

/**
 * Allowed values for `applyState.kind`. The tagged union below pairs
 * each kind with the per-kind required fields; this list is the drift
 * surface that the CLI test pins so a new variant added in one place
 * without the other fails CI.
 */
export const WORKSPACE_PATCH_APPLY_KINDS = ['pending', 'applied', 'refused', 'conflict'] as const;

export type WorkspacePatchApplyKind = (typeof WORKSPACE_PATCH_APPLY_KINDS)[number];

/**
 * Allowed reasons for `applyState.kind === 'refused'`. Mirrors the
 * pre-flight refusal rules already encoded in
 * `app/src/hooks/useCommitPush.ts:unreplayableDiffReason` (truncation
 * and binary-placeholder), plus `base-mismatch` for the future replay
 * pass when the captured `baseSha` no longer matches the live HEAD.
 */
export const WORKSPACE_PATCH_REFUSAL_REASONS = [
  'truncated',
  'binary-placeholder',
  'base-mismatch',
] as const;

export type WorkspacePatchRefusalReason = (typeof WORKSPACE_PATCH_REFUSAL_REASONS)[number];

/**
 * Apply lifecycle. `pending` is the as-captured state; the replay pass
 * (future PR) transitions to `applied`, `refused`, or `conflict`. The
 * tagged shape forces variant-specific fields to live on the variant —
 * the runtime validator rejects known-variant fields appearing on the
 * wrong variant (e.g. `{ kind: 'pending', appliedAt: 123 }`), so the
 * persisted contract matches what the TS type promises.
 */
export type WorkspacePatchApplyState =
  | { kind: 'pending' }
  | {
      kind: 'applied';
      appliedAt: number;
      /** Optional free-form note. Today carries `'already-applied'` when
       *  the replay pass detected the patch had already landed
       *  (`git apply --check --reverse` succeeded), so we can mark the
       *  card terminal without double-applying. */
      note?: string;
    }
  | { kind: 'refused'; reason: WorkspacePatchRefusalReason }
  | { kind: 'conflict'; detail: string };

/**
 * Per-variant *known* keys (some required, some optional — e.g.
 * `applied.appliedAt` is required while `applied.note` is optional).
 * The validator uses this table only to detect keys bleeding across
 * variants (e.g. a `refused` card carrying `appliedAt` left over from
 * when it was `applied`). It is **not** a required-fields table —
 * the per-variant required-field checks live inline in
 * {@link validateWorkspacePatchCard} below.
 *
 * Adding a new variant or a new per-variant field — required *or*
 * optional — means updating this table. The CLI drift test pins
 * both sides.
 *
 * Truly unknown forward-compat keys (not listed here) are still
 * accepted, matching the module's convention of permitting unknown
 * fields for cross-version compatibility.
 */
export const APPLY_STATE_VARIANT_KEYS = {
  pending: [] as readonly string[],
  applied: ['appliedAt', 'note'] as readonly string[],
  refused: ['reason'] as readonly string[],
  conflict: ['detail'] as readonly string[],
} as const satisfies Record<WorkspacePatchApplyKind, readonly string[]>;

export interface WorkspacePatchCardData {
  /** Must equal {@link WORKSPACE_PATCH_CARD_SCHEMA_VERSION}. */
  schemaVersion: typeof WORKSPACE_PATCH_CARD_SCHEMA_VERSION;
  /** `owner/repo` for the future cross-conversation lookup key. */
  repoFullName: string;
  /** Git branch this patch was captured against. */
  branch: string;
  /** `git rev-parse HEAD` at capture time. Replay refuses to apply when
   *  the live HEAD has diverged and the base commit is unreachable. */
  baseSha: string;
  /** The unified-diff byte-stream, including binary blobs from
   *  `git diff --binary`. Empty string is valid (workspace touched but
   *  net-clean). */
  diffBytes: string;
  /** True when {@link diffBytes} was clipped by the capture cap. Replay
   *  refuses truncated patches because `git apply` cannot replay them. */
  truncated: boolean;
  /** ms since epoch when the patch was captured. */
  capturedAt: number;
  /** Lifecycle slot — see {@link WorkspacePatchApplyState}. */
  applyState: WorkspacePatchApplyState;
}

/**
 * Validate an unknown value against the {@link WorkspacePatchCardData}
 * contract. Returns an array of issues (empty on success). Permissive
 * about extra fields — adding new optional metadata should not break
 * existing consumers, matching the convention in this module.
 */
export function validateWorkspacePatchCard(data: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(data)) {
    issues.push({ path: '', message: `expected plain object, got ${typeof data}` });
    return issues;
  }

  if (data.schemaVersion !== WORKSPACE_PATCH_CARD_SCHEMA_VERSION) {
    issues.push({
      path: 'schemaVersion',
      message: `expected ${WORKSPACE_PATCH_CARD_SCHEMA_VERSION}, got ${JSON.stringify(data.schemaVersion)}`,
    });
  }

  for (const field of ['repoFullName', 'branch', 'baseSha'] as const) {
    if (!isNonEmptyString(data[field])) {
      issues.push({
        path: field,
        message: `expected non-empty string, got ${JSON.stringify(data[field])}`,
      });
    }
  }

  // diffBytes is allowed to be empty (mutation that nets to clean).
  if (typeof data.diffBytes !== 'string') {
    issues.push({
      path: 'diffBytes',
      message: `expected string, got ${JSON.stringify(data.diffBytes)}`,
    });
  }

  if (typeof data.truncated !== 'boolean') {
    issues.push({
      path: 'truncated',
      message: `expected boolean, got ${JSON.stringify(data.truncated)}`,
    });
  }

  if (!isFiniteNonNegativeInt(data.capturedAt)) {
    issues.push({
      path: 'capturedAt',
      message: `expected non-negative integer, got ${JSON.stringify(data.capturedAt)}`,
    });
  }

  if (!isPlainObject(data.applyState)) {
    issues.push({
      path: 'applyState',
      message: `expected plain object, got ${typeof data.applyState}`,
    });
    return issues;
  }

  const apply = data.applyState;
  const kind = apply.kind;
  if (
    typeof kind !== 'string' ||
    !(WORKSPACE_PATCH_APPLY_KINDS as readonly string[]).includes(kind)
  ) {
    issues.push({
      path: 'applyState.kind',
      message: `expected one of ${WORKSPACE_PATCH_APPLY_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`,
    });
    return issues;
  }

  if (kind === 'applied') {
    if (!isFiniteNonNegativeInt(apply.appliedAt)) {
      issues.push({
        path: 'applyState.appliedAt',
        message: `expected non-negative integer, got ${JSON.stringify(apply.appliedAt)}`,
      });
    }
    if ('note' in apply && apply.note !== undefined && typeof apply.note !== 'string') {
      issues.push({
        path: 'applyState.note',
        message: `expected string or omitted, got ${JSON.stringify(apply.note)}`,
      });
    }
  } else if (kind === 'refused') {
    if (
      typeof apply.reason !== 'string' ||
      !(WORKSPACE_PATCH_REFUSAL_REASONS as readonly string[]).includes(apply.reason)
    ) {
      issues.push({
        path: 'applyState.reason',
        message: `expected one of ${WORKSPACE_PATCH_REFUSAL_REASONS.join(' | ')}, got ${JSON.stringify(apply.reason)}`,
      });
    }
  } else if (kind === 'conflict') {
    if (!isNonEmptyString(apply.detail)) {
      issues.push({
        path: 'applyState.detail',
        message: `expected non-empty string, got ${JSON.stringify(apply.detail)}`,
      });
    }
  }
  // 'pending' has no per-variant required fields.

  // Reject known-variant fields appearing on the wrong variant — this is
  // what makes the tagged union meaningful at runtime. A persisted card
  // with `{ kind: 'pending', appliedAt: 123 }` would let replay code
  // read a stale `appliedAt` off a pending state and misinterpret it.
  // Truly novel keys (e.g. a future `metadata` we haven't added yet)
  // are still allowed — only the known cross-variant keys are policed.
  for (const [otherKind, otherKeys] of Object.entries(APPLY_STATE_VARIANT_KEYS)) {
    if (otherKind === kind) continue;
    for (const otherKey of otherKeys) {
      if (otherKey in apply && apply[otherKey] !== undefined) {
        issues.push({
          path: `applyState.${otherKey}`,
          message: `field belongs to applyState.kind === '${otherKind}', not '${kind}'`,
        });
      }
    }
  }

  return issues;
}
