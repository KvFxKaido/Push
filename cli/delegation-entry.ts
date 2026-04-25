// @ts-nocheck — spike module; typing follows cli/cli.ts convention.
/**
 * CLI delegation entry — headless orchestrator spike.
 *
 * Wires `plan_tasks` (via the shared `lib/planner-core.ts`) into the CLI's
 * headless path. The produced feature list is converted into a task graph
 * and executed in-process through `lib/task-graph.executeTaskGraph`.
 *
 * Spike scope decisions (see docs/decisions/Architecture Remediation Plan
 * §CLI Runtime Parity / Gap 3 Step 1):
 *
 * - In-process execution rather than pushd RPC. `handleSubmitTaskGraph`
 *   validates attach tokens and broadcasts events to attached clients —
 *   neither is needed for a headless single-process run. Calling
 *   `executeTaskGraph` directly skips the RPC plumbing. Promoting to RPC
 *   is a separate production step.
 *
 * - Minimum-viable executor: each task node runs the existing CLI
 *   `runAssistantLoop` on a scoped messages buffer with the node's task
 *   + enriched context. This is not the role-kernel (Explorer/Coder)
 *   executor used by `cli/pushd.ts:runExplorerForTaskGraph`. The spike
 *   measures the scope-shrinking hypothesis (narrow per-node prompts vs.
 *   one kitchen-sink prompt), not the role-kernel hypothesis.
 *
 * - CorrelationContext threading: graph-level context constructed at
 *   entry with `surface='cli'`, `sessionId`, `runId`, `taskGraphId`,
 *   `executionId`. Extended per-node with `taskId` and passed through
 *   `onProgress` event payloads. The CLI doesn't have tracing spine
 *   wired yet (plan step 3 territory), so the context is used for event
 *   payloads today.
 *
 * - Fail-open: planner returning `null` falls back to the non-delegated
 *   `runAssistantLoop` path. A delegation-specific failure ("we asked
 *   for a plan but the model gave us nothing") should not block the
 *   user's task.
 */

import process from 'node:process';
import { executeTaskGraph, validateTaskGraph } from '../lib/task-graph.js';
import type { TaskGraphNode } from '../lib/runtime-contract.js';
import type { CorrelationContext } from '../lib/correlation-context.js';
import { extendCorrelation } from '../lib/correlation-context.js';
import {
  runPlannerCore,
  formatPlannerBrief,
  type PlannerFeatureList,
} from '../lib/planner-core.js';
import type { LlmMessage, PushStream } from '../lib/provider-contract.js';
import { normalizeReasoning } from '../lib/reasoning-tokens.js';
import { setDefaultMemoryStore } from '../lib/context-memory-store.js';
import { createCliProviderStream } from './openai-stream.js';
import { type ProviderConfig } from './provider.js';
import { buildSystemPromptBase, runAssistantLoop } from './engine.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { appendSessionEvent, makeRunId, saveSessionState } from './session-store.js';
import { buildHeadlessTaskBrief } from './task-brief.js';
import { fmt } from './format.js';
import { createFileMemoryStore, getMemoryStoreBaseDir } from './context-memory-file-store.js';
import { resolveWorkspaceIdentity } from './workspace-identity.js';
import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from './task-graph-memory.js';
import { randomBytes } from 'node:crypto';

function mintGraphExecutionId() {
  return `graph_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Planner PushStream adapter
// ---------------------------------------------------------------------------

/**
 * Wrap the CLI's native OpenAI-compatible PushStream so the outer SIGINT
 * controller cancels the upstream call alongside `iteratePushStreamText`'s
 * own activity-reset signal.
 */
function buildPlannerPushStream(
  providerConfig: ProviderConfig,
  apiKey: string,
  signal: AbortSignal,
): PushStream<LlmMessage> {
  const stream = createCliProviderStream(providerConfig, apiKey);
  return (req) =>
    normalizeReasoning(
      stream({
        ...req,
        // Compose the outer SIGINT signal with the consumer's per-stream
        // signal (set by iteratePushStreamText for activity-reset timeouts).
        signal: req.signal ? AbortSignal.any([signal, req.signal]) : signal,
      }),
    );
}

// ---------------------------------------------------------------------------
// Feature list → task graph
// ---------------------------------------------------------------------------

function planToTaskGraph(plan: PlannerFeatureList): TaskGraphNode[] {
  return plan.features.map((f) => {
    // Read-first instruction. Without explicit priming, models fabricate
    // from general knowledge when the node brief reads as "produce X"
    // rather than "investigate then produce X" — even with tools exposed
    // in the system prompt.
    const parts: string[] = [
      'Ground your answer in the actual source code. Use list_dir to browse directories, search_files to find relevant code, and read_file to inspect specific files before producing any output. Do not answer from general knowledge.',
      '',
      f.description,
    ];
    if (f.files?.length) parts.push(`Input files to read first: ${f.files.join(', ')}`);
    if (f.verifyCommand) parts.push(`Verify with: ${f.verifyCommand}`);
    return {
      id: f.id,
      // Spike: all nodes run as coder. Explorer/Coder split is a follow-up
      // that requires per-node role classification in the planner output.
      agent: 'coder' as const,
      task: parts.join('\n'),
      files: f.files,
      dependsOn: f.dependsOn,
    };
  });
}

// ---------------------------------------------------------------------------
// Headless delegation entry
// ---------------------------------------------------------------------------

export async function runDelegatedHeadless(
  state,
  providerConfig,
  apiKey,
  task,
  maxRounds,
  jsonOutput,
  acceptanceChecks,
  { allowExec = false, safeExecPatterns = [], execMode = 'auto' } = {},
) {
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);

  const runId = makeRunId();
  const taskGraphId = mintGraphExecutionId();
  const executionId = taskGraphId;
  const graphCtx: CorrelationContext = {
    surface: 'cli',
    sessionId: state.sessionId,
    runId,
    taskGraphId,
    executionId,
  };

  try {
    // 1. Plan
    const plannerStream = buildPlannerPushStream(providerConfig, apiKey, ac.signal);
    const plan = await runPlannerCore({
      task,
      files: [],
      stream: plannerStream,
      provider: providerConfig.id,
      modelId: state.model || providerConfig.defaultModel,
      onStatus: (phase) => {
        if (!jsonOutput) process.stderr.write(`${fmt.dim(`[planner] ${phase}`)}\n`);
      },
    });

    await appendSessionEvent(
      state,
      'delegation.planner_complete',
      {
        ...graphCtx,
        featureCount: plan?.features.length ?? 0,
        approach: plan?.approach ?? null,
      },
      runId,
    );

    // 2. Fail-open fallback
    if (!plan || plan.features.length === 0) {
      if (!jsonOutput) {
        process.stderr.write(
          `${fmt.warn('[delegation]')} Planner returned no features; falling back to non-delegated loop.\n`,
        );
      }
      return runNonDelegatedFallback(
        state,
        providerConfig,
        apiKey,
        task,
        maxRounds,
        jsonOutput,
        acceptanceChecks,
        { allowExec, safeExecPatterns, execMode, signal: ac.signal, runId },
      );
    }

    if (!jsonOutput) {
      process.stderr.write(`${fmt.dim(formatPlannerBrief(plan))}\n\n`);
    }

    // 3. Build graph + validate. A model-generated plan can contain cycles,
    // duplicate ids, or dangling dependsOn; fail-open to the fallback path
    // rather than handing executeTaskGraph something it will silently skip.
    const nodes = planToTaskGraph(plan);
    const validationErrors = validateTaskGraph(nodes);
    if (validationErrors.length > 0) {
      if (!jsonOutput) {
        process.stderr.write(
          `${fmt.warn('[delegation]')} Planner produced an invalid graph (${validationErrors
            .map((e) => e.type)
            .join(', ')}); falling back.\n`,
        );
      }
      await appendSessionEvent(
        state,
        'delegation.graph_invalid',
        { ...graphCtx, errors: validationErrors },
        runId,
      );
      return runNonDelegatedFallback(
        state,
        providerConfig,
        apiKey,
        task,
        maxRounds,
        jsonOutput,
        acceptanceChecks,
        { allowExec, safeExecPatterns, execMode, signal: ac.signal, runId },
      );
    }

    await appendSessionEvent(
      state,
      'delegation.graph_started',
      { ...graphCtx, nodeCount: nodes.length },
      runId,
    );

    // Initialize the file-backed ContextMemoryStore once per headless
    // invocation so typed-memory writes persist across subsequent
    // `./push run --delegate` calls. Mirrors pushd's main() wiring —
    // both surfaces share the same on-disk layout under
    // getMemoryStoreBaseDir(), so records written here are also
    // visible to pushd task-graph runs and vice versa. Env-var
    // override PUSH_MEMORY_DIR lets tests and measurement scripts
    // isolate per-run stores.
    setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));

    // Resolve workspace identity once per graph for memory scoping.
    // resolveWorkspaceIdentity is non-throwing by contract (errors
    // become path.basename(cwd) / null fallbacks internally), so no
    // catch needed here — Copilot review on PR #333 caught that the
    // earlier catch fell back to state.cwd (an absolute path), which
    // would slip through the file store's path.join and write outside
    // baseDir.
    const workspaceIdentity = await resolveWorkspaceIdentity(state.cwd);
    // Deliberately omit chatId from the scope. Each `push run`
    // invocation mints a fresh state.sessionId, so passing it as
    // chatId means retrieval filters out records written by previous
    // runs (lib/context-memory-retrieval.ts:122,205). The
    // headless CLI has no UI primitive for "stay in the same chat
    // across invocations" — the workspace (repo+branch) is the
    // natural scope. Codex P1 review on PR #333 caught this — the
    // initial measurement signal (5→3 rounds) was variance, not
    // retrieval. taskGraphId still flows through as a same-graph
    // score boost (line 144), which is what within-graph node
    // sequencing needs.
    const graphMemoryScope = {
      repoFullName: workspaceIdentity.repoFullName,
      branch: workspaceIdentity.branch ?? undefined,
      taskGraphId: executionId,
    };

    // Snapshot the system message(s) so each node's scoped state can be
    // seeded from them. Messages and workingMemory are now scoped per-node
    // (see executor below) rather than mutated on `state`, so there is
    // nothing to restore at graph end — the parent's state.messages is
    // never touched by any node run.
    const originalMessages = state.messages.slice();

    const nodeSummaries = new Map<string, { summary: string; rounds: number }>();

    const executor = async (node, enrichedContext, signal) => {
      const nodeCtx = extendCorrelation(graphCtx, { taskId: node.id });

      // Per-node scoped state. Conversation-local fields (messages,
      // workingMemory) are owned by this node; session-wide fields
      // (sessionId, cwd, eventSeq, rounds, model) remain shared with
      // the parent state and are synced back after the node runs so
      // cross-node event sequencing and round accounting stay coherent.
      // Falls back to a freshly synthesized base prompt if the snapshot
      // had no system message — `ensureSystemPromptReady` silently
      // no-ops on an empty messages array, and that's the failure mode
      // this fix closes. This scoping is what lets future parallel
      // Explorer/Coder nodes coexist without stepping on each other's
      // messages; full parallel-safety also needs atomic eventSeq, but
      // that's out of scope until parallel execution actually arrives.
      const sysMsgs = originalMessages.filter((m) => m.role === 'system');
      const nodeState = {
        ...state,
        messages: sysMsgs.length
          ? [...sysMsgs]
          : [{ role: 'system' as const, content: buildSystemPromptBase(state.cwd) }],
        workingMemory: undefined,
      };

      const preamble = buildHeadlessTaskBrief(node.task, acceptanceChecks);

      // Retrieve typed memory scoped to this node (cross-session
      // persistent records) alongside the existing graph-internal
      // enrichedContext (fresh from completed dependency/sibling
      // nodes in this graph). Retrieval is error-isolated: a failure
      // returns null and the node runs without the memory block —
      // same graceful-degradation pattern as the write path.
      const retrievedBlock = await buildTypedMemoryBlockForNode({
        node,
        scope: graphMemoryScope,
      });
      const contextPieces: string[] = [];
      if (enrichedContext.length > 0) {
        contextPieces.push(`[Prior task context]\n${enrichedContext.join('\n\n')}`);
      }
      if (retrievedBlock) {
        contextPieces.push(retrievedBlock);
      }
      const contextBlock = contextPieces.length > 0 ? `${contextPieces.join('\n\n')}\n\n` : '';
      await appendUserMessageWithFileReferences(
        nodeState,
        `${contextBlock}${preamble}`,
        nodeState.cwd,
        { referenceSourceText: node.task },
      );

      await appendSessionEvent(
        nodeState,
        'delegation.node_started',
        { ...nodeCtx, task: node.task.slice(0, 280) },
        runId,
      );

      const result = await runAssistantLoop(nodeState, providerConfig, apiKey, maxRounds, {
        signal,
        emit: null,
        allowExec,
        safeExecPatterns,
        execMode,
        runId,
      });

      const summary = result.finalAssistantText || `[no summary — outcome=${result.outcome}]`;
      nodeSummaries.set(node.id, { summary, rounds: result.rounds });

      await appendSessionEvent(
        nodeState,
        'delegation.node_completed',
        {
          ...nodeCtx,
          outcome: result.outcome,
          rounds: result.rounds,
          summaryLength: summary.length,
        },
        runId,
      );

      // Sync session-wide bookkeeping back to the shared state so the
      // next node's spread starts from accurate counters and the parent's
      // graph-level events fire with correct seq.
      state.eventSeq = nodeState.eventSeq;
      state.rounds = nodeState.rounds;

      // Failed / cancelled outcomes capture the engine's
      // finalAssistantText as `summary` — for `outcome: 'error'`
      // that's the streamCompletion error text (e.g., a 120s
      // provider timeout), not a useful finding. Returning normally
      // here would let task-graph mark the node `completed` and
      // `writeTaskGraphResultMemory` would persist that error
      // message as a memory record, polluting future retrievals.
      // Throw instead so task-graph marks the node failed (or
      // cancelled, on AbortError shape), which makes
      // writeTaskGraphNodeMemory's `status === 'completed'` guard
      // skip the write. nodeSummaries already captured the message
      // above so synthesizeFinalSummary still surfaces what
      // happened. PR #333 follow-up — surfaced by the post-Fix-1
      // measurement when timeout messages started landing in the
      // store as records 1 and 6.
      if (result.outcome === 'aborted') {
        throw new DOMException('Cancelled by user', 'AbortError');
      }
      if (result.outcome === 'error') {
        // Cap the summary in the error message — `result.finalAssistantText`
        // for an error outcome can be a very long stream-error or
        // policy-halt blob, and this string lands in task-graph
        // node state's `error` field, the JSON output, and the
        // event log. Truncate so it stays grep-able. The full
        // summary is still in nodeSummaries.get(node.id) for the
        // final synthesis. Copilot review on PR #334.
        const ERROR_SUMMARY_MAX = 200;
        const truncated =
          summary.length > ERROR_SUMMARY_MAX
            ? `${summary.slice(0, ERROR_SUMMARY_MAX - 1)}…`
            : summary;
        throw new Error(`node ${node.id} failed: ${truncated}`);
      }

      return { summary, rounds: result.rounds };
    };

    const onProgress = (evt) => {
      if (jsonOutput) return;
      const ctx = evt.taskId ? extendCorrelation(graphCtx, { taskId: evt.taskId }) : graphCtx;
      const tag = fmt.dim(`[${evt.type} ${ctx.taskId || 'graph'}]`);
      process.stderr.write(`${tag} ${evt.detail || ''}\n`);
    };

    // 4. Execute. No finally-restore needed: per-node state is scoped
    // into nodeState inside the executor, so the parent state.messages
    // and state.workingMemory are never mutated by the graph run. A
    // throw inside executeTaskGraph leaves the parent conversation
    // state exactly as it was before the graph started.
    const result = await executeTaskGraph(nodes, executor, {
      signal: ac.signal,
      onProgress,
    });

    // 5. Persist typed memory for each completed node so the next
    // --delegate run on the same repo/branch can retrieve it.
    // Error-isolated per-node inside writeTaskGraphResultMemory.
    try {
      await writeTaskGraphResultMemory(result, graphMemoryScope);
    } catch (err) {
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

    await appendSessionEvent(
      state,
      'delegation.graph_completed',
      {
        ...graphCtx,
        success: result.success,
        aborted: result.aborted,
        totalRounds: result.totalRounds,
        wallTimeMs: result.wallTimeMs,
      },
      runId,
    );
    await saveSessionState(state);

    // 6. Emit final summary
    const finalText = synthesizeFinalSummary(plan, result, nodeSummaries);

    if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify(
          {
            sessionId: state.sessionId,
            runId,
            executionId,
            taskGraphId,
            outcome: result.aborted ? 'aborted' : result.success ? 'success' : 'delegation_failed',
            nodeCount: nodes.length,
            totalRounds: result.totalRounds,
            wallTimeMs: result.wallTimeMs,
            approach: plan.approach,
            summary: finalText,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${finalText}\n`);
    }

    if (result.aborted) return 130;
    return result.success ? 0 : 1;
  } catch (err) {
    await saveSessionState(state).catch(() => {});
    if (err && (err as Error).name === 'AbortError') return 130;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${fmt.error('[delegation error]')} ${message}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

// ---------------------------------------------------------------------------
// Non-delegated fallback (fail-open when planner returns no features)
// ---------------------------------------------------------------------------

async function runNonDelegatedFallback(
  state,
  providerConfig,
  apiKey,
  task,
  maxRounds,
  jsonOutput,
  acceptanceChecks,
  { allowExec, safeExecPatterns, execMode, signal, runId },
) {
  const taskPrompt = buildHeadlessTaskBrief(task, acceptanceChecks);
  await appendUserMessageWithFileReferences(state, taskPrompt, state.cwd, {
    referenceSourceText: task,
  });

  // Reuse the delegated runId so the fallback's events land on the same
  // correlation thread as the planner_complete event that preceded it.
  const result = await runAssistantLoop(state, providerConfig, apiKey, maxRounds, {
    signal,
    emit: null,
    allowExec,
    safeExecPatterns,
    execMode,
    runId,
  });
  await saveSessionState(state);

  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: state.sessionId,
          runId: result.runId || runId || null,
          outcome: result.outcome,
          rounds: result.rounds,
          assistant: result.finalAssistantText,
          fallback: 'planner_empty',
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${result.finalAssistantText}\n`);
  }

  if (result.outcome === 'aborted') return 130;
  return result.outcome === 'success' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// TUI-facing delegation entry
//
// Companion to `runDelegatedHeadless`: same planner-and-graph pipeline, but
// drives its UX through an `emit(event)` callback that produces canonical
// `subagent.*` / `task_graph.*` envelopes matching `lib/runtime-contract.ts`.
// This is what `engine.ts:runAssistantTurn` calls on every TUI user turn.
//
// Contract:
//   - On null/1-feature plan, returns `{ delegated: false }` so the caller
//     falls back to `runAssistantLoop` unchanged (preserves single-agent UX).
//   - On 2+ features, emits the full delegation event sequence, appends the
//     synthesized final summary to `state.messages` as an assistant reply,
//     and returns `{ delegated: true, runResult }` with a `run_complete`
//     envelope already emitted.
//   - Per-node engine runs pass `emit: null` to preserve the spike's
//     scope-shrinking contract (tool/token events from nodes do not leak
//     into the parent transcript).
// ---------------------------------------------------------------------------

export async function runUserTurnWithDelegation(
  state,
  providerConfig,
  apiKey,
  userText,
  maxRounds,
  options = {},
) {
  const {
    emit = null,
    signal,
    approvalFn,
    askUserFn,
    allowExec = false,
    safeExecPatterns = [],
    execMode = 'auto',
    runId: providedRunId,
  } = options;

  const runId = providedRunId || makeRunId();
  const taskGraphId = mintGraphExecutionId();
  const executionId = taskGraphId;
  const graphCtx: CorrelationContext = {
    surface: 'cli',
    sessionId: state.sessionId,
    runId,
    taskGraphId,
    executionId,
  };

  const dispatch = (type, payload) => {
    if (typeof emit === 'function') {
      emit({ type, payload, runId, sessionId: state.sessionId });
    }
  };

  // Planner subagent lifecycle. The dispatched `subagent.started` / `.completed`
  // pair gives the TUI visible proof that a planner call happened even when the
  // plan ends up fallback-only (null or 1 feature).
  const plannerExecutionId = `${executionId}_planner`;
  dispatch('subagent.started', {
    executionId: plannerExecutionId,
    agent: 'planner',
    detail: userText.slice(0, 200),
  });

  const plannerAc = signal ? undefined : new AbortController();
  const plannerSignal = signal ?? plannerAc!.signal;

  let plan: PlannerFeatureList | null = null;
  try {
    const plannerStream = buildPlannerPushStream(providerConfig, apiKey, plannerSignal);
    plan = await runPlannerCore({
      task: userText,
      files: [],
      stream: plannerStream,
      provider: providerConfig.id,
      modelId: state.model || providerConfig.defaultModel,
      onStatus: () => {},
    });
  } catch (err) {
    dispatch('subagent.failed', {
      executionId: plannerExecutionId,
      agent: 'planner',
      error: err instanceof Error ? err.message : String(err),
    });
    return { delegated: false };
  }

  dispatch('subagent.completed', {
    executionId: plannerExecutionId,
    agent: 'planner',
    summary: plan
      ? `Plan: ${plan.features.length} feature${plan.features.length === 1 ? '' : 's'}. ${plan.approach}`
      : 'No plan returned; falling back to single-agent.',
  });

  // Single-agent fallback: null plan, empty plan, or 1-feature plan. A
  // 1-feature plan offers no dependency structure worth rendering as a graph,
  // and forcing it through executeTaskGraph would replace the normal streaming
  // UX with a graph snapshot for no benefit. Brief requires "one-node graph
  // should feel identical to today's tool loop."
  if (!plan || plan.features.length <= 1) {
    return { delegated: false };
  }

  const nodes = planToTaskGraph(plan);
  const validationErrors = validateTaskGraph(nodes);
  if (validationErrors.length > 0) {
    dispatch('warning', {
      code: 'PLAN_INVALID',
      message: `Planner produced an invalid graph (${validationErrors
        .map((e) => e.type)
        .join(', ')}); falling back to single-agent.`,
    });
    await appendSessionEvent(
      state,
      'delegation.graph_invalid',
      { ...graphCtx, errors: validationErrors },
      runId,
    );
    return { delegated: false };
  }

  await appendSessionEvent(
    state,
    'delegation.graph_started',
    { ...graphCtx, nodeCount: nodes.length },
    runId,
  );

  dispatch('subagent.started', {
    executionId,
    agent: 'task_graph',
    detail: `Task graph: ${nodes.length} tasks`,
  });

  // Shared memory store + workspace scope — same rationale as headless path:
  // typed-memory writes from this graph persist and are retrievable by later
  // runs on the same repo/branch.
  setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));
  const workspaceIdentity = await resolveWorkspaceIdentity(state.cwd);
  const graphMemoryScope = {
    repoFullName: workspaceIdentity.repoFullName,
    branch: workspaceIdentity.branch ?? undefined,
    taskGraphId: executionId,
  };

  const originalMessages = state.messages.slice();
  const nodeSummaries = new Map<string, { summary: string; rounds: number }>();
  const nodeById = new Map<string, TaskGraphNode>(nodes.map((n) => [n.id, n]));

  // Compact per-node detail strings for `task_graph.task_ready` /
  // `task_graph.task_started` envelopes. `executeTaskGraph` sets
  // `evt.detail` to the full `state.node.task` (lib/task-graph.ts:170,373),
  // which in this flow contains the long "Ground your answer…" preamble
  // from `planToTaskGraph`. Passing that verbatim floods the TUI
  // delegation renderer with the entire prompt. Source the compact detail
  // from the planner's original `feature.description` (truncated to one
  // line) — Copilot review on PR #363.
  const TASK_DETAIL_MAX = 120;
  function compactDetail(description: string): string {
    const firstLine = description.split('\n', 1)[0].trim();
    if (firstLine.length <= TASK_DETAIL_MAX) return firstLine;
    return `${firstLine.slice(0, TASK_DETAIL_MAX - 1).trimEnd()}…`;
  }
  const compactDetailById = new Map<string, string>(
    plan.features.map((f) => [f.id, compactDetail(f.description)]),
  );

  const executor = async (node, enrichedContext, nodeSignal) => {
    const nodeCtx = extendCorrelation(graphCtx, { taskId: node.id });

    const sysMsgs = originalMessages.filter((m) => m.role === 'system');
    const nodeState = {
      ...state,
      messages: sysMsgs.length
        ? [...sysMsgs]
        : [{ role: 'system' as const, content: buildSystemPromptBase(state.cwd) }],
      workingMemory: undefined,
    };

    const preamble = buildHeadlessTaskBrief(node.task, undefined);
    const retrievedBlock = await buildTypedMemoryBlockForNode({
      node,
      scope: graphMemoryScope,
    });
    const contextPieces: string[] = [];
    if (enrichedContext.length > 0) {
      contextPieces.push(`[Prior task context]\n${enrichedContext.join('\n\n')}`);
    }
    if (retrievedBlock) {
      contextPieces.push(retrievedBlock);
    }
    const contextBlock = contextPieces.length > 0 ? `${contextPieces.join('\n\n')}\n\n` : '';
    await appendUserMessageWithFileReferences(
      nodeState,
      `${contextBlock}${preamble}`,
      nodeState.cwd,
      { referenceSourceText: node.task },
    );

    await appendSessionEvent(
      nodeState,
      'delegation.node_started',
      { ...nodeCtx, task: node.task.slice(0, 280) },
      runId,
    );

    // emit: null — spike's scope-shrinking hypothesis says per-node tool
    // events do not leak into the parent transcript. Delegation-level events
    // (subagent.*, task_graph.*) are what the TUI renders for progress.
    //
    // suppressRunComplete: true — each per-node runAssistantLoop would
    // otherwise persist its own `run_complete` session event. With N nodes
    // per delegated turn that makes `aggregateStats` (cli/stats.ts:105)
    // count N runs for one logical user turn and misreport outcomes when
    // nodes diverge. The delegation wrapper persists a single parent-level
    // `run_complete` below — it is the authoritative record for this turn.
    // Codex P2 review on PR #363.
    //
    // suppressEventPersist: true — `emit: null` hides per-node tool/token
    // events from live fan-out, but without this flag those same events
    // are still appended to the on-disk session log via
    // `appendSessionEvent`, so an `attach_session` reconnect that replays
    // from `lastSeenSeq` would surface node-internal events that attached
    // clients never saw live. Keep the log symmetric with the live stream:
    // only the delegation wrapper's `delegation.*` lifecycle envelopes and
    // the single parent `run_complete` are persisted for this turn.
    // Codex P2 review on PR #364.
    const result = await runAssistantLoop(nodeState, providerConfig, apiKey, maxRounds, {
      signal: nodeSignal,
      emit: null,
      allowExec,
      safeExecPatterns,
      execMode,
      runId,
      approvalFn,
      askUserFn,
      suppressRunComplete: true,
      suppressEventPersist: true,
    });

    const summary = result.finalAssistantText || `[no summary — outcome=${result.outcome}]`;
    nodeSummaries.set(node.id, { summary, rounds: result.rounds });

    await appendSessionEvent(
      nodeState,
      'delegation.node_completed',
      {
        ...nodeCtx,
        outcome: result.outcome,
        rounds: result.rounds,
        summaryLength: summary.length,
      },
      runId,
    );

    state.eventSeq = nodeState.eventSeq;
    state.rounds = nodeState.rounds;

    if (result.outcome === 'aborted') {
      throw new DOMException('Cancelled by user', 'AbortError');
    }
    if (result.outcome === 'error') {
      const ERROR_SUMMARY_MAX = 200;
      const truncated =
        summary.length > ERROR_SUMMARY_MAX
          ? `${summary.slice(0, ERROR_SUMMARY_MAX - 1)}…`
          : summary;
      throw new Error(`node ${node.id} failed: ${truncated}`);
    }

    return { summary, rounds: result.rounds };
  };

  // Translate internal TaskGraphProgressEvent shapes into canonical
  // task_graph.* envelopes. `graph_complete` is internal-only; we emit the
  // canonical graph_completed after executeTaskGraph returns so nodeCount /
  // totalRounds / wallTimeMs come from TaskGraphResult rather than a partial
  // progress event. Matches web handler pattern.
  const onProgress = (evt) => {
    const node = evt.taskId ? nodeById.get(evt.taskId) : null;
    switch (evt.type) {
      case 'task_ready':
        if (evt.taskId && node) {
          dispatch('task_graph.task_ready', {
            executionId,
            taskId: evt.taskId,
            agent: node.agent,
            detail: compactDetailById.get(evt.taskId) ?? evt.taskId,
          });
        }
        break;
      case 'task_started':
        if (evt.taskId && node) {
          dispatch('task_graph.task_started', {
            executionId,
            taskId: evt.taskId,
            agent: node.agent,
            detail: compactDetailById.get(evt.taskId) ?? evt.taskId,
          });
        }
        break;
      case 'task_completed':
        if (evt.taskId && node) {
          dispatch('task_graph.task_completed', {
            executionId,
            taskId: evt.taskId,
            agent: node.agent,
            summary: evt.detail ?? '',
            elapsedMs: evt.elapsedMs,
          });
        }
        break;
      case 'task_failed':
        if (evt.taskId && node) {
          dispatch('task_graph.task_failed', {
            executionId,
            taskId: evt.taskId,
            agent: node.agent,
            error: evt.detail ?? 'Task failed.',
            elapsedMs: evt.elapsedMs,
          });
        }
        break;
      case 'task_cancelled':
        if (evt.taskId && node) {
          dispatch('task_graph.task_cancelled', {
            executionId,
            taskId: evt.taskId,
            agent: node.agent,
            reason: evt.detail ?? 'Task cancelled.',
            elapsedMs: evt.elapsedMs,
          });
        }
        break;
      case 'graph_complete':
        break;
    }
  };

  let result;
  try {
    result = await executeTaskGraph(nodes, executor, { signal, onProgress });
  } catch (err) {
    dispatch('subagent.failed', {
      executionId,
      agent: 'task_graph',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    await writeTaskGraphResultMemory(result, graphMemoryScope);
  } catch {
    // Error-isolated per headless path; memory persistence failure must not
    // sink the delegation surface.
  }

  await appendSessionEvent(
    state,
    'delegation.graph_completed',
    {
      ...graphCtx,
      success: result.success,
      aborted: result.aborted,
      totalRounds: result.totalRounds,
      wallTimeMs: result.wallTimeMs,
    },
    runId,
  );

  const graphCompletionSummary = result.aborted
    ? 'Task graph cancelled by user.'
    : result.success
      ? 'All tasks completed.'
      : 'Some tasks failed.';

  dispatch('task_graph.graph_completed', {
    executionId,
    summary: graphCompletionSummary,
    success: result.success,
    aborted: result.aborted,
    nodeCount: result.nodeStates.size,
    totalRounds: result.totalRounds,
    wallTimeMs: result.wallTimeMs,
  });

  dispatch('subagent.completed', {
    executionId,
    agent: 'task_graph',
    summary: `${result.nodeStates.size} tasks, ${result.totalRounds} rounds, ${result.wallTimeMs}ms`,
  });

  // Append the synthesized summary as an assistant message so the transcript
  // has a natural final reply. Stream it in a single assistant_token so the
  // TUI's streamBuf → assistant_done flush path renders it identically to a
  // real assistant response.
  const finalText = synthesizeFinalSummary(plan, result, nodeSummaries);
  state.messages.push({ role: 'assistant' as const, content: finalText });

  dispatch('assistant_token', { text: finalText });
  const messageId = `asst_${Date.now().toString(36)}`;
  dispatch('assistant_done', { messageId });

  await saveSessionState(state);

  const runOutcome = result.aborted ? 'aborted' : result.success ? 'success' : 'error';
  // Persist the parent-level `run_complete`. Per-node runAssistantLoop calls
  // above pass `suppressRunComplete: true`, so this is the single
  // authoritative `run_complete` record for the delegated turn — matches
  // the single-agent path's accounting and keeps aggregateStats honest.
  await appendSessionEvent(
    state,
    'run_complete',
    {
      runId,
      outcome: runOutcome === 'error' ? 'failed' : runOutcome,
      summary: finalText.slice(0, 500),
      rounds: result.totalRounds,
    },
    runId,
  );
  dispatch('run_complete', {
    outcome: runOutcome === 'error' ? 'failed' : runOutcome,
    summary: finalText.slice(0, 500),
  });

  return {
    delegated: true,
    runResult: {
      outcome: runOutcome,
      finalAssistantText: finalText,
      rounds: result.totalRounds,
      runId,
    },
  };
}

// ---------------------------------------------------------------------------
// Summary synthesis
// ---------------------------------------------------------------------------

function synthesizeFinalSummary(
  plan: PlannerFeatureList,
  result,
  nodeSummaries: Map<string, { summary: string; rounds: number }>,
): string {
  const lines: string[] = [];
  lines.push(`Delegation complete — approach: ${plan.approach}`);
  lines.push('');
  for (const feature of plan.features) {
    const entry = nodeSummaries.get(feature.id);
    const nodeState = result.nodeStates?.get(feature.id);
    const status = nodeState?.status || 'unknown';
    lines.push(`[${feature.id}] (${status}) ${feature.description}`);
    if (entry?.summary) {
      lines.push(entry.summary);
    } else if (nodeState?.error) {
      lines.push(`  error: ${nodeState.error}`);
    }
    lines.push('');
  }
  lines.push(
    `Total: ${plan.features.length} features, ${result.totalRounds} rounds, ${result.wallTimeMs}ms`,
  );
  return lines.join('\n').trim();
}
