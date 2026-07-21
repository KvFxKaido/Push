/**
 * delegation-coordinator.ts — task graphs and direct delegation lifecycle.
 *
 * Owns role routing, graph execution, the four delegate verbs, child/graph
 * cancellation, persistence, and terminal-event claims. Tool execution stays
 * in delegation-execution.ts; child replay/read views stay in
 * child-session-handlers.ts.
 */
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { runCoderAgent } from '../../lib/coder-agent.ts';
import { createCoderPolicyKernelAdapter } from '../../lib/coder-policy-kernel-adapter.ts';
import { formatCoderPolicyEvent } from '../../lib/coder-policy.ts';
import { runDeepReviewer } from '../../lib/deep-reviewer-agent.ts';
import { runExplorerAgent } from '../../lib/explorer-agent.ts';
import { buildReviewerContextBlock } from '../../lib/role-context.ts';
import {
  capReviewGuidanceLines,
  REVIEW_GUIDANCE_FILENAME,
  resolveReviewGuidance,
} from '../../lib/review-guidance.ts';
import { runReviewer } from '../../lib/reviewer-agent.ts';
import { RUN_TOKEN_BUDGET_ENV_VAR, resolveRunTokenBudget } from '../../lib/run-cost-budget.ts';
import {
  executeTaskGraph,
  formatTaskGraphResult,
  validateTaskGraph,
} from '../../lib/task-graph.ts';
import { resolveWorkspaceIdentity } from '../../lib/workspace-identity.js';
import { createDaemonProviderStream } from '../daemon-provider-stream.js';
import {
  wrapCliDetectAllToolCalls,
  wrapCliDetectAnyToolCall,
  wrapCliDetectNativeToolCalls,
} from '../lead-turn.js';
import { cliProviderModelSupportsNativeToolCalling } from '../native-tool-gate.js';
import { PROVIDER_CONFIGS, resolveApiKey } from '../provider.js';
import {
  appendSessionEvent,
  loadSessionState,
  makeRunId,
  PROTOCOL_VERSION,
  saveSessionState,
} from '../session-store.js';
import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from '../task-graph-memory.ts';
import {
  getCliNativeToolSchemas,
  getCliReadOnlyNativeToolSchemas,
} from '../tool-function-schemas.js';
import { READ_ONLY_TOOL_PROTOCOL, TOOL_PROTOCOL } from '../tools.js';
import { validateAttachToken } from './attach-token.js';
import type { DelegationExecutionAdapters } from './delegation-execution.js';
import { makeErrorResponse, makeResponse } from './envelopes.js';
import type { DaemonHandler } from './handler-types.js';
import { normalizeProviderInput } from './provider-input.js';
import type { SessionRuntime } from './session-runtime.js';

export interface DelegateExplorerTestHooks {
  beforeTerminalClaim?: ((context: any) => void | Promise<void>) | null;
  afterTerminalDecision?: ((context: any) => void | Promise<void>) | null;
}

export interface DelegationCoordinatorDependencies {
  runtime: SessionRuntime;
  executionAdapters: DelegationExecutionAdapters;
}

export interface DelegationCoordinator {
  handleSubmitTaskGraph: DaemonHandler;
  handleDelegateExplorer: DaemonHandler;
  handleDelegateCoder: DaemonHandler;
  handleDelegateReviewer: DaemonHandler;
  handleDelegateDeepReviewer: DaemonHandler;
  handleCancelDelegation: DaemonHandler;
  setDelegateExplorerTestHooks(hooks?: DelegateExplorerTestHooks | null): void;
}

export function createDelegationCoordinator(
  dependencies: DelegationCoordinatorDependencies,
): DelegationCoordinator {
  const sessionRuntime = dependencies.runtime;
  const activeSessions: Map<string, any> = sessionRuntime.sessions;
  const ensureRuntimeState = (entry: any) => sessionRuntime.ensureRuntimeState(entry);
  const broadcastEvent = (sessionId: string, event: any) =>
    sessionRuntime.broadcast(sessionId, event);
  const { makeDaemonCoderToolExec, makeDaemonExplorerToolExec, emitRoleAgentRunEvent } =
    dependencies.executionAdapters;

  const delegateExplorerTestHooks: DelegateExplorerTestHooks = {};
  const logDaemonCoderPolicyEvent = (event: Parameters<typeof formatCoderPolicyEvent>[0]) => {
    // Daemon stdout may carry protocol output; keep structured diagnostics on
    // stderr, matching the CLI lead lane.
    console.error(formatCoderPolicyEvent(event, 'cli_daemon'));
  };

  function setDelegateExplorerTestHooks(hooks: DelegateExplorerTestHooks | null = null) {
    delegateExplorerTestHooks.beforeTerminalClaim = hooks?.beforeTerminalClaim || null;
    delegateExplorerTestHooks.afterTerminalDecision = hooks?.afterTerminalDecision || null;
  }

  // ─── Task graph / delegation scaffolds ──────────────────────────

  /**
   * Resolve {provider, model} for a given role on an active session.
   * Honours configure_role_routing entries; falls back to session defaults.
   * Throws an Error with a descriptive message if nothing usable is available.
   */
  function resolveRoleRouting(entry: any, role: string): any {
    const routeEntry = entry.state.roleRouting?.[role];
    const routedProvider = normalizeProviderInput(routeEntry?.provider);
    if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
      throw new Error(`Unknown provider "${routedProvider}" for ${role} role routing`);
    }
    const sessionProvider = normalizeProviderInput(entry.state.provider);
    if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
      throw new Error(`Unknown provider "${sessionProvider || '(missing)'}" in session state`);
    }
    const provider = routedProvider || sessionProvider;
    const model =
      (typeof routeEntry?.model === 'string' && routeEntry.model.trim()) ||
      (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
      PROVIDER_CONFIGS[provider].defaultModel;
    return { provider, model };
  }

  /**
   * Task-graph Explorer node invocation — wires `runExplorerAgent` from
   * `lib/explorer-agent.ts` to the real daemon tool executor
   * (`makeDaemonExplorerToolExec`) so explorer nodes actually read the
   * workspace instead of running against a stub. Mirrors
   * `runCoderForTaskGraph` structurally but without approval gating
   * (Explorer is read-only) and with the simpler `{ resultText }`
   * executor return shape.
   *
   * Used only for task-graph explorer nodes; the direct
   * `delegate_explorer` RPC path still goes through
   * `handleDelegateExplorer` for its race-safe terminal-claim
   * semantics — both call sites share the same `makeDaemonExplorerToolExec`
   * factory.
   */

  async function runExplorerForTaskGraph(
    sessionId: string,
    entry: any,
    node: any,
    signal?: AbortSignal,
    preambleExtras: string[] = [],
  ): Promise<any> {
    const startedAt = Date.now();
    const { provider, model } = resolveRoleRouting(entry, 'explorer');
    const toolExec = makeDaemonExplorerToolExec({ entry, signal });
    const evaluateAfterModel = async () => null;
    const daemonStream = createDaemonProviderStream(provider, sessionId);
    const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
      ? getCliReadOnlyNativeToolSchemas()
      : undefined;

    // Splice graph-internal memory (from executeTaskGraph's
    // enrichedContext) and typed-memory retrieval blocks into the
    // task preamble. The model sees them as part of the task
    // description, separated by blank lines — matches how web's
    // role-memory-context.appendRetrievedMemoryBlock concatenates.
    const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

    const result = await runExplorerAgent(
      {
        provider,
        stream: daemonStream,
        modelId: model,
        sandboxId: null,
        allowedRepo: '',
        userProfile: null,
        taskPreamble,
        symbolSummary: null,
        toolExec,
        detectAllToolCalls: wrapCliDetectAllToolCalls,
        detectNativeToolCalls: wrapCliDetectNativeToolCalls,
        detectAnyToolCall: wrapCliDetectAnyToolCall,
        webSearchToolProtocol: '',
        // `sandboxToolProtocol` replaces the kernel's default
        // `EXPLORER_TOOL_PROTOCOL` block (which advertises web-side
        // public names like `read` / `repo_read` / `search`) with the
        // CLI-named read-only subset (`read_file` / `list_dir` /
        // `search_files` / …). Without this override the model emits
        // tool calls our detector can't recognize and every round
        // silently fails to execute anything (codex + Copilot P1 on
        // PR #284).
        sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
        nativeToolSchemas,
        evaluateAfterModel,
      },
      {
        onStatus: () => {},
        signal,
        // Forward the per-delegation prompt snapshot onto the daemon
        // event stream so a connected client (TUI / CLI / relay
        // consumer) sees the same audit trail the web orchestrator
        // already emits per turn. `appendSessionEvent` manages
        // persistence + seq; `broadcastEvent` fans out to live
        // listeners using the same envelope shape as the rest of the
        // daemon's emit sites.
        //
        // Seq capture: `appendSessionEvent` increments `state.eventSeq`
        // synchronously before its filesystem await resolves, so we read
        // the seq IMMEDIATELY after starting the append. Reading it
        // inside `.then()` would race with concurrent emits (e.g.
        // task-graph `task_completed`) that bump `eventSeq` before this
        // promise resolves, causing the live envelope to reuse a later
        // seq than the persisted record. Codex P2 on PR #540.
        //
        // Error handling: if the filesystem append fails the broadcast
        // is skipped — sending a live envelope that has no persisted
        // counterpart would diverge the journal from the wire.
        onRunEvent: emitRoleAgentRunEvent(sessionId, entry, null),
      },
    );

    const delegationOutcome = {
      agent: 'explorer',
      status: result.hitRoundCap ? 'incomplete' : 'complete',
      summary: result.summary,
      evidence: [],
      checks: [],
      gateVerdicts: [],
      missingRequirements: [],
      nextRequiredAction: result.hitRoundCap
        ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
        : null,
      rounds: result.rounds,
      checkpoints: 0,
      elapsedMs: Date.now() - startedAt,
    };

    return {
      summary: result.summary,
      delegationOutcome,
      rounds: result.rounds,
    };
  }

  /**
   * Task-graph Coder node invocation — wires `runCoderAgent` from
   * `lib/coder-agent.ts` to the real daemon tool executor.
   *
   * Mirrors `runExplorerForTaskGraph` structurally, but plugs in
   * `makeDaemonCoderToolExec` (production tool surface + approval gating)
   * and `wrapCliDetect*` (real detectors over `cli/tools.ts`) instead of
   * stubs. The LLM streams real tokens, tool calls are detected, and
   * `executeToolCall` runs them against `entry.state.cwd` — this is the
   * full-fat daemon Coder path.
   *
   * Approval events from tool calls emit on the `parentRunId` passed in
   * by `handleSubmitTaskGraph`, so a task-graph client that's attached
   * to the session sees approval prompts routed through the parent run's
   * stream (the task graph is part of the parent's work — this matches
   * the semantic the synthetic-downgrade path relies on for v1 clients).
   *
   * Coder-specific option fields that don't apply to a daemon run are
   * filled with null/empty defaults so the kernel's branches short-circuit:
   *   - `sandboxId: ''`               — no sandbox layer; runs against `cwd`
   *   - `sandboxToolProtocol: ''`     — prompt block supplied by tool detectors
   *   - `verificationPolicyBlock: null` — no daemon-side verification policy yet
   *   - `approvalModeBlock: null`     — approval gating happens inside `toolExec`
   *
   * Acceptance criteria / harness overrides are omitted so the kernel's
   * defaults apply (no criteria, no context resets, default round cap).
   */
  async function runCoderForTaskGraph(
    sessionId: string,
    entry: any,
    node: any,
    parentRunId: string | null,
    signal?: AbortSignal,
    preambleExtras: string[] = [],
  ): Promise<any> {
    const startedAt = Date.now();
    const { provider, model } = resolveRoleRouting(entry, 'coder');
    const allowedRepo = (await resolveWorkspaceIdentity(entry.state.cwd)).repoFullName;
    const daemonStream = createDaemonProviderStream(provider, sessionId);
    const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
      ? getCliNativeToolSchemas({ provider, model })
      : undefined;
    // `parentRunId` can be null when `submit_task_graph` is called on a
    // session with no active run AND no `parentRunId` payload override.
    // `buildApprovalFn` would emit `approval_required` events with
    // `runId: null` on the wire envelope, which violates the
    // protocol-schema strict-mode rule that `runId` must be omitted or
    // a non-empty string (codex P1 on PR #282). Mint a fresh child run
    // id for the task-graph node in that case so approval events still
    // carry a valid runId, even if no client is specifically listening
    // for this execution's run.
    const effectiveRunId =
      typeof parentRunId === 'string' && parentRunId.trim().length > 0 ? parentRunId : makeRunId();
    const daemonToolExec = makeDaemonCoderToolExec({
      sessionId,
      entry,
      runId: effectiveRunId,
      signal,
    });
    const { toolExec, evaluateAfterModel } = createCoderPolicyKernelAdapter({
      context: {
        round: 0,
        maxRounds: 30,
        allowedRepo,
        taskInFlight: true,
      },
      execute: daemonToolExec,
      onEvent: logDaemonCoderPolicyEvent,
    });

    const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

    const result = await runCoderAgent(
      {
        provider,
        stream: daemonStream,
        modelId: model,
        // Daemon task-graph node: a delegated implementer, not the lead.
        persona: 'coder',
        sandboxId: '',
        allowedRepo,
        userProfile: null,
        taskPreamble,
        symbolSummary: null,
        toolExec,
        detectAllToolCalls: wrapCliDetectAllToolCalls,
        detectNativeToolCalls: wrapCliDetectNativeToolCalls,
        detectAnyToolCall: wrapCliDetectAnyToolCall,
        webSearchToolProtocol: '',
        // `sandboxToolProtocol` is the tool-instruction block the kernel
        // splices into its system prompt — without it the model has no
        // guidance on what tool-call JSON to emit (codex P1 on PR #282).
        // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
        // non-delegated CLI engine uses.
        sandboxToolProtocol: TOOL_PROTOCOL,
        nativeToolSchemas,
        verificationPolicyBlock: null,
        approvalModeBlock: null,
        evaluateAfterModel,
        // Per-run token budget for this daemon task-graph Coder node. Resolved
        // from env (config is forwarded to `PUSH_RUN_TOKEN_BUDGET` by
        // `applyConfigToEnv`); null (uncapped) maps to undefined for the kernel.
        harnessTokenBudget:
          resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
      },
      {
        onStatus: () => {},
        signal,
        onRunEvent: emitRoleAgentRunEvent(sessionId, entry, parentRunId ?? null),
      },
    );

    const delegationOutcome = {
      agent: 'coder',
      // Runs that return from `runCoderAgent` without throwing have made
      // it through the kernel's loop. The kernel itself doesn't classify
      // "complete vs incomplete"; that's a delegation-outcome concern.
      // We default to 'complete' on a clean return — any structural
      // failure (thrown error) lands in the catch block in the caller
      // and marks the outcome 'inconclusive'. A richer classifier that
      // inspects working memory + acceptance criteria is a follow-up.
      status: 'complete',
      summary: result.summary,
      evidence: [],
      checks: [],
      gateVerdicts: [],
      missingRequirements: [],
      nextRequiredAction: null,
      rounds: result.rounds,
      checkpoints: result.checkpoints,
      elapsedMs: Date.now() - startedAt,
    };

    return {
      summary: result.summary,
      delegationOutcome,
      rounds: result.rounds,
    };
  }

  async function handleSubmitTaskGraph(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const graph = req.payload?.graph;
    const parentRunIdPayload =
      typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!graph || typeof graph !== 'object' || !Array.isArray(graph.tasks)) {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'INVALID_REQUEST',
        'graph.tasks must be an array of task nodes',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'submit_task_graph',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const validationErrors = validateTaskGraph(graph.tasks);
    if (validationErrors.length > 0) {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'INVALID_TASK_GRAPH',
        validationErrors.map((e) => `${e.type}: ${e.message}`).join('; '),
      );
    }

    ensureRuntimeState(entry);

    const executionId = `graph_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const parentRunId = parentRunIdPayload || entry.activeRunId || null;
    const abortController = new AbortController();
    const startedAt = Date.now();
    const nodeCount = graph.tasks.length;

    entry.activeGraphs.set(executionId, {
      executionId,
      parentRunId,
      abortController,
      startedAt,
      nodeCount,
    });

    const ack = makeResponse(req.requestId, 'submit_task_graph', sessionId, true, {
      executionId,
      accepted: true,
      nodeCount,
    });

    // Background execution — RPC has already acked. Events flow through
    // appendSessionEvent + broadcastEvent as lib/task-graph makes progress.
    (async () => {
      // Index nodes by id so onProgress can recover the agent kind from taskId.
      const nodesById = new Map();
      for (const node of graph.tasks) nodesById.set(node.id, node);

      // Serialize task-graph progress writes through a per-session promise
      // chain. `executeTaskGraph` calls `onProgress` synchronously, and with
      // parallel explorer nodes (max 3) multiple progress callbacks can fire
      // in quick succession. Without serialization, concurrent
      // `appendSessionEvent` calls race on `state.eventSeq` — the field is
      // mutated *before* the filesystem append resolves, so overlapping calls
      // can (a) write events to `events.jsonl` out of seq order and
      // (b) read a seq value for the broadcast envelope that has already been
      // bumped by a later write. `attach_session` replays from disk in file
      // order, so misordering would surface on any reconnect.
      let emitChain = Promise.resolve();
      const emitTaskGraphEvent = (type: string, payload: any) => {
        const runIdField = parentRunId ? { runId: parentRunId } : {};
        const chained = emitChain.then(async () => {
          // Pass `parentRunId` (possibly null) through to appendSessionEvent;
          // session-store already omits `runId` from the persisted envelope
          // when the argument is falsy, so the on-disk record stays consistent
          // with the wire envelope built below.
          await appendSessionEvent(entry.state, type, payload, parentRunId).catch(() => {});
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            ...runIdField,
            seq: entry.state.eventSeq,
            ts: Date.now(),
            type,
            payload,
          });
        });
        emitChain = chained.catch(() => {});
        return chained;
      };

      const onProgress = (evt: any) => {
        if (evt.type === 'graph_complete') {
          // Final graph_completed event is emitted explicitly below with
          // richer metadata (success/aborted/counters) from the result object.
          return;
        }
        const node = evt.taskId ? nodesById.get(evt.taskId) : null;
        const agent = node?.agent || 'explorer';
        switch (evt.type) {
          case 'task_ready':
            emitTaskGraphEvent('task_graph.task_ready', {
              executionId,
              taskId: evt.taskId,
              agent,
              detail: evt.detail,
            });
            return;
          case 'task_started':
            emitTaskGraphEvent('task_graph.task_started', {
              executionId,
              taskId: evt.taskId,
              agent,
              detail: evt.detail,
            });
            return;
          case 'task_completed':
            emitTaskGraphEvent('task_graph.task_completed', {
              executionId,
              taskId: evt.taskId,
              agent,
              summary: evt.detail || '',
              elapsedMs: evt.elapsedMs,
            });
            return;
          case 'task_failed':
            emitTaskGraphEvent('task_graph.task_failed', {
              executionId,
              taskId: evt.taskId,
              agent,
              error: evt.detail || 'Task failed',
              elapsedMs: evt.elapsedMs,
            });
            return;
          case 'task_cancelled':
            emitTaskGraphEvent('task_graph.task_cancelled', {
              executionId,
              taskId: evt.taskId,
              agent,
              reason: evt.detail || 'Task cancelled',
              elapsedMs: evt.elapsedMs,
            });
            return;
          default:
            return;
        }
      };

      // Resolve workspace identity once per graph — branch could move
      // during a long-running graph if a Coder node commits or
      // switches branches, but for the scope of this graph the
      // identity captured here is used as the memory scope for all
      // retrievals + writes. This matches how web uses a single
      // branchInfoRef snapshot per delegation (useAgentDelegation.ts).
      // resolveWorkspaceIdentity is non-throwing by contract (errors
      // become path.basename(cwd) / null fallbacks internally), so no
      // outer catch needed.
      const workspaceIdentity = await resolveWorkspaceIdentity(entry.state.cwd);
      // chatId deliberately omitted from the scope: pushd's sessionId is
      // per-invocation for headless flows, and even attached sessions
      // wouldn't benefit from chatId-narrowing memory across the
      // workspace. Codex P1 review on PR #333.
      const graphMemoryScope = {
        repoFullName: workspaceIdentity.repoFullName,
        branch: workspaceIdentity.branch ?? undefined,
        taskGraphId: executionId,
      };

      const executor = async (node: any, enrichedContext: string[], signal?: AbortSignal) => {
        // Retrieve typed memory scoped to this node. Splice it
        // alongside the graph-internal memory (`enrichedContext`
        // from lib/task-graph.ts, containing `[TASK_GRAPH_MEMORY]`
        // summaries of completed dependency + sibling nodes) into
        // the node's taskPreamble. Retrieval failures return null
        // and the node runs with just the graph-internal memory —
        // graceful degradation.
        const retrievedBlock = await buildTypedMemoryBlockForNode({
          node,
          scope: graphMemoryScope,
        });
        const preambleExtras = [
          ...(enrichedContext ?? []),
          ...(retrievedBlock ? [retrievedBlock] : []),
        ];

        if (node.agent === 'explorer') {
          return runExplorerForTaskGraph(sessionId, entry, node, signal, preambleExtras);
        }
        if (node.agent === 'coder') {
          return runCoderForTaskGraph(sessionId, entry, node, parentRunId, signal, preambleExtras);
        }
        throw new Error(`Unsupported task-graph agent: ${node.agent}`);
      };

      let result;
      let execError = null;
      try {
        result = await executeTaskGraph(graph.tasks, executor, {
          signal: abortController.signal,
          onProgress,
        });
      } catch (err: any) {
        // executeTaskGraph normally does not throw (cancellation surfaces via
        // aborted=true), but defensively emit a terminal event so clients are
        // never left waiting on a silent graph.
        execError = err instanceof Error ? err : new Error(String(err));
      }

      const completedPayload = result
        ? {
            executionId,
            summary: formatTaskGraphResult(result),
            success: result.success,
            aborted: result.aborted,
            nodeCount,
            totalRounds: result.totalRounds,
            wallTimeMs: result.wallTimeMs,
          }
        : {
            executionId,
            summary: `Task graph crashed: ${execError?.message ?? 'unknown error'}`,
            success: false,
            aborted: false,
            nodeCount,
            totalRounds: 0,
            wallTimeMs: Date.now() - startedAt,
          };

      // Persist typed memory for each completed node before emitting
      // graph_completed so later runs can retrieve prior findings +
      // outcomes. Writes are error-isolated — a failure for one node
      // logs and continues, never blocking the completion event.
      // Reuses `graphMemoryScope` already resolved above so we don't
      // invoke git twice per graph.
      if (result) {
        try {
          await writeTaskGraphResultMemory(result, graphMemoryScope);
        } catch (err: any) {
          // Belt-and-braces — writeTaskGraphResultMemory is
          // error-isolated per-node, so a throw at this level means
          // something went wrong before the loop (e.g., an
          // unexpected store-initialization failure).
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `${JSON.stringify({
              level: 'warn',
              event: 'task_graph_memory_persist_failed',
              executionId,
              error: msg,
            })}\n`,
          );
        }
      }

      await emitTaskGraphEvent('task_graph.graph_completed', completedPayload);
      entry.activeGraphs.delete(executionId);
      await saveSessionState(entry.state).catch(() => {});
    })();

    return ack;
  }

  async function handleCancelDelegation(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const subagentId = req.payload?.subagentId;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!subagentId) {
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'INVALID_REQUEST',
        'subagentId is required',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'cancel_delegation',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    ensureRuntimeState(entry);
    const delegation = entry.activeDelegations.get(subagentId);

    // If the id doesn't map to an active delegation, treat it as a task-graph
    // executionId. We reuse cancel_delegation here so v2 task-graph clients
    // don't need a new RPC just to abort a graph.
    if (!delegation) {
      const graph = entry.activeGraphs.get(subagentId);
      if (graph) {
        if (graph.abortController) graph.abortController.abort();
        // The background executor loop observes `signal.aborted`, drives each
        // running node to a `task_graph.task_cancelled` event, and emits the
        // final `task_graph.graph_completed` with aborted=true before removing
        // the entry from activeGraphs.
        return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
          accepted: true,
          kind: 'task_graph',
          executionId: subagentId,
        });
      }
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'DELEGATION_NOT_FOUND',
        `No active delegation with subagentId: ${subagentId}`,
        false,
      );
    }

    if (delegation.abortController) {
      delegation.abortController.abort();
    }
    entry.activeDelegations.delete(subagentId);

    const childRunId = typeof delegation.childRunId === 'string' ? delegation.childRunId : null;
    const parentRunId = typeof delegation.parentRunId === 'string' ? delegation.parentRunId : null;
    const agent = delegation.agent || delegation.role || 'subagent';
    const message = 'Cancelled by client';
    const eventPayload = {
      executionId: subagentId,
      subagentId,
      ...(parentRunId ? { parentRunId } : {}),
      ...(childRunId ? { childRunId } : {}),
      agent,
      role: delegation.role || agent,
      error: message,
      errorDetails: { code: 'CANCELLED', message, retryable: false },
    };
    await appendSessionEvent(entry.state, 'subagent.failed', eventPayload, childRunId);
    await saveSessionState(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: childRunId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'subagent.failed',
      payload: eventPayload,
    });

    return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
      accepted: true,
    });
  }

  // ─── Delegate Explorer (scaffold + real lib-kernel integration) ─

  /**
   * `delegate_explorer` — daemon-side Explorer launch.
   *
   * Wires the full delegate_explorer RPC path from handler → runExplorerAgent
   * (the Phase 5D step 1 lib kernel) → DelegationOutcome persistence. The
   * `streamFn` DI slot is a real daemon-side adapter (`createDaemonProviderStream`,
   * see cli/daemon-provider-stream.ts) that streams tokens through the existing
   * `cli/provider.ts#streamCompletion` helper. The `toolExec` slot remains stubbed
   * — stub detectors short-circuit it, so no tool is ever actually invoked.
   *
   * Provider / model resolution honors role routing: if
   * `entry.state.roleRouting.explorer` is set (via `configure_role_routing`),
   * that provider+model is used; otherwise the session-level defaults are.
   * The adapter itself stays provider-agnostic — all policy lives here.
   *
   * The capability flag is `delegation_explorer_v1`. `multi_agent` is also
   * advertised (see the CAPABILITIES list) — both prerequisites it once waited
   * on are shipped: this handler runs `makeDaemonExplorerToolExec` (real
   * `executeToolCall`) and `handleDelegateCoder` wires the second role.
   */
  async function handleDelegateExplorer(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const task = req.payload?.task;
    const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
    const parentRunIdPayload =
      typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!task || typeof task !== 'string' || !task.trim()) {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'INVALID_REQUEST',
        'task is required and must be a non-empty string',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'delegate_explorer',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    // Resolve provider/model with role-routing precedence. configure_role_routing
    // stores `state.roleRouting[role] = { provider, model }`; when present for
    // 'explorer' it overrides the session-level defaults for this delegation.
    const explorerRoute = entry.state.roleRouting?.explorer;
    const routedProvider = normalizeProviderInput(explorerRoute?.provider);
    if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${routedProvider}" for explorer role routing`,
      );
    }
    const sessionProvider = normalizeProviderInput(entry.state.provider);
    if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
      );
    }
    const resolvedProvider = routedProvider || sessionProvider;
    const resolvedModel =
      (typeof explorerRoute?.model === 'string' && explorerRoute.model.trim()) ||
      (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
      PROVIDER_CONFIGS[resolvedProvider].defaultModel;

    ensureRuntimeState(entry);

    const subagentId = `sub_explorer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const childRunId = makeRunId();
    const parentRunId = parentRunIdPayload || entry.activeRunId || null;
    const abortController = new AbortController();
    const startedAt = Date.now();
    const trimmedTask = task.trim();

    entry.activeDelegations.set(subagentId, {
      role: 'explorer',
      agent: 'explorer',
      parentRunId,
      childRunId,
      abortController,
      startedAt,
      task: trimmedTask,
    });

    const startEventPayload = {
      executionId: subagentId,
      subagentId,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId,
      agent: 'explorer',
      role: 'explorer',
      detail: trimmedTask.slice(0, 280),
    };
    await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
    await saveSessionState(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: childRunId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'subagent.started',
      payload: startEventPayload,
    });

    const ack = makeResponse(req.requestId, 'delegate_explorer', sessionId, true, {
      subagentId,
      childRunId,
      accepted: true,
    });

    // Background run. The RPC has already acked. Events are broadcast as the
    // lib kernel progresses. Terminal ownership is claimed synchronously by
    // deleting the delegation entry before any awaited terminal-event work so
    // cancel_delegation wins whenever it removes the entry first.
    (async () => {
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });
      const evaluateAfterModel = async () => null;

      let outcome;
      let runError = null;
      try {
        const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
        const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
          resolvedProvider,
          resolvedModel,
        )
          ? getCliReadOnlyNativeToolSchemas()
          : undefined;
        const result = await runExplorerAgent(
          {
            provider: resolvedProvider as any,
            stream: daemonStream,
            modelId: resolvedModel,
            sandboxId: null,
            allowedRepo,
            userProfile: null,
            taskPreamble: trimmedTask,
            symbolSummary: null,
            toolExec,
            detectAllToolCalls: wrapCliDetectAllToolCalls,
            detectNativeToolCalls: wrapCliDetectNativeToolCalls,
            detectAnyToolCall: wrapCliDetectAnyToolCall,
            webSearchToolProtocol: '',
            // See `runExplorerForTaskGraph` above for why this matters:
            // the kernel's default `EXPLORER_TOOL_PROTOCOL` advertises
            // web-side public tool names (`read`, `repo_read`, `search`)
            // that the daemon's detector doesn't recognize. Overriding
            // with `READ_ONLY_TOOL_PROTOCOL` from `cli/tools.ts` makes
            // the model emit CLI tool names that match
            // `READ_ONLY_TOOLS` + `executeToolCall`'s dispatch table.
            sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
            nativeToolSchemas,
            evaluateAfterModel,
          },
          {
            onStatus: () => {
              // Quiet for now — later slices can emit agent_status events here.
            },
            signal: abortController.signal,
          },
        );

        outcome = {
          agent: 'explorer',
          status: result.hitRoundCap ? 'incomplete' : 'complete',
          summary: result.summary,
          evidence: [],
          checks: [],
          gateVerdicts: [],
          missingRequirements: [],
          nextRequiredAction: result.hitRoundCap
            ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
            : null,
          rounds: result.rounds,
          checkpoints: 0,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err: any) {
        runError = err;
        const isAbort =
          err &&
          ((err instanceof Error && err.name === 'AbortError') ||
            (typeof err?.message === 'string' && err.message.includes('cancelled')));
        const message = err instanceof Error ? err.message : String(err);
        outcome = {
          agent: 'explorer',
          status: 'inconclusive',
          summary: isAbort
            ? 'Explorer cancelled during daemon run.'
            : `Explorer failed during daemon run: ${message}`,
          evidence: [],
          checks: [],
          gateVerdicts: [],
          missingRequirements: [],
          nextRequiredAction: null,
          rounds: 0,
          checkpoints: 0,
          elapsedMs: Date.now() - startedAt,
        };
      }

      // Persist the outcome record even if cancel_delegation already emitted —
      // the session-state record must reflect what the scaffold run produced.
      if (!Array.isArray(entry.state.delegationOutcomes)) {
        entry.state.delegationOutcomes = [];
      }
      entry.state.delegationOutcomes.push({ subagentId, outcome });

      if (delegateExplorerTestHooks.beforeTerminalClaim) {
        await delegateExplorerTestHooks.beforeTerminalClaim({
          sessionId,
          subagentId,
          childRunId,
          outcome,
          runError,
        });
      }

      const activeDelegation = entry.activeDelegations?.get(subagentId);
      if (!activeDelegation) {
        // cancel_delegation already removed the entry and emitted subagent.failed.
        // Persist outcome only, no event emission to avoid duplicates.
        await saveSessionState(entry.state);
        if (delegateExplorerTestHooks.afterTerminalDecision) {
          await delegateExplorerTestHooks.afterTerminalDecision({
            sessionId,
            subagentId,
            childRunId,
            emittedTerminalEvent: false,
            terminalEventType: null,
          });
        }
        return;
      }
      entry.activeDelegations.delete(subagentId);

      if (runError) {
        const isAbort =
          (runError instanceof Error && runError.name === 'AbortError') ||
          (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
        const message = runError instanceof Error ? runError.message : String(runError);
        const failPayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'explorer',
          role: 'explorer',
          error: message,
          errorDetails: {
            code: isAbort ? 'CANCELLED' : 'EXPLORER_FAILED',
            message,
            retryable: false,
          },
        };
        await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.failed',
          payload: failPayload,
        });
      } else {
        const completePayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'explorer',
          role: 'explorer',
          summary: outcome.summary.slice(0, 280),
          delegationOutcome: outcome,
        };
        await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.completed',
          payload: completePayload,
        });
      }
      if (delegateExplorerTestHooks.afterTerminalDecision) {
        await delegateExplorerTestHooks.afterTerminalDecision({
          sessionId,
          subagentId,
          childRunId,
          emittedTerminalEvent: true,
          terminalEventType: runError ? 'subagent.failed' : 'subagent.completed',
        });
      }
    })();

    return ack;
  }

  // ─── Delegate Coder (scaffold + real lib-kernel integration) ───

  /**
   * `delegate_coder` — daemon-side Coder launch.
   *
   * Resolves role routing, validates input, mints ids, emits
   * `subagent.started`, acks the RPC, and runs the lib Coder kernel in the
   * background. The kernel consumes `makeDaemonCoderToolExec` (a real
   * `executeToolCall`-backed tool executor from `cli/tools.ts`) and
   * `wrapCliDetect*` (the production detectors from `cli/tools.ts`). LLM
   * streams real tokens via `createDaemonProviderStream`; tool calls the
   * model emits are parsed, classified into read-only / mutating by
   * `READ_ONLY_TOOLS`, and executed against `entry.state.cwd` with
   * approval gating routed through `buildApprovalFn` on `childRunId`. This
   * is the full-fat daemon Coder path — no scaffolding, no stubs.
   *
   * Why a separate handler from `delegate_explorer` when the shapes are so
   * similar: the explorer kernel's option interface is narrower (no
   * `sandboxToolProtocol`, no approval/verification policy slots), and
   * the coder kernel's `CoderToolExecResult` discriminated union has its
   * own shape rules (`errorType` feeds the mutation-failure tracker,
   * `policyPost` drives the kernel's halt guard). Explorer is also fully
   * wired (`makeDaemonExplorerToolExec` → real `executeToolCall`); the two
   * handlers stay separate for the option-shape reasons above, not because
   * either is still a stub.
   *
   * Provider / model resolution honours `entry.state.roleRouting.coder` —
   * set via `configure_role_routing` — and falls back to session defaults
   * otherwise. The resolved values feed both the daemon stream adapter and
   * the `modelId` option on the kernel.
   *
   * Capability flag: `delegation_coder_v1`. `multi_agent` is advertised too —
   * both executors (Explorer + Coder) are real and the v1 synthetic downgrade
   * path ships in `cli/v1-downgrade.ts`, so nothing here still blocks it.
   */
  async function handleDelegateCoder(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const task = req.payload?.task;
    const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
    const parentRunIdPayload =
      typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!task || typeof task !== 'string' || !task.trim()) {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'INVALID_REQUEST',
        'task is required and must be a non-empty string',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'delegate_coder',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    // Resolve provider/model with role-routing precedence for the coder role.
    // Mirrors the explorer block; we inline rather than delegate to
    // `resolveRoleRouting()` (used by the task-graph scaffold path) so we can
    // produce structured `PROVIDER_NOT_CONFIGURED` errors before any state
    // mutation or subagent.started event — same contract as explorer.
    const coderRoute = entry.state.roleRouting?.coder;
    const routedProvider = normalizeProviderInput(coderRoute?.provider);
    if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${routedProvider}" for coder role routing`,
      );
    }
    const sessionProvider = normalizeProviderInput(entry.state.provider);
    if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
      );
    }
    const resolvedProvider = routedProvider || sessionProvider;
    const resolvedModel =
      (typeof coderRoute?.model === 'string' && coderRoute.model.trim()) ||
      (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
      PROVIDER_CONFIGS[resolvedProvider].defaultModel;

    ensureRuntimeState(entry);

    const subagentId = `sub_coder_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const childRunId = makeRunId();
    const parentRunId = parentRunIdPayload || entry.activeRunId || null;
    const abortController = new AbortController();
    const startedAt = Date.now();
    const trimmedTask = task.trim();

    entry.activeDelegations.set(subagentId, {
      role: 'coder',
      agent: 'coder',
      parentRunId,
      childRunId,
      abortController,
      startedAt,
      task: trimmedTask,
    });

    const startEventPayload = {
      executionId: subagentId,
      subagentId,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId,
      agent: 'coder',
      role: 'coder',
      detail: trimmedTask.slice(0, 280),
    };
    await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
    await saveSessionState(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: childRunId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'subagent.started',
      payload: startEventPayload,
    });

    const ack = makeResponse(req.requestId, 'delegate_coder', sessionId, true, {
      subagentId,
      childRunId,
      accepted: true,
    });

    // Background run — identical lifecycle to handleDelegateExplorer: the
    // RPC has already acked, the lib kernel streams real tokens through the
    // daemon provider adapter, and terminal ownership is claimed synchronously
    // by deleting the delegation registry entry BEFORE any awaited terminal
    // event so `cancel_delegation` wins whenever it removes the entry first.
    (async () => {
      // Real daemon tool executor + real CLI detectors. Replaces the
      // scaffold stubs that returned `{ kind: 'denied', reason: 'not yet wired' }`.
      // Tool calls now actually read/write files and run shell commands
      // under approval gating — high-risk exec commands emit an
      // `approval_required` event on `childRunId` and block on a
      // `submit_approval` RPC via `buildApprovalFn` (baked into the
      // executor closure itself).
      const daemonToolExec = makeDaemonCoderToolExec({
        sessionId,
        entry,
        runId: childRunId,
        signal: abortController.signal,
      });
      const { toolExec, evaluateAfterModel } = createCoderPolicyKernelAdapter({
        context: {
          round: 0,
          maxRounds: 30,
          allowedRepo,
          taskInFlight: true,
        },
        execute: daemonToolExec,
        onEvent: logDaemonCoderPolicyEvent,
      });

      let outcome;
      let runError = null;
      try {
        const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
        const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
          resolvedProvider,
          resolvedModel,
        )
          ? getCliNativeToolSchemas({ provider: resolvedProvider, model: resolvedModel })
          : undefined;
        const result = await runCoderAgent(
          {
            provider: resolvedProvider as any,
            stream: daemonStream,
            modelId: resolvedModel,
            // Daemon delegated child Coder run, not the lead.
            persona: 'coder',
            sandboxId: '',
            allowedRepo,
            userProfile: null,
            taskPreamble: trimmedTask,
            symbolSummary: null,
            toolExec,
            detectAllToolCalls: wrapCliDetectAllToolCalls,
            detectNativeToolCalls: wrapCliDetectNativeToolCalls,
            detectAnyToolCall: wrapCliDetectAnyToolCall,
            webSearchToolProtocol: '',
            // `sandboxToolProtocol` is the tool-instruction block the kernel
            // splices into its system prompt — without it the model has no
            // guidance on what tool-call JSON to emit (codex P1 on PR #282).
            // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
            // non-delegated CLI engine uses.
            sandboxToolProtocol: TOOL_PROTOCOL,
            nativeToolSchemas,
            verificationPolicyBlock: null,
            approvalModeBlock: null,
            evaluateAfterModel,
            // Per-run token budget for this daemon delegated Coder. Resolved from
            // env (config forwarded to `PUSH_RUN_TOKEN_BUDGET` by
            // `applyConfigToEnv`); null (uncapped) maps to undefined.
            harnessTokenBudget:
              resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
          },
          {
            onStatus: () => {
              // Quiet for now — later slices can emit agent_status events here.
            },
            signal: abortController.signal,
            onRunEvent: emitRoleAgentRunEvent(sessionId, entry, childRunId ?? null),
          },
        );

        outcome = {
          agent: 'coder',
          // Kernel returned cleanly — default to 'complete'. Deeper
          // classification (incomplete on unfinished acceptance criteria,
          // inconclusive on policy halts) is a follow-up that inspects
          // working memory + criteriaResults. For now, structural success
          // (no thrown error) lands as 'complete'.
          status: 'complete',
          summary: result.summary,
          evidence: [],
          checks: [],
          gateVerdicts: [],
          missingRequirements: [],
          nextRequiredAction: null,
          rounds: result.rounds,
          checkpoints: result.checkpoints,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err: any) {
        runError = err;
        const isAbort =
          err &&
          ((err instanceof Error && err.name === 'AbortError') ||
            (typeof err?.message === 'string' && err.message.includes('cancelled')));
        const message = err instanceof Error ? err.message : String(err);
        outcome = {
          agent: 'coder',
          status: 'inconclusive',
          summary: isAbort
            ? 'Coder cancelled during daemon run.'
            : `Coder failed during daemon run: ${message}`,
          evidence: [],
          checks: [],
          gateVerdicts: [],
          missingRequirements: [],
          nextRequiredAction: null,
          rounds: 0,
          checkpoints: 0,
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (!Array.isArray(entry.state.delegationOutcomes)) {
        entry.state.delegationOutcomes = [];
      }
      entry.state.delegationOutcomes.push({ subagentId, outcome });

      const activeDelegation = entry.activeDelegations?.get(subagentId);
      if (!activeDelegation) {
        // cancel_delegation already removed the entry and emitted subagent.failed.
        // Persist outcome only, no event emission to avoid duplicates.
        await saveSessionState(entry.state);
        return;
      }
      entry.activeDelegations.delete(subagentId);

      if (runError) {
        const isAbort =
          (runError instanceof Error && runError.name === 'AbortError') ||
          (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
        const message = runError instanceof Error ? runError.message : String(runError);
        const failPayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'coder',
          role: 'coder',
          error: message,
          errorDetails: {
            code: isAbort ? 'CANCELLED' : 'CODER_FAILED',
            message,
            retryable: false,
          },
        };
        await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.failed',
          payload: failPayload,
        });
      } else {
        const completePayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'coder',
          role: 'coder',
          summary: outcome.summary.slice(0, 280),
          delegationOutcome: outcome,
        };
        await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.completed',
          payload: completePayload,
        });
      }
    })();

    return ack;
  }

  // ─── Delegate Reviewer (advisory diff review, single-turn) ──────

  // Byte ceiling for the bounded REVIEW.md read below. Comfortably exceeds the
  // downstream char cap in role-context (8000) and ~600 lines of guidance, while
  // bounding memory so a pathological REVIEW.md can't be materialized whole.
  const REVIEW_GUIDANCE_MAX_BYTES = 64 * 1024;

  /**
   * Read the working-copy REVIEW.md from a daemon workspace, byte- and line-capped.
   * The daemon reviews the local checkout, so the working copy (including unpushed
   * edits) is the authoritative guidance. Returns null when the file is absent so
   * `resolveReviewGuidance` treats it as "no guidance" rather than a read failure;
   * a genuine read error (permissions, etc.) rethrows so the resolver logs it.
   *
   * Reads at most `REVIEW_GUIDANCE_MAX_BYTES` via a bounded file-handle read rather
   * than `fs.readFile`, so the cap actually bounds memory instead of slicing a
   * fully-materialized file after the fact.
   */
  async function readWorkspaceReviewGuidance(cwd: string) {
    let handle;
    try {
      handle = await fs.open(path.join(cwd, REVIEW_GUIDANCE_FILENAME), 'r');
      const buffer = Buffer.alloc(REVIEW_GUIDANCE_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, REVIEW_GUIDANCE_MAX_BYTES, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      return capReviewGuidanceLines(text);
    } catch (err: any) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
      throw err;
    } finally {
      await handle?.close();
    }
  }

  /**
   * `delegate_reviewer` — daemon-side Reviewer launch.
   *
   * Wires the full delegate_reviewer RPC path from handler → runReviewer
   * (the Phase 5D reviewer lib kernel) → ReviewResult persistence. Unlike
   * Explorer, the Reviewer is single-turn and read-only — it streams JSON
   * once, parses it into a ReviewResult, and returns. No tool loop, no
   * stub detectors, no DelegationOutcome envelope: the review payload has
   * its own schema (`filesReviewed` / `totalFiles` / `truncated` / `comments`)
   * that would be lossy in the gate-shaped DelegationOutcome contract.
   *
   * The streamFn adapter is wrapped in a signal-forwarding closure so the
   * handler's AbortController still reaches the underlying fetch even though
   * `runReviewer` itself doesn't accept an AbortSignal in its options.
   *
   * Provider / model resolution honors `roleRouting.reviewer`; otherwise
   * it falls back to session-level defaults.
   *
   * Capability flag: `delegation_reviewer_v1`.
   */
  async function handleDelegateReviewer(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
    const parentRunIdPayload =
      typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
    const rawContext =
      req.payload?.context && typeof req.payload.context === 'object'
        ? req.payload.context
        : undefined;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'INVALID_REQUEST',
        'diff is required and must be a non-empty string',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        // Restore the persisted attach token from session state instead of
        // minting a fresh one. Without this, clients lose their token on any
        // handler that lazy-loads a session from disk (including after a
        // daemon crash + restart), because `validateAttachToken` would
        // compare the caller's original token against a freshly minted one.
        // Legacy sessions without a persisted token load with attachToken
        // undefined; they are claimed on first `attach_session` (bootstrap
        // grace). A non-attach handler reached before that claim now rejects —
        // the implicit tokenless bypass is gone (Universal Session Bearer).
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'delegate_reviewer',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    const reviewerRoute = entry.state.roleRouting?.reviewer;
    const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
    if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${routedProvider}" for reviewer role routing`,
      );
    }
    const sessionProvider = normalizeProviderInput(entry.state.provider);
    if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
      );
    }
    const resolvedProvider = routedProvider || sessionProvider;
    const resolvedModel =
      (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
      (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
      PROVIDER_CONFIGS[resolvedProvider].defaultModel;

    ensureRuntimeState(entry);

    const subagentId = `sub_reviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const childRunId = makeRunId();
    const parentRunId = parentRunIdPayload || entry.activeRunId || null;
    const abortController = new AbortController();
    const startedAt = Date.now();

    entry.activeDelegations.set(subagentId, {
      role: 'reviewer',
      agent: 'reviewer',
      parentRunId,
      childRunId,
      abortController,
      startedAt,
      task: 'review-diff',
    });

    const detail = `review diff (${diff.length} chars)`;
    const startEventPayload = {
      executionId: subagentId,
      subagentId,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId,
      agent: 'reviewer',
      role: 'reviewer',
      detail,
    };
    await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
    await saveSessionState(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: childRunId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'subagent.started',
      payload: startEventPayload,
    });

    const ack = makeResponse(req.requestId, 'delegate_reviewer', sessionId, true, {
      subagentId,
      childRunId,
      accepted: true,
    });

    (async () => {
      let reviewResult = null;
      let runError = null;
      try {
        const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
        // The lib reviewer's `iteratePushStreamText` only owns its own activity
        // controller. Compose `abortController.signal` with the consumer's
        // per-stream signal so cancel_delegation aborts the upstream call.
        const signalAwareStream = (req: any) =>
          baseStream({
            ...req,
            signal: req.signal
              ? AbortSignal.any([req.signal, abortController.signal])
              : abortController.signal,
          });

        // Default-on REVIEW.md: an explicit caller-supplied `reviewGuidance` wins
        // (the RPC client knows the review ref); otherwise resolve the daemon
        // workspace's working-copy REVIEW.md so the CLI Reviewer gets the same
        // repo-specific guidance the web Reviewer already does.
        const callerGuidance =
          rawContext && typeof rawContext.reviewGuidance === 'string'
            ? rawContext.reviewGuidance
            : null;
        const reviewGuidance =
          callerGuidance ??
          (await resolveReviewGuidance({
            readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
          }));
        const reviewerContext = reviewGuidance
          ? { ...(rawContext ?? {}), reviewGuidance }
          : rawContext;

        reviewResult = await runReviewer(
          diff,
          {
            provider: resolvedProvider as any,
            stream: signalAwareStream,
            modelId: resolvedModel,
            context: reviewerContext,
            resolveRuntimeContext: async (_diff: any, context: any) =>
              buildReviewerContextBlock(context) || '',
          },
          () => {
            // Quiet for now — later slices can emit agent_status events here.
          },
        );
      } catch (err: any) {
        runError = err;
      }

      // Persist review result even if cancel_delegation already claimed the entry.
      if (reviewResult) {
        if (!Array.isArray(entry.state.reviewOutcomes)) {
          entry.state.reviewOutcomes = [];
        }
        entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
      }

      const activeDelegation = entry.activeDelegations?.get(subagentId);
      if (!activeDelegation) {
        // cancel_delegation already removed the entry and emitted subagent.failed.
        // Persist outcome only, no event emission.
        await saveSessionState(entry.state);
        return;
      }
      entry.activeDelegations.delete(subagentId);

      if (runError || !reviewResult) {
        const err = runError;
        const isAbort =
          err &&
          ((err instanceof Error && err.name === 'AbortError') ||
            (typeof err?.message === 'string' && err.message.includes('cancelled')));
        const message =
          err instanceof Error ? err.message : String(err ?? 'unknown reviewer error');
        const failPayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'reviewer',
          role: 'reviewer',
          error: message,
          errorDetails: {
            code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
            message,
            retryable: false,
          },
        };
        await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.failed',
          payload: failPayload,
        });
      } else {
        const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
        const completePayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'reviewer',
          role: 'reviewer',
          summary: summary.slice(0, 280),
          reviewResult,
        };
        await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.completed',
          payload: completePayload,
        });
      }
    })();

    return ack;
  }

  /**
   * `delegate_deep_reviewer` — daemon-side Deep Reviewer launch.
   *
   * Same RPC/persistence/event shape as `handleDelegateReviewer`, but routes
   * through the multi-round investigation kernel (`runDeepReviewer`) instead of
   * the single-shot `runReviewer`. The deep reviewer reads surrounding code,
   * callers, and tests via a read-only tool loop before forming its opinion,
   * then returns the same `ReviewResult`.
   *
   * Tool loop wiring (the only structural difference from the simple reviewer):
   *   - `toolExec: makeDaemonExplorerToolExec({ role: 'reviewer' })` — the same
   *     read-only CLI-native executor the Explorer uses, gated on the reviewer
   *     role (which grants repo:read / pr:read / web:search — exactly the
   *     read-only surface).
   *   - `detectAllToolCalls` / `detectAnyToolCall: wrapCliDetect*` — the CLI
   *     detectors that produce the `DetectedToolCalls` shape the kernel expects.
   *   - `sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL` — overrides the kernel's
   *     built-in web-public-name tool block with the CLI-native names the
   *     detector + executor actually recognize. Without this the model would
   *     emit `repo_read` / `search` and the CLI detector would drop them, wasting
   *     rounds (the Explorer P1 from PR #284, avoided by construction here).
   *
   * Provider / model resolution honors `roleRouting.reviewer` (shared with the
   * simple reviewer); results persist to `reviewOutcomes` and surface through the
   * same `subagent.*` lifecycle, tagged `agent: 'deep_reviewer'`.
   *
   * Capability flag: `delegation_deep_reviewer_v1`.
   */
  async function handleDelegateDeepReviewer(req: any) {
    const sessionId = req.sessionId || req.payload?.sessionId;
    const providedToken = req.payload?.attachToken;
    const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
    const parentRunIdPayload =
      typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
    const rawContext =
      req.payload?.context && typeof req.payload.context === 'object'
        ? req.payload.context
        : undefined;

    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'INVALID_REQUEST',
        'diff is required and must be a non-empty string',
      );
    }

    let entry = activeSessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        activeSessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'delegate_deep_reviewer',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      );
    }

    // Provider/model routing — shared with the simple reviewer (roleRouting.reviewer).
    const reviewerRoute = entry.state.roleRouting?.reviewer;
    const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
    if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${routedProvider}" for reviewer role routing`,
      );
    }
    const sessionProvider = normalizeProviderInput(entry.state.provider);
    if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
      );
    }
    const resolvedProvider = routedProvider || sessionProvider;
    const resolvedModel =
      (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
      (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
      PROVIDER_CONFIGS[resolvedProvider].defaultModel;

    ensureRuntimeState(entry);

    const subagentId = `sub_deepreviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const childRunId = makeRunId();
    const parentRunId = parentRunIdPayload || entry.activeRunId || null;
    const abortController = new AbortController();
    const startedAt = Date.now();

    entry.activeDelegations.set(subagentId, {
      role: 'reviewer',
      agent: 'deep_reviewer',
      parentRunId,
      childRunId,
      abortController,
      startedAt,
      task: 'deep-review-diff',
    });

    const detail = `deep review diff (${diff.length} chars)`;
    const startEventPayload = {
      executionId: subagentId,
      subagentId,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId,
      agent: 'deep_reviewer',
      role: 'reviewer',
      detail,
    };
    await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
    await saveSessionState(entry.state);
    broadcastEvent(sessionId, {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: childRunId,
      seq: entry.state.eventSeq,
      ts: Date.now(),
      type: 'subagent.started',
      payload: startEventPayload,
    });

    const ack = makeResponse(req.requestId, 'delegate_deep_reviewer', sessionId, true, {
      subagentId,
      childRunId,
      accepted: true,
    });

    (async () => {
      let reviewResult = null;
      let runError = null;
      try {
        const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
        const signalAwareStream = (req: any) =>
          baseStream({
            ...req,
            signal: req.signal
              ? AbortSignal.any([req.signal, abortController.signal])
              : abortController.signal,
          });

        const callerGuidance =
          rawContext && typeof rawContext.reviewGuidance === 'string'
            ? rawContext.reviewGuidance
            : null;
        const reviewGuidance =
          callerGuidance ??
          (await resolveReviewGuidance({
            readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
          }));
        const reviewerContext = reviewGuidance
          ? { ...(rawContext ?? {}), reviewGuidance }
          : rawContext;

        // Read-only CLI-native tool loop, gated on the reviewer role.
        const toolExec = makeDaemonExplorerToolExec({
          entry,
          signal: abortController.signal,
          role: 'reviewer',
        });

        reviewResult = await runDeepReviewer(
          diff,
          {
            provider: resolvedProvider as any,
            stream: signalAwareStream,
            modelId: resolvedModel,
            context: reviewerContext,
            resolveRuntimeContext: async (_diff: any, context: any) =>
              buildReviewerContextBlock(context) || '',
            // The daemon investigates the LOCAL working tree, not a cloud
            // sandbox. We still pass a truthy sandboxId (the workspace path) so
            // the kernel does NOT inject its "No sandbox available — use GitHub
            // tools instead" guidance: that guidance is wrong here because (a)
            // our sandboxToolProtocol override advertises the local read tools
            // (read_file / search_files / …) the executor actually runs, and
            // (b) no GitHub tools are wired on this path. Without a truthy id the
            // model would be steered away from the only tools it has (Codex P2).
            // `sandboxId` is informational in the kernel (prompt guidance +
            // hasSandbox flag) — it's never used as a real sandbox handle; all
            // tool calls route through `toolExec` above.
            sandboxId: entry.state.cwd || 'local',
            allowedRepo: '',
            userProfile: null,
            toolExec,
            detectAllToolCalls: wrapCliDetectAllToolCalls,
            detectNativeToolCalls: wrapCliDetectNativeToolCalls,
            detectAnyToolCall: wrapCliDetectAnyToolCall,
            // Advertise the CLI-native read-only tool names (matches the
            // detector + executor); see the handler doc above. The block already
            // lists web_search, so the separate webSearchToolProtocol is unused.
            sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
            webSearchToolProtocol: '',
          } as any,
          {
            onStatus: () => {
              // Quiet for now — later slices can emit agent_status events.
            },
            signal: abortController.signal,
          },
        );
      } catch (err: any) {
        runError = err;
      }

      if (reviewResult) {
        if (!Array.isArray(entry.state.reviewOutcomes)) {
          entry.state.reviewOutcomes = [];
        }
        entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
      }

      const activeDelegation = entry.activeDelegations?.get(subagentId);
      if (!activeDelegation) {
        await saveSessionState(entry.state);
        return;
      }
      entry.activeDelegations.delete(subagentId);

      if (runError || !reviewResult) {
        const err = runError;
        const isAbort =
          err &&
          ((err instanceof Error && err.name === 'AbortError') ||
            (typeof err?.message === 'string' && err.message.includes('cancelled')));
        const message =
          err instanceof Error ? err.message : String(err ?? 'unknown deep reviewer error');
        const failPayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'deep_reviewer',
          role: 'reviewer',
          error: message,
          errorDetails: {
            code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
            message,
            retryable: false,
          },
        };
        await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.failed',
          payload: failPayload,
        });
      } else {
        const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
        const completePayload = {
          executionId: subagentId,
          subagentId,
          ...(parentRunId ? { parentRunId } : {}),
          childRunId,
          agent: 'deep_reviewer',
          role: 'reviewer',
          summary: summary.slice(0, 280),
          reviewResult,
        };
        await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
        await saveSessionState(entry.state);
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId: childRunId,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type: 'subagent.completed',
          payload: completePayload,
        });
      }
    })();

    return ack;
  }

  return {
    handleSubmitTaskGraph,
    handleDelegateExplorer,
    handleDelegateCoder,
    handleDelegateReviewer,
    handleDelegateDeepReviewer,
    handleCancelDelegation,
    setDelegateExplorerTestHooks,
  };
}
