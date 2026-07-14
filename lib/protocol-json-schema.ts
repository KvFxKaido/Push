/**
 * protocol-json-schema.ts — Publishable JSON Schema for the
 * `push.runtime.v1` event envelope.
 *
 * Why this exists: `lib/protocol-schema.ts` is the *runtime* contract —
 * hand-rolled, zero-dependency validators that the daemon broadcaster
 * and the relay enforce in strict mode. Those validators are
 * TypeScript-only, so nothing off-surface (a Go/Python client, a
 * Stainless/quicktype codegen step, an external dashboard) can consume
 * the contract without re-deriving it by hand.
 *
 * This module is the machine-readable *description* of that same
 * contract: a Draft 2020-12 JSON Schema for the `kind: 'event'`
 * envelope plus a `$def` per payload type in
 * `SCHEMA_VALIDATED_EVENT_TYPES`. It is built — not hand-authored —
 * from the canonical constants exported by `protocol-schema.ts`
 * (`PROTOCOL_VERSION`, `SUBAGENT_AGENTS`, `RUN_COMPLETE_OUTCOMES`, …)
 * so the schema's enums literally cannot drift from the validators'
 * enums. Coverage drift (a validator without a schema def, or vice
 * versa) is caught by `cli/tests/protocol-json-schema.test.mjs`, which
 * also probes that every schema-required field is a field the matching
 * validator actually requires.
 *
 * Scope: the unidirectional `kind: 'event'` broadcast envelope only.
 * The relay-control envelopes (`relay_attach`, `relay_phone_allow`, …)
 * are a separate `kind` family documented in `protocol-schema.ts`; they
 * are intentionally out of scope here so the published event schema
 * stays a clean single-kind document.
 *
 * Forward-compat: every object is left open (`additionalProperties`
 * unset → permitted), matching the validators' "permissive about extra
 * fields" rule. Adding an optional field to a payload should never
 * break a consumer pinned to this schema.
 *
 * This file is pure data + a builder; it imports no Node globals so it
 * compiles under the browser tsconfig too.
 */

import {
  COMPACTION_CAUSES,
  COMPACTION_PHASES,
  PROMPT_SNAPSHOT_ROLES,
  PROTOCOL_VERSION,
  RUN_COMPLETE_OUTCOMES,
  SUBAGENT_AGENTS,
  TASK_GRAPH_AGENTS,
  TURN_INTENTS,
  TURN_END_OUTCOMES,
  TURN_QUIESCED_OUTCOMES,
  TURN_ROUTE_REASONS,
  TURN_ROUTES,
  TURN_SUPPRESSED_ROUTES,
  WORKSPACE_DELTA_OPS,
  WORKSPACE_DIRTY_STATUSES,
} from './protocol-schema.ts';
import { EDIT_DIFF_LINE_KINDS } from './edit-diff.ts';

/** A JSON Schema node. Loose by design — this is data, not a place to
 *  re-encode the JSON Schema meta-schema in TypeScript. */
export type JsonSchemaNode = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Leaf builders — each mirrors a check in protocol-schema.ts.
// ---------------------------------------------------------------------------

/** `typeof x === 'string'`, empty allowed (e.g. streamed `text`, an
 *  empty `summary`). */
const str = (): JsonSchemaNode => ({ type: 'string' });
/** `isNonEmptyString` — required, non-empty. */
const nestr = (): JsonSchemaNode => ({ type: 'string', minLength: 1 });
/** `isFiniteNonNegativeInt`. */
const uint = (): JsonSchemaNode => ({ type: 'integer', minimum: 0 });
/** Finite number (e.g. optional `elapsedMs`/`durationMs`). */
const num = (): JsonSchemaNode => ({ type: 'number' });
const bool = (): JsonSchemaNode => ({ type: 'boolean' });
/** `expectAgentValue(..., allowed)` — non-empty string from a fixed set.
 *  Built straight from the canonical constant so the enum can't drift. */
const enumOf = (allowed: readonly string[]): JsonSchemaNode => ({
  type: 'string',
  enum: [...allowed],
});

/** Build an object node. `required` lists the always-present keys;
 *  `properties` documents both required and optional keys. Left open to
 *  extra fields to match the validators' forward-compat stance. */
function objectNode(
  required: readonly string[],
  properties: Record<string, JsonSchemaNode>,
): JsonSchemaNode {
  return { type: 'object', required: [...required], properties };
}

// ---------------------------------------------------------------------------
// Payload `$defs` — one per distinct validator. Aliased event types
// (e.g. `tool_call` and `tool.execution_start` share `validateToolCall`)
// point at the same def via TYPE_TO_DEF below.
// ---------------------------------------------------------------------------

const PAYLOAD_DEFS: Record<string, JsonSchemaNode> = {
  AssistantPromptSnapshot: objectNode(['round', 'role', 'totalChars', 'sections'], {
    round: uint(),
    role: enumOf(PROMPT_SNAPSHOT_ROLES),
    totalChars: uint(),
    sections: {
      type: 'object',
      additionalProperties: objectNode(['hash', 'size', 'volatile'], {
        hash: num(),
        size: uint(),
        volatile: bool(),
      }),
    },
  }),

  ContextCompaction: objectNode(
    ['round', 'phase', 'beforeTokens', 'afterTokens', 'messagesDropped'],
    {
      round: uint(),
      phase: enumOf(COMPACTION_PHASES),
      beforeTokens: uint(),
      afterTokens: uint(),
      messagesDropped: uint(),
      provider: str(),
      cause: enumOf(COMPACTION_CAUSES),
    },
  ),

  SessionStateChanged: objectNode(['provider', 'model'], {
    provider: nestr(),
    model: nestr(),
    roleRouting: { type: 'object' },
  }),

  SubagentStarted: objectNode(['executionId', 'agent'], {
    executionId: nestr(),
    agent: enumOf(SUBAGENT_AGENTS),
    detail: str(),
  }),

  SubagentCompleted: objectNode(['executionId', 'agent', 'summary'], {
    executionId: nestr(),
    agent: enumOf(SUBAGENT_AGENTS),
    summary: nestr(),
    orchestratorBytes: uint(),
  }),

  SubagentFailed: objectNode(['executionId', 'agent', 'error'], {
    executionId: nestr(),
    agent: enumOf(SUBAGENT_AGENTS),
    error: nestr(),
  }),

  // `task_graph.task_ready` and `task_graph.task_started` share a
  // validator (`validateTaskGraphTaskEvent`).
  TaskGraphTaskReadyOrStarted: objectNode(['executionId', 'taskId', 'agent'], {
    executionId: nestr(),
    taskId: nestr(),
    agent: enumOf(TASK_GRAPH_AGENTS),
    detail: str(),
  }),

  TaskGraphTaskCompleted: objectNode(['executionId', 'taskId', 'agent', 'summary'], {
    executionId: nestr(),
    taskId: nestr(),
    agent: enumOf(TASK_GRAPH_AGENTS),
    summary: str(),
    elapsedMs: num(),
  }),

  TaskGraphTaskFailed: objectNode(['executionId', 'taskId', 'agent', 'error'], {
    executionId: nestr(),
    taskId: nestr(),
    agent: enumOf(TASK_GRAPH_AGENTS),
    error: nestr(),
    elapsedMs: num(),
  }),

  TaskGraphTaskCancelled: objectNode(['executionId', 'taskId', 'agent', 'reason'], {
    executionId: nestr(),
    taskId: nestr(),
    agent: enumOf(TASK_GRAPH_AGENTS),
    reason: nestr(),
    elapsedMs: num(),
  }),

  TaskGraphGraphCompleted: objectNode(
    ['executionId', 'summary', 'success', 'aborted', 'nodeCount', 'totalRounds', 'wallTimeMs'],
    {
      executionId: nestr(),
      summary: str(),
      success: bool(),
      aborted: bool(),
      nodeCount: uint(),
      totalRounds: uint(),
      wallTimeMs: uint(),
    },
  ),

  // `assistant_token` + `assistant_thinking_token`. `text` may be empty
  // (provider streams emit zero-length deltas at the content/reasoning
  // boundary) but must be present and a string.
  AssistantTextChunk: objectNode(['text'], {
    text: str(),
  }),

  // `assistant_citations` — web-search sources (OpenRouter). Each entry's
  // `url` is required non-empty; `title`/`content` are required strings (may
  // be empty); the `startIndex`/`endIndex` offsets are optional.
  AssistantCitations: objectNode(['citations'], {
    citations: {
      type: 'array',
      items: objectNode(['url', 'title', 'content'], {
        url: nestr(),
        title: str(),
        content: str(),
        startIndex: uint(),
        endIndex: uint(),
      }),
    },
  }),

  // `tool_call` + `tool.execution_start`. `args` is any JSON object;
  // per-tool arg schemas live in lib/tool-registry.ts, not here.
  ToolCall: objectNode(['toolName', 'args'], {
    toolName: nestr(),
    args: { type: 'object' },
  }),

  // `tool_result` + `tool.execution_complete`. `diff` is the optional
  // structured edit diff for file-mutation tools; `card` is the
  // forward-compatible render payload. Their strict runtime validation lives
  // in lib/protocol-schema.ts.
  ToolResult: objectNode(['toolName', 'isError'], {
    toolName: nestr(),
    isError: bool(),
    text: str(),
    preview: str(),
    target: str(),
    durationMs: num(),
    branch: str(),
    card: objectNode(['type', 'data'], {
      type: nestr(),
      data: { type: 'object' },
    }),
    diff: objectNode(['path', 'adds', 'dels', 'lines'], {
      path: nestr(),
      adds: num(),
      dels: num(),
      lines: {
        type: 'array',
        items: objectNode(['kind', 'text'], {
          kind: enumOf(EDIT_DIFF_LINE_KINDS),
          text: str(),
          oldLine: num(),
          newLine: num(),
          textTruncated: bool(),
        }),
      },
      truncated: bool(),
    }),
  }),

  BranchDesync: objectNode(['expected', 'actual', 'command'], {
    expected: nestr(),
    actual: nestr(),
    command: nestr(),
  }),

  ToolCallMalformed: objectNode(['reason'], {
    reason: nestr(),
  }),

  ErrorEvent: objectNode(['message'], {
    message: nestr(),
    code: nestr(),
    retryable: bool(),
  }),

  // `warning` requires at least one of message/code (each, when
  // present, non-empty). Modeled with anyOf because neither field is
  // unconditionally required.
  WarningEvent: {
    type: 'object',
    properties: {
      message: nestr(),
      code: nestr(),
    },
    anyOf: [{ required: ['message'] }, { required: ['code'] }],
  },

  // `status` requires at least one of detail/phase.
  StatusEvent: {
    type: 'object',
    properties: {
      detail: nestr(),
      phase: nestr(),
    },
    anyOf: [{ required: ['detail'] }, { required: ['phase'] }],
  },

  ApprovalRequired: objectNode(['approvalId', 'kind', 'title', 'summary', 'options'], {
    approvalId: nestr(),
    kind: nestr(),
    title: nestr(),
    summary: str(),
    options: { type: 'array', minItems: 1, items: nestr() },
  }),

  ApprovalReceived: objectNode(['approvalId', 'decision'], {
    approvalId: nestr(),
    decision: { type: 'string', enum: ['approve', 'deny'] },
    by: nestr(),
  }),

  RunComplete: objectNode(['outcome'], {
    outcome: enumOf(RUN_COMPLETE_OUTCOMES),
    summary: str(),
    runId: str(),
  }),

  SessionStarted: objectNode(['sessionId', 'state'], {
    sessionId: nestr(),
    state: { type: 'string', enum: ['idle', 'running'] },
    mode: str(),
    provider: str(),
    sandboxProvider: str(),
  }),

  UserMessage: objectNode(['chars', 'preview'], {
    chars: uint(),
    preview: str(),
  }),

  // Session-mutation broadcasts + recovery/interruption events (daemon-owned;
  // see protocol-schema.ts). All fields required at their single emission site.
  ContextCompacted: objectNode(
    [
      'preserveTurns',
      'totalTurns',
      'compactedMessages',
      'removedCount',
      'beforeTokens',
      'afterTokens',
    ],
    {
      preserveTurns: uint(),
      totalTurns: uint(),
      compactedMessages: uint(),
      removedCount: uint(),
      beforeTokens: uint(),
      afterTokens: uint(),
    },
  ),

  SessionReverted: objectNode(
    ['turns', 'removedCount', 'totalTurns', 'remainingTurns', 'remainingMessages'],
    {
      turns: uint(),
      removedCount: uint(),
      totalTurns: uint(),
      remainingTurns: uint(),
      remainingMessages: uint(),
    },
  ),

  SessionUnreverted: objectNode(['restoredCount', 'totalMessages'], {
    restoredCount: uint(),
    totalMessages: uint(),
  }),

  // `markerAge` is a duration (Date.now() - startedAt) — finite number, NOT
  // constrained non-negative, since clock skew can make it go negative.
  RunRecovered: objectNode(['originalRunId', 'recoveryRunId', 'policy', 'markerAge'], {
    originalRunId: nestr(),
    recoveryRunId: nestr(),
    policy: nestr(),
    markerAge: num(),
  }),

  RecoverySkipped: objectNode(['originalRunId', 'reason', 'policy', 'markerAge'], {
    originalRunId: nestr(),
    reason: nestr(),
    policy: nestr(),
    markerAge: num(),
  }),

  // subagents/graphs are arrays of objects (from collectOrphanedDelegations in
  // cli/pushd.ts), NOT strings: { subagentId, agent } and { executionId }.
  DelegationInterrupted: objectNode(['originalRunId', 'recoveryRunId', 'subagents', 'graphs'], {
    originalRunId: nestr(),
    recoveryRunId: nestr(),
    subagents: {
      type: 'array',
      items: objectNode(['subagentId', 'agent'], { subagentId: nestr(), agent: nestr() }),
    },
    graphs: {
      type: 'array',
      items: objectNode(['executionId'], { executionId: nestr() }),
    },
  }),

  // RunEventInput passthrough events (shapes from lib/runtime-contract.ts,
  // minus the discriminant `type`). `role` is AgentRole == PROMPT_SNAPSHOT_ROLES.
  TurnRoute: objectNode(['route', 'reason', 'intent', 'repoBranchReady'], {
    route: enumOf(TURN_ROUTES),
    reason: enumOf(TURN_ROUTE_REASONS),
    suppressedRoute: enumOf(TURN_SUPPRESSED_ROUTES),
    intent: enumOf(TURN_INTENTS),
    repoBranchReady: bool(),
  }),

  AssistantTurnStart: objectNode(['round'], { round: uint() }),

  AssistantTurnEnd: objectNode(['round', 'outcome'], {
    round: uint(),
    outcome: enumOf(TURN_END_OUTCOMES),
  }),

  TurnQuiesced: objectNode(['runId', 'outcome'], {
    runId: nestr(),
    outcome: enumOf(TURN_QUIESCED_OUTCOMES),
  }),

  HarnessAdaptation: objectNode(['round', 'fromMaxRounds', 'toMaxRounds', 'reasons'], {
    round: uint(),
    fromMaxRounds: uint(),
    toMaxRounds: uint(),
    reasons: {
      type: 'array',
      minItems: 1,
      items: nestr(),
    },
  }),

  JobStarted: objectNode(['executionId', 'role'], {
    executionId: nestr(),
    role: enumOf(PROMPT_SNAPSHOT_ROLES),
    detail: str(),
  }),

  // delegationOutcome is optional and its shape is owned elsewhere — omitted
  // here so the schema stays as permissive as the validator (which leaves it
  // unchecked), matching the SubagentCompleted twin. Constraining it would let
  // the published schema reject a payload the runtime accepts.
  JobCompleted: objectNode(['executionId', 'role', 'summary'], {
    executionId: nestr(),
    role: enumOf(PROMPT_SNAPSHOT_ROLES),
    summary: nestr(),
  }),

  JobFailed: objectNode(['executionId', 'role', 'error'], {
    executionId: nestr(),
    role: enumOf(PROMPT_SNAPSHOT_ROLES),
    error: nestr(),
  }),

  UserFollowUpQueued: objectNode(['round', 'position', 'preview'], {
    round: uint(),
    position: uint(),
    preview: str(),
  }),

  UserFollowUpSteered: objectNode(['round', 'preview', 'replacedPending'], {
    round: uint(),
    preview: str(),
    replacedPending: bool(),
  }),

  // Live workspace state. `state` mirrors `WorkspaceState` (validateWorkspaceState);
  // `ahead`/`behind` are optional tracking counts.
  WorkspaceStateSnapshot: objectNode(['workspaceId', 'rev', 'state'], {
    workspaceId: nestr(),
    rev: uint(),
    state: objectNode(['activeBranch', 'headSha', 'dirtyFiles', 'protectMain', 'sandboxReady'], {
      activeBranch: nestr(),
      headSha: nestr(),
      ahead: uint(),
      behind: uint(),
      dirtyFiles: {
        type: 'array',
        items: objectNode(['path', 'status'], {
          path: nestr(),
          status: enumOf(WORKSPACE_DIRTY_STATUSES),
        }),
      },
      protectMain: bool(),
      sandboxReady: bool(),
    }),
  }),

  // The delta's `ops` is a closed op-set. This is a coarse description — each op
  // carries `op` plus op-specific fields validated at runtime by
  // validateWorkspaceStateDeltaOp. The `op` enum leads with the field-free
  // `dirty_clear` so the required-field agreement test's minimal sample
  // (`{ op: <first> }`) is a valid op without op-specific fields; membership,
  // not order, is the contract (the runtime constant stays in logical order).
  WorkspaceStateDelta: objectNode(['workspaceId', 'rev', 'baseRev', 'ops'], {
    workspaceId: nestr(),
    rev: uint(),
    baseRev: uint(),
    ops: {
      type: 'array',
      items: objectNode(['op'], {
        op: enumOf(['dirty_clear', ...WORKSPACE_DELTA_OPS.filter((o) => o !== 'dirty_clear')]),
        activeBranch: nestr(),
        headSha: nestr(),
        ahead: uint(),
        behind: uint(),
        file: objectNode(['path', 'status'], {
          path: nestr(),
          status: enumOf(WORKSPACE_DIRTY_STATUSES),
        }),
        path: nestr(),
        protectMain: bool(),
        sandboxReady: bool(),
      }),
    },
  }),
};

/**
 * Maps each schema-validated event type → its `$def` name. The key set
 * here is the published surface; the drift test pins it to equal
 * `SCHEMA_VALIDATED_EVENT_TYPES` from `protocol-schema.ts`, so a new
 * validator without a schema entry (or an entry for a removed
 * validator) fails CI.
 */
export const TYPE_TO_DEF: Record<string, string> = {
  'assistant.prompt_snapshot': 'AssistantPromptSnapshot',
  'context.compaction': 'ContextCompaction',
  session_state_changed: 'SessionStateChanged',
  'subagent.started': 'SubagentStarted',
  'subagent.completed': 'SubagentCompleted',
  'subagent.failed': 'SubagentFailed',
  'task_graph.task_ready': 'TaskGraphTaskReadyOrStarted',
  'task_graph.task_started': 'TaskGraphTaskReadyOrStarted',
  'task_graph.task_completed': 'TaskGraphTaskCompleted',
  'task_graph.task_failed': 'TaskGraphTaskFailed',
  'task_graph.task_cancelled': 'TaskGraphTaskCancelled',
  'task_graph.graph_completed': 'TaskGraphGraphCompleted',
  assistant_token: 'AssistantTextChunk',
  assistant_thinking_token: 'AssistantTextChunk',
  assistant_citations: 'AssistantCitations',
  tool_call: 'ToolCall',
  'tool.execution_start': 'ToolCall',
  tool_result: 'ToolResult',
  'tool.execution_complete': 'ToolResult',
  branch_desync: 'BranchDesync',
  'tool.call_malformed': 'ToolCallMalformed',
  error: 'ErrorEvent',
  warning: 'WarningEvent',
  status: 'StatusEvent',
  approval_required: 'ApprovalRequired',
  approval_received: 'ApprovalReceived',
  run_complete: 'RunComplete',
  session_started: 'SessionStarted',
  user_message: 'UserMessage',
  context_compacted: 'ContextCompacted',
  session_reverted: 'SessionReverted',
  session_unreverted: 'SessionUnreverted',
  run_recovered: 'RunRecovered',
  recovery_skipped: 'RecoverySkipped',
  delegation_interrupted: 'DelegationInterrupted',
  'turn.route': 'TurnRoute',
  'assistant.turn_start': 'AssistantTurnStart',
  'assistant.turn_end': 'AssistantTurnEnd',
  'turn.quiesced': 'TurnQuiesced',
  'harness.adaptation': 'HarnessAdaptation',
  'job.started': 'JobStarted',
  'job.completed': 'JobCompleted',
  'job.failed': 'JobFailed',
  'user.follow_up_queued': 'UserFollowUpQueued',
  'user.follow_up_steered': 'UserFollowUpSteered',
  'workspace.state_snapshot': 'WorkspaceStateSnapshot',
  'workspace.state_delta': 'WorkspaceStateDelta',
};

// ---------------------------------------------------------------------------
// Envelope + discriminator assembly.
// ---------------------------------------------------------------------------

/**
 * Build the `allOf` discriminator: for each event `type`, when
 * `payload`'s sibling `type` equals that literal, the `payload` must
 * match the corresponding `$def`. Types not listed fall through with
 * only the base `payload: object` constraint (the validators treat
 * unknown types as envelope-only too).
 */
function buildDiscriminator(): JsonSchemaNode[] {
  return Object.entries(TYPE_TO_DEF).map(([type, def]) => ({
    if: { properties: { type: { const: type } }, required: ['type'] },
    then: { properties: { payload: { $ref: `#/$defs/${def}` } } },
  }));
}

/**
 * The canonical `push.runtime.v1` event-envelope schema. Mirrors
 * `validateEventEnvelope` in `protocol-schema.ts`: `v`/`kind` are
 * pinned constants, `runId` is optional-but-non-empty, `ts` is a
 * positive number (ms since epoch), everything else required.
 */
export const PUSH_RUNTIME_EVENT_SCHEMA: JsonSchemaNode = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://push.dev/schema/${PROTOCOL_VERSION}.event.schema.json`,
  title: `Push runtime event envelope (${PROTOCOL_VERSION})`,
  description:
    'Unidirectional broadcast envelope emitted by the pushd daemon and the ' +
    'Worker relay. Generated from lib/protocol-schema.ts validators; do not ' +
    'hand-edit. Relay-control envelopes (other `kind` values) are out of scope.',
  type: 'object',
  required: ['v', 'kind', 'sessionId', 'seq', 'ts', 'type', 'payload'],
  properties: {
    v: { const: PROTOCOL_VERSION },
    kind: { const: 'event' },
    sessionId: nestr(),
    // Optional, but when present must be a non-empty string — serializing
    // `runId: null` is an active regression the validator rejects.
    runId: nestr(),
    seq: uint(),
    ts: { type: 'number', exclusiveMinimum: 0 },
    type: nestr(),
    payload: { type: 'object' },
  },
  $defs: PAYLOAD_DEFS,
  allOf: buildDiscriminator(),
};
