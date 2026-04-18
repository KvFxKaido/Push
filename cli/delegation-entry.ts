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
  type PlannerStreamFn,
} from '../lib/planner-core.js';
import { setDefaultMemoryStore } from '../lib/context-memory-store.js';
import { streamCompletion, type ProviderConfig } from './provider.js';
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
// Planner stream adapter
// ---------------------------------------------------------------------------

function buildPlannerStreamFn(
  providerConfig: ProviderConfig,
  apiKey: string,
  signal: AbortSignal,
): PlannerStreamFn {
  return async (messages, systemPrompt, modelId, { onToken, onDone, onError }) => {
    try {
      const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      // planner-core wraps this with its own activity-based timeout via
      // streamWithTimeout, so we don't pass one here (would double-enforce).
      await streamCompletion(
        providerConfig,
        apiKey,
        modelId || providerConfig.defaultModel,
        fullMessages,
        onToken,
        undefined,
        signal,
      );
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
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
    const plannerStreamFn = buildPlannerStreamFn(providerConfig, apiKey, ac.signal);
    const plan = await runPlannerCore({
      task,
      files: [],
      streamFn: plannerStreamFn,
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
    // Non-throwing contract — errors become fallbacks inside
    // resolveWorkspaceIdentity, but the catch here is belt-and-braces
    // for an unexpected rejection.
    const workspaceIdentity = await resolveWorkspaceIdentity(state.cwd).catch(() => ({
      repoFullName: state.cwd,
      branch: null,
    }));
    const graphMemoryScope = {
      repoFullName: workspaceIdentity.repoFullName,
      branch: workspaceIdentity.branch ?? undefined,
      chatId: state.sessionId,
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
