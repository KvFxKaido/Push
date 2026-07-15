/**
 * Pure evaluation over saved `push.runtime.v1` run receipts.
 *
 * This module owns no file or CLI I/O. Callers supply already-parsed event
 * envelopes plus a versioned policy; the reducer returns deterministic gate
 * evidence, descriptive metrics, optional score-threshold misses, and one
 * verdict. The existing agent eval harness is the first consumer.
 */

import { PROTOCOL_VERSION, validateEvent } from './protocol-schema.js';

export const RUNTIME_EVAL_POLICY_VERSION = 1 as const;
export const RUNTIME_EVAL_RESULT_VERSION = 1 as const;

export type RuntimeEvalVerdict = 'pass' | 'score_miss' | 'fail';
export type RuntimeEvalGateStatus = 'pass' | 'fail';
export type RuntimeEvalScoreStatus = 'pass' | 'miss';

export interface RuntimeEvalEvent {
  v: string;
  kind: 'event';
  sessionId: string;
  runId?: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface RuntimeEvalRunSelector {
  /** Evaluate only envelopes for this run from a larger session journal. */
  runId?: string;
  /** Optional second guard when journals from several sessions are combined. */
  sessionId?: string;
}

export interface RuntimeEvalGates {
  terminalSuccess: boolean;
  noMalformedToolCalls: boolean;
  noToolErrors: boolean;
  noErrors: boolean;
  noBranchDesync: boolean;
  approvalsResolved: boolean;
  approvalsApproved: boolean;
  subagentsSettled: boolean;
  jobsSettled: boolean;
  acceptancePassed: boolean;
  requiredTools: string[];
  forbiddenTools: string[];
}

export interface RuntimeEvalScoreThresholds {
  maxRounds?: number;
  maxDurationMs?: number;
  maxToolCalls?: number;
  maxRetries?: number;
  maxCompactions?: number;
}

export interface RuntimeEvalPolicyV1 {
  version: typeof RUNTIME_EVAL_POLICY_VERSION;
  /** Omitted fields inherit the deterministic default floor below. */
  gates?: Partial<RuntimeEvalGates>;
  /** Thresholds are optional observations; misses never turn into gate failures. */
  scores?: RuntimeEvalScoreThresholds;
}

export interface RuntimeEvalEvidence {
  eventIndex: number;
  type?: string;
  seq?: number;
  id?: string;
  message: string;
}

export interface RuntimeEvalGateResult {
  id: string;
  status: RuntimeEvalGateStatus;
  message: string;
  evidence: RuntimeEvalEvidence[];
}

export interface RuntimeEvalScoreResult {
  id: keyof RuntimeEvalScoreThresholds;
  status: RuntimeEvalScoreStatus;
  actual: number;
  threshold: number;
}

export interface RuntimeEvalMetrics {
  eventCount: number;
  durationMs: number | null;
  rounds: number;
  toolCalls: number;
  toolErrors: number;
  malformedToolCalls: number;
  harnessAdaptations: number;
  errorEvents: number;
  branchDesyncs: number;
  retries: number;
  compactions: number;
  approvalRequests: number;
  approvalDenials: number;
  unresolvedApprovals: number;
  subagentsStarted: number;
  subagentFailures: number;
  danglingSubagents: number;
  jobsStarted: number;
  jobFailures: number;
  suspendedJobs: number;
  danglingJobs: number;
  acceptancePassed: boolean | null;
  tools: Record<string, number>;
}

export interface RuntimeEvalResultV1 {
  version: typeof RUNTIME_EVAL_RESULT_VERSION;
  policyVersion: typeof RUNTIME_EVAL_POLICY_VERSION;
  verdict: RuntimeEvalVerdict;
  sessionId: string | null;
  runId: string | null;
  metrics: RuntimeEvalMetrics;
  gates: RuntimeEvalGateResult[];
  scores: RuntimeEvalScoreResult[];
}

export const DEFAULT_RUNTIME_EVAL_GATES: RuntimeEvalGates = {
  terminalSuccess: true,
  noMalformedToolCalls: true,
  noToolErrors: true,
  noErrors: true,
  noBranchDesync: true,
  approvalsResolved: true,
  // A denial is a resolved decision. Consumers that require every approval to
  // be affirmative opt into this separately.
  approvalsApproved: false,
  subagentsSettled: true,
  jobsSettled: true,
  // Not every run requests acceptance checks. A policy must require positive
  // evidence explicitly instead of treating absence as success.
  acceptancePassed: false,
  requiredTools: [],
  forbiddenTools: [],
};

export const DEFAULT_RUNTIME_EVAL_POLICY: RuntimeEvalPolicyV1 = {
  version: RUNTIME_EVAL_POLICY_VERSION,
};

interface IndexedEvent {
  event: RuntimeEvalEvent;
  index: number;
}

interface LifecycleState {
  state: 'active' | 'suspended' | 'completed' | 'failed';
  index: number;
}

interface ScanResult {
  events: IndexedEvent[];
  invalidEvidence: RuntimeEvalEvidence[];
  identityEvidence: RuntimeEvalEvidence[];
  terminalEvents: IndexedEvent[];
  terminalEvidence: RuntimeEvalEvidence[];
  metrics: RuntimeEvalMetrics;
  malformedEvidence: RuntimeEvalEvidence[];
  toolErrorEvidence: RuntimeEvalEvidence[];
  errorEvidence: RuntimeEvalEvidence[];
  branchDesyncEvidence: RuntimeEvalEvidence[];
  unresolvedApprovalEvidence: RuntimeEvalEvidence[];
  deniedApprovalEvidence: RuntimeEvalEvidence[];
  subagentEvidence: RuntimeEvalEvidence[];
  jobEvidence: RuntimeEvalEvidence[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload[key] === 'string' ? payload[key] : null;
}

function booleanField(payload: unknown, key: string): boolean | null {
  if (!isRecord(payload)) return null;
  return typeof payload[key] === 'boolean' ? payload[key] : null;
}

function numberField(payload: unknown, key: string): number | null {
  if (!isRecord(payload)) return null;
  return typeof payload[key] === 'number' && Number.isFinite(payload[key]) ? payload[key] : null;
}

function acceptanceEventPassed(payload: unknown): boolean | null {
  const declared = booleanField(payload, 'passed');
  if (declared === null || !isRecord(payload) || !Array.isArray(payload.checks)) return null;
  return (
    declared &&
    payload.checks.every((check) => isRecord(check) && booleanField(check, 'ok') === true)
  );
}

function evidence(indexed: IndexedEvent, message: string, id?: string | null): RuntimeEvalEvidence {
  return {
    eventIndex: indexed.index,
    type: indexed.event.type,
    seq: indexed.event.seq,
    ...(id ? { id } : {}),
    message,
  };
}

function emptyMetrics(): RuntimeEvalMetrics {
  return {
    eventCount: 0,
    durationMs: null,
    rounds: 0,
    toolCalls: 0,
    toolErrors: 0,
    malformedToolCalls: 0,
    harnessAdaptations: 0,
    errorEvents: 0,
    branchDesyncs: 0,
    retries: 0,
    compactions: 0,
    approvalRequests: 0,
    approvalDenials: 0,
    unresolvedApprovals: 0,
    subagentsStarted: 0,
    subagentFailures: 0,
    danglingSubagents: 0,
    jobsStarted: 0,
    jobFailures: 0,
    suspendedJobs: 0,
    danglingJobs: 0,
    acceptancePassed: null,
    tools: {},
  };
}

function selectEvents(
  input: readonly unknown[],
  selector: RuntimeEvalRunSelector,
): { events: IndexedEvent[]; invalidEvidence: RuntimeEvalEvidence[] } {
  const events: IndexedEvent[] = [];
  const invalidEvidence: RuntimeEvalEvidence[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const candidate = input[index];
    if (!isRecord(candidate)) {
      invalidEvidence.push({ eventIndex: index, message: 'event is not an object' });
      continue;
    }

    const candidateRunId = typeof candidate.runId === 'string' ? candidate.runId : undefined;
    const candidateSessionId =
      typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined;
    if (selector.runId && candidateRunId !== selector.runId) continue;
    if (selector.sessionId && candidateSessionId !== selector.sessionId) continue;

    const issues = validateEvent(candidate);
    if (issues.length > 0) {
      invalidEvidence.push({
        eventIndex: index,
        type: typeof candidate.type === 'string' ? candidate.type : undefined,
        seq: typeof candidate.seq === 'number' ? candidate.seq : undefined,
        message: issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      });
      continue;
    }
    events.push({ event: candidate as unknown as RuntimeEvalEvent, index });
  }

  return { events, invalidEvidence };
}

function transitionLifecycle(
  states: Map<string, LifecycleState>,
  indexed: IndexedEvent,
  id: string | null,
  next: LifecycleState['state'],
  evidenceOut: RuntimeEvalEvidence[],
  label: string,
): void {
  if (!id) return;
  const previous = states.get(id);

  if (next === 'active' && indexed.event.type.endsWith('.started')) {
    if (previous) {
      evidenceOut.push(evidence(indexed, `${label} ${id} started more than once`, id));
      return;
    }
    states.set(id, { state: next, index: indexed.index });
    return;
  }

  if (!previous) {
    evidenceOut.push(
      evidence(indexed, `${label} ${id} emitted ${indexed.event.type} before it started`, id),
    );
    return;
  }
  if (previous.state === 'completed' || previous.state === 'failed') {
    evidenceOut.push(
      evidence(indexed, `${label} ${id} emitted ${indexed.event.type} after it settled`, id),
    );
    return;
  }

  if (indexed.event.type === 'job.resumed' && previous.state !== 'suspended') {
    evidenceOut.push(evidence(indexed, `job ${id} resumed while ${previous.state}`, id));
    return;
  }
  if (indexed.event.type === 'job.suspended' && previous.state === 'suspended') {
    evidenceOut.push(evidence(indexed, `job ${id} suspended more than once without a resume`, id));
    return;
  }

  states.set(id, { state: next, index: indexed.index });
}

function scanRuntimeEvents(
  input: readonly unknown[],
  selector: RuntimeEvalRunSelector,
): ScanResult {
  const { events, invalidEvidence } = selectEvents(input, selector);
  const metrics = emptyMetrics();
  metrics.eventCount = events.length;

  const identityEvidence: RuntimeEvalEvidence[] = [];
  const terminalEvents: IndexedEvent[] = [];
  const terminalEvidence: RuntimeEvalEvidence[] = [];
  const malformedEvidence: RuntimeEvalEvidence[] = [];
  const toolErrorEvidence: RuntimeEvalEvidence[] = [];
  const errorEvidence: RuntimeEvalEvidence[] = [];
  const branchDesyncEvidence: RuntimeEvalEvidence[] = [];
  const unresolvedApprovalEvidence: RuntimeEvalEvidence[] = [];
  const deniedApprovalEvidence: RuntimeEvalEvidence[] = [];
  const subagentEvidence: RuntimeEvalEvidence[] = [];
  const jobEvidence: RuntimeEvalEvidence[] = [];
  const sessionIds = new Set<string>();
  const runIds = new Set<string>();
  const rounds = new Set<number>();
  const approvals = new Map<string, { resolved: boolean; denied: boolean; index: number }>();
  const subagents = new Map<string, LifecycleState>();
  const jobs = new Map<string, LifecycleState>();
  const acceptanceResults: boolean[] = [];
  const taskGraphRounds: number[] = [];
  const executionToolEvents = events.some(({ event }) => event.type === 'tool.execution_complete');
  const executionToolStarts = events.some(({ event }) => event.type === 'tool.execution_start');
  const timestamps: number[] = [];

  for (const indexed of events) {
    const { event } = indexed;
    sessionIds.add(event.sessionId);
    if (event.runId) {
      runIds.add(event.runId);
    } else {
      identityEvidence.push(evidence(indexed, 'run receipt event is missing runId'));
    }
    timestamps.push(event.ts);

    if (event.v !== PROTOCOL_VERSION) {
      identityEvidence.push(
        evidence(indexed, `expected protocol ${PROTOCOL_VERSION}, got ${event.v}`),
      );
    }
    if (event.kind !== 'event') {
      identityEvidence.push(evidence(indexed, `expected event envelope, got ${event.kind}`));
    }

    if (event.type === 'assistant.turn_start' || event.type === 'assistant.turn_end') {
      const round = numberField(event.payload, 'round');
      if (round !== null) rounds.add(round);
    }

    const isCanonicalToolCompletion = event.type === 'tool.execution_complete';
    const isLegacyToolCompletion = event.type === 'tool_result' && !executionToolEvents;
    if (isCanonicalToolCompletion || isLegacyToolCompletion) {
      metrics.toolCalls += 1;
      const toolName = stringField(event.payload, 'toolName');
      if (toolName) metrics.tools[toolName] = (metrics.tools[toolName] ?? 0) + 1;
      if (booleanField(event.payload, 'isError') === true) {
        metrics.toolErrors += 1;
        toolErrorEvidence.push(evidence(indexed, `${toolName ?? 'tool'} returned an error`));
      }
    }

    const isCanonicalToolStart = event.type === 'tool.execution_start';
    const isLegacyToolStart = event.type === 'tool_call' && !executionToolStarts;
    if (isCanonicalToolStart || isLegacyToolStart) {
      // A start-only/incomplete receipt still records observed tool behavior.
      const toolName = stringField(event.payload, 'toolName');
      if (toolName && !(toolName in metrics.tools)) metrics.tools[toolName] = 0;
    }

    switch (event.type) {
      case 'run_complete':
        terminalEvents.push(indexed);
        break;
      case 'tool.call_malformed':
        metrics.malformedToolCalls += 1;
        malformedEvidence.push(evidence(indexed, 'malformed tool call'));
        break;
      case 'harness.adaptation':
        metrics.harnessAdaptations += 1;
        break;
      case 'error':
        metrics.errorEvents += 1;
        errorEvidence.push(
          evidence(indexed, stringField(event.payload, 'message') ?? 'runtime error event'),
        );
        break;
      case 'branch_desync':
        metrics.branchDesyncs += 1;
        branchDesyncEvidence.push(evidence(indexed, 'active branch diverged from sandbox HEAD'));
        break;
      case 'warning':
        if (stringField(event.payload, 'code') === 'PROVIDER_RETRY') metrics.retries += 1;
        break;
      case 'context.compaction':
        metrics.compactions += 1;
        break;
      case 'task_graph.graph_completed': {
        const totalRounds = numberField(event.payload, 'totalRounds');
        if (totalRounds !== null) taskGraphRounds.push(totalRounds);
        break;
      }
      case 'approval_required': {
        metrics.approvalRequests += 1;
        const id = stringField(event.payload, 'approvalId');
        if (id) {
          if (approvals.has(id)) {
            unresolvedApprovalEvidence.push(
              evidence(indexed, `approval ${id} was requested more than once`, id),
            );
          } else {
            approvals.set(id, { resolved: false, denied: false, index: indexed.index });
          }
        }
        break;
      }
      case 'approval_received': {
        const id = stringField(event.payload, 'approvalId');
        if (id) {
          const previous = approvals.get(id);
          if (!previous) {
            unresolvedApprovalEvidence.push(
              evidence(indexed, `approval ${id} was received without a request`, id),
            );
          } else if (previous.resolved) {
            unresolvedApprovalEvidence.push(
              evidence(indexed, `approval ${id} was resolved more than once`, id),
            );
          } else {
            const denied = stringField(event.payload, 'decision') === 'deny';
            approvals.set(id, { resolved: true, denied, index: indexed.index });
            if (denied)
              deniedApprovalEvidence.push(evidence(indexed, `approval ${id} was denied`, id));
          }
        }
        break;
      }
      case 'subagent.started':
        metrics.subagentsStarted += 1;
        transitionLifecycle(
          subagents,
          indexed,
          stringField(event.payload, 'executionId'),
          'active',
          subagentEvidence,
          'subagent',
        );
        break;
      case 'subagent.completed':
        transitionLifecycle(
          subagents,
          indexed,
          stringField(event.payload, 'executionId'),
          'completed',
          subagentEvidence,
          'subagent',
        );
        break;
      case 'subagent.failed':
        metrics.subagentFailures += 1;
        transitionLifecycle(
          subagents,
          indexed,
          stringField(event.payload, 'executionId'),
          'failed',
          subagentEvidence,
          'subagent',
        );
        break;
      case 'job.started':
        metrics.jobsStarted += 1;
        transitionLifecycle(
          jobs,
          indexed,
          stringField(event.payload, 'executionId'),
          'active',
          jobEvidence,
          'job',
        );
        break;
      case 'job.suspended':
        transitionLifecycle(
          jobs,
          indexed,
          stringField(event.payload, 'executionId'),
          'suspended',
          jobEvidence,
          'job',
        );
        break;
      case 'job.resumed':
        transitionLifecycle(
          jobs,
          indexed,
          stringField(event.payload, 'executionId'),
          'active',
          jobEvidence,
          'job',
        );
        break;
      case 'job.completed':
        transitionLifecycle(
          jobs,
          indexed,
          stringField(event.payload, 'executionId'),
          'completed',
          jobEvidence,
          'job',
        );
        break;
      case 'job.failed':
        metrics.jobFailures += 1;
        transitionLifecycle(
          jobs,
          indexed,
          stringField(event.payload, 'executionId'),
          'failed',
          jobEvidence,
          'job',
        );
        break;
      case 'acceptance_complete': {
        const passed = acceptanceEventPassed(event.payload);
        if (passed !== null) acceptanceResults.push(passed);
        break;
      }
    }
  }

  if (sessionIds.size > 1) {
    identityEvidence.push({ eventIndex: -1, message: 'receipt contains more than one sessionId' });
  }
  if (runIds.size > 1) {
    identityEvidence.push({ eventIndex: -1, message: 'receipt contains more than one runId' });
  }
  if (events.length === 0) {
    identityEvidence.push({ eventIndex: -1, message: 'receipt contains no events' });
  }

  if (terminalEvents.length !== 1) {
    terminalEvidence.push({
      eventIndex: -1,
      message: `expected exactly one run_complete, found ${terminalEvents.length}`,
    });
  } else {
    const terminal = terminalEvents[0];
    const outcome = stringField(terminal.event.payload, 'outcome');
    const payloadRunId = stringField(terminal.event.payload, 'runId');
    if (outcome !== 'success' && outcome !== 'completed') {
      terminalEvidence.push(
        evidence(terminal, `terminal outcome was ${outcome ?? 'missing'}, not success`, outcome),
      );
    }
    if (events.at(-1) !== terminal) {
      terminalEvidence.push(evidence(terminal, 'run_complete was not the final event'));
    }
    if (payloadRunId && payloadRunId !== terminal.event.runId) {
      terminalEvidence.push(
        evidence(
          terminal,
          `run_complete payload runId ${payloadRunId} did not match envelope ${terminal.event.runId}`,
          payloadRunId,
        ),
      );
    }
  }

  for (const [id, approval] of approvals) {
    if (!approval.resolved) {
      metrics.unresolvedApprovals += 1;
      unresolvedApprovalEvidence.push({
        eventIndex: approval.index,
        type: 'approval_required',
        id,
        message: `approval ${id} was never resolved`,
      });
    }
    if (approval.denied) metrics.approvalDenials += 1;
  }

  for (const [id, state] of subagents) {
    if (state.state === 'active' || state.state === 'suspended') {
      metrics.danglingSubagents += 1;
      subagentEvidence.push({
        eventIndex: state.index,
        type: 'subagent.started',
        id,
        message: `subagent ${id} was left ${state.state}`,
      });
    }
  }

  for (const [id, state] of jobs) {
    if (state.state === 'suspended') metrics.suspendedJobs += 1;
    if (state.state === 'active' || state.state === 'suspended') {
      metrics.danglingJobs += 1;
      jobEvidence.push({
        eventIndex: state.index,
        type: state.state === 'suspended' ? 'job.suspended' : 'job.started',
        id,
        message: `job ${id} was left ${state.state}`,
      });
    }
  }

  // Delegated runs suppress their per-node assistant events and publish the
  // aggregate on graph completion. Match the existing harness's
  // `totalRounds ?? rounds` precedence instead of reporting zero.
  metrics.rounds = taskGraphRounds.length > 0 ? Math.max(...taskGraphRounds) : rounds.size;
  metrics.acceptancePassed =
    acceptanceResults.length === 0 ? null : acceptanceResults.every((passed) => passed);
  metrics.durationMs =
    timestamps.length < 2 ? null : Math.max(...timestamps) - Math.min(...timestamps);

  return {
    events,
    invalidEvidence,
    identityEvidence,
    terminalEvents,
    terminalEvidence,
    metrics,
    malformedEvidence,
    toolErrorEvidence,
    errorEvidence,
    branchDesyncEvidence,
    unresolvedApprovalEvidence,
    deniedApprovalEvidence,
    subagentEvidence,
    jobEvidence,
  };
}

function gate(
  id: string,
  failureEvidence: RuntimeEvalEvidence[],
  passMessage: string,
  failMessage: string,
): RuntimeEvalGateResult {
  const failed = failureEvidence.length > 0;
  return {
    id,
    status: failed ? 'fail' : 'pass',
    message: failed ? failMessage : passMessage,
    evidence: failureEvidence,
  };
}

function scoreResults(
  metrics: RuntimeEvalMetrics,
  thresholds: RuntimeEvalScoreThresholds = {},
): RuntimeEvalScoreResult[] {
  const values: Record<keyof RuntimeEvalScoreThresholds, number | null> = {
    maxRounds: metrics.rounds,
    maxDurationMs: metrics.durationMs,
    maxToolCalls: metrics.toolCalls,
    maxRetries: metrics.retries,
    maxCompactions: metrics.compactions,
  };
  const scores: RuntimeEvalScoreResult[] = [];
  for (const [id, threshold] of Object.entries(thresholds) as Array<
    [keyof RuntimeEvalScoreThresholds, number]
  >) {
    const actual = values[id];
    if (actual === null || !Number.isFinite(threshold)) continue;
    scores.push({
      id,
      status: actual <= threshold ? 'pass' : 'miss',
      actual,
      threshold,
    });
  }
  return scores;
}

/** Reduce a run receipt into deterministic gates, metrics, and one verdict. */
export function evaluateRuntimeEvents(
  events: readonly unknown[],
  policy: RuntimeEvalPolicyV1 = DEFAULT_RUNTIME_EVAL_POLICY,
  selector: RuntimeEvalRunSelector = {},
): RuntimeEvalResultV1 {
  if (policy.version !== RUNTIME_EVAL_POLICY_VERSION) {
    throw new Error(`Unsupported runtime eval policy version: ${String(policy.version)}`);
  }

  const scan = scanRuntimeEvents(events, selector);
  const configured = { ...DEFAULT_RUNTIME_EVAL_GATES, ...policy.gates };
  const gates: RuntimeEvalGateResult[] = [
    gate(
      'receipt.valid',
      [...scan.invalidEvidence, ...scan.identityEvidence],
      'Receipt contains one valid runtime event stream.',
      'Receipt is malformed or combines multiple runs.',
    ),
  ];

  if (configured.terminalSuccess) {
    gates.push(
      gate(
        'terminal.success',
        scan.terminalEvidence,
        'Run terminated successfully.',
        'Run did not end with one successful terminal receipt.',
      ),
    );
  }
  if (configured.noMalformedToolCalls) {
    gates.push(
      gate(
        'tools.no_malformed_calls',
        scan.malformedEvidence,
        'No malformed tool calls were observed.',
        'Malformed tool calls were observed.',
      ),
    );
  }
  if (configured.noToolErrors) {
    gates.push(
      gate(
        'tools.no_errors',
        scan.toolErrorEvidence,
        'No tool failures were observed.',
        'Tool failures were observed.',
      ),
    );
  }
  if (configured.noErrors) {
    gates.push(
      gate(
        'runtime.no_errors',
        scan.errorEvidence,
        'No runtime error events were observed.',
        'Runtime error events were observed.',
      ),
    );
  }
  if (configured.noBranchDesync) {
    gates.push(
      gate(
        'branch.in_sync',
        scan.branchDesyncEvidence,
        'No branch desynchronization was observed.',
        'The active branch diverged from sandbox HEAD.',
      ),
    );
  }
  if (configured.approvalsResolved) {
    gates.push(
      gate(
        'approvals.resolved',
        scan.unresolvedApprovalEvidence,
        'Every requested approval was resolved.',
        'An approval was unresolved or had no matching request.',
      ),
    );
  }
  if (configured.approvalsApproved) {
    gates.push(
      gate(
        'approvals.approved',
        scan.deniedApprovalEvidence,
        'Every approval decision was affirmative.',
        'At least one approval was denied.',
      ),
    );
  }
  if (configured.subagentsSettled) {
    gates.push(
      gate(
        'subagents.settled',
        scan.subagentEvidence,
        'Every subagent lifecycle settled.',
        'A subagent lifecycle was invalid or left active.',
      ),
    );
  }
  if (configured.jobsSettled) {
    gates.push(
      gate(
        'jobs.settled',
        scan.jobEvidence,
        'Every background job lifecycle settled.',
        'A background job lifecycle was invalid, active, or suspended.',
      ),
    );
  }
  if (configured.acceptancePassed) {
    const failureEvidence: RuntimeEvalEvidence[] = [];
    if (scan.metrics.acceptancePassed !== true) {
      failureEvidence.push({
        eventIndex: -1,
        type: 'acceptance_complete',
        message:
          scan.metrics.acceptancePassed === null
            ? 'acceptance evidence was not present'
            : 'an acceptance check failed',
      });
    }
    gates.push(
      gate(
        'acceptance.passed',
        failureEvidence,
        'Acceptance checks completed successfully.',
        'Acceptance checks were missing or failed.',
      ),
    );
  }

  for (const toolName of configured.requiredTools) {
    const observed = Object.hasOwn(scan.metrics.tools, toolName);
    gates.push(
      gate(
        `tools.required.${toolName}`,
        observed ? [] : [{ eventIndex: -1, message: `required tool ${toolName} was not observed` }],
        `Required tool ${toolName} was observed.`,
        `Required tool ${toolName} was not observed.`,
      ),
    );
  }
  for (const toolName of configured.forbiddenTools) {
    const observed = Object.hasOwn(scan.metrics.tools, toolName);
    gates.push(
      gate(
        `tools.forbidden.${toolName}`,
        observed ? [{ eventIndex: -1, message: `forbidden tool ${toolName} was observed` }] : [],
        `Forbidden tool ${toolName} was not observed.`,
        `Forbidden tool ${toolName} was observed.`,
      ),
    );
  }

  const scores = scoreResults(scan.metrics, policy.scores);
  const gateFailed = gates.some((result) => result.status === 'fail');
  const scoreMissed = scores.some((result) => result.status === 'miss');
  const first = scan.events[0]?.event;

  return {
    version: RUNTIME_EVAL_RESULT_VERSION,
    policyVersion: RUNTIME_EVAL_POLICY_VERSION,
    verdict: gateFailed ? 'fail' : scoreMissed ? 'score_miss' : 'pass',
    sessionId: selector.sessionId ?? first?.sessionId ?? null,
    runId: selector.runId ?? first?.runId ?? null,
    metrics: scan.metrics,
    gates,
    scores,
  };
}
