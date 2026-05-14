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
 *   - Payload validation for daemon-specific events (`session_started`,
 *     `approval_required`, `error`, `run_complete`, `run_recovered`,
 *     `recovery_skipped`, `delegation_interrupted`, etc.). Those shapes
 *     live in `cli/pushd.ts` and are not shared with web — they're
 *     still evolving and codifying them now risks friction. A follow-up
 *     PR can promote the stable ones into schemas as they settle.
 *
 *   - External schema libraries (zod, ajv, typebox). cli/ is
 *     zero-external-deps by convention. Hand-rolled validators keep
 *     that property and are simple enough for the scope here.
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

const PROMPT_SNAPSHOT_ROLES = ['orchestrator', 'explorer', 'coder', 'reviewer', 'auditor'] as const;

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

const PAYLOAD_VALIDATORS: Record<string, PayloadValidator> = {
  'assistant.prompt_snapshot': validateAssistantPromptSnapshot,
  'subagent.started': validateSubagentStarted,
  'subagent.completed': validateSubagentCompleted,
  'subagent.failed': validateSubagentFailed,
  'task_graph.task_ready': (p, b) => validateTaskGraphTaskEvent('ready', p, b),
  'task_graph.task_started': (p, b) => validateTaskGraphTaskEvent('started', p, b),
  'task_graph.task_completed': validateTaskGraphTaskCompleted,
  'task_graph.task_failed': validateTaskGraphTaskFailed,
  'task_graph.task_cancelled': validateTaskGraphTaskCancelled,
  'task_graph.graph_completed': validateTaskGraphGraphCompleted,
};

/** The set of event types that have a per-payload schema in this module. */
export const SCHEMA_VALIDATED_EVENT_TYPES = new Set(Object.keys(PAYLOAD_VALIDATORS));

/**
 * Validate a payload against the per-type schema. Returns issues if
 * the schema exists and the payload doesn't match. Returns an empty
 * array for event types we don't have schemas for (including
 * daemon-only events like `session_started` or `approval_required`) —
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
