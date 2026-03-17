/**
 * Parallel Delegation — multi-task Coder fan-out with merge.
 *
 * Runs 2-3 Coder agents in isolated worker sandboxes, then merges
 * disjoint file changes back into the active sandbox. Extracted from
 * useChat.ts to keep the React hook lean and make this logic testable.
 */

import type {
  AcceptanceCriterion,
  ChatCard,
  CriterionResult,
  ParallelDelegationEnvelope,
  ParallelDelegationCallbacks,
  ParallelDelegationResult,
  ParallelDelegationTaskResult,
} from '@/types';
import {
  execInSandbox,
  batchWriteToSandbox,
  createSandbox,
  cleanupSandbox,
  downloadFromSandbox,
  downloadFileFromSandbox,
  hydrateSnapshotInSandbox,
  deleteFromSandbox,
} from './sandbox-client';
import { runCoderAgent, generateCheckpointAnswer } from './coder-agent';
import {
  parseParallelDelegationStatus,
  buildParallelDelegationMergePlan,
  type ParallelDelegationMergePlan,
  type ParallelDelegationMergeAssignment,
  type ParsedParallelDelegationChanges,
} from './parallel-delegation-merge';
import { formatElapsedTime } from './utils';
import type { ActiveProvider } from './orchestrator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PARALLEL_DELEGATE_TASKS = 3;
const WORKER_STAGGER_MS = 1500;
const MAX_SETUP_ATTEMPTS = 2;
const BATCH_WRITE_CHUNK_SIZE = 20;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SandboxWorkspaceFingerprint {
  head: string;
  status: string;
  workspaceRevision: number | null;
}

interface ParallelMergeWritePayload {
  path: string;
  content: string;
  workerIndex: number;
}

interface ErrorWithElapsed extends Error {
  elapsedMs?: number;
}

interface SuccessfulWorker {
  taskIndex: number;
  workerSandboxId: string;
  elapsedMs: number;
  coderResult: Awaited<ReturnType<typeof runCoderAgent>>;
  workerChanges: ParsedParallelDelegationChanges;
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwParallelDelegationAbort(): never {
  throw new DOMException('Coder cancelled by user.', 'AbortError');
}

// ---------------------------------------------------------------------------
// Sandbox fingerprinting
// ---------------------------------------------------------------------------

function parseSandboxWorkspaceFingerprint(
  stdout: string,
  workspaceRevision?: number,
): SandboxWorkspaceFingerprint {
  const sections: Record<string, string[]> = {};
  let currentSection: 'head' | 'status' | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '---HEAD---') {
      currentSection = 'head';
      sections.head = [];
      continue;
    }
    if (trimmed === '---STATUS---') {
      currentSection = 'status';
      sections.status = [];
      continue;
    }
    if (currentSection) {
      sections[currentSection].push(line.replace(/\r$/, ''));
    }
  }

  return {
    head: (sections.head || []).join('\n').trim(),
    status: (sections.status || []).join('\n').trim(),
    workspaceRevision: typeof workspaceRevision === 'number' ? workspaceRevision : null,
  };
}

async function getSandboxWorkspaceFingerprint(sandboxId: string): Promise<SandboxWorkspaceFingerprint> {
  const result = await execInSandbox(
    sandboxId,
    'cd /workspace && echo "---HEAD---" && git rev-parse --short HEAD 2>/dev/null && echo "---STATUS---" && git status --porcelain=1 --untracked-files=all 2>/dev/null',
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.error || 'Failed to read sandbox workspace fingerprint.');
  }
  return parseSandboxWorkspaceFingerprint(result.stdout || '', result.workspaceRevision);
}

function sameSandboxWorkspaceFingerprint(
  left: SandboxWorkspaceFingerprint,
  right: SandboxWorkspaceFingerprint,
): boolean {
  return left.head === right.head
    && left.status === right.status
    && left.workspaceRevision === right.workspaceRevision;
}

// ---------------------------------------------------------------------------
// Worker changes collection
// ---------------------------------------------------------------------------

async function collectParallelWorkerChanges(
  sandboxId: string,
): Promise<ParsedParallelDelegationChanges> {
  const result = await execInSandbox(
    sandboxId,
    'cd /workspace && git status --porcelain=1 --untracked-files=all 2>/dev/null',
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.error || 'Failed to inspect worker sandbox changes.');
  }
  return parseParallelDelegationStatus(result.stdout || '');
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function decodeSandboxTextFile(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function loadParallelMergeWritePayloads(
  workerSandboxIdsByTask: string[],
  writes: ParallelDelegationMergeAssignment[],
): Promise<ParallelMergeWritePayload[]> {
  const payloads: ParallelMergeWritePayload[] = [];

  for (const write of writes) {
    const sandboxId = workerSandboxIdsByTask[write.workerIndex];
    if (!sandboxId) {
      throw new Error(`Missing worker sandbox for task ${write.workerIndex + 1}.`);
    }
    const download = await downloadFileFromSandbox(sandboxId, write.path);
    if (!download.ok || !download.fileBase64) {
      throw new Error(download.error || `Failed to fetch ${write.path} from worker sandbox.`);
    }
    let content: string;
    try {
      content = decodeSandboxTextFile(download.fileBase64);
    } catch {
      throw new Error(`Parallel merge only supports UTF-8 text files today; ${write.path} could not be decoded safely.`);
    }
    payloads.push({ path: write.path, content, workerIndex: write.workerIndex });
  }

  return payloads;
}

async function applyParallelMergeWrites(
  sandboxId: string,
  writes: ParallelMergeWritePayload[],
  expectedWorkspaceRevision?: number,
): Promise<number | undefined> {
  let currentWorkspaceRevision = expectedWorkspaceRevision;

  for (const chunk of chunkArray(writes, BATCH_WRITE_CHUNK_SIZE)) {
    const result = await batchWriteToSandbox(
      sandboxId,
      chunk.map((entry) => ({ path: entry.path, content: entry.content })),
      currentWorkspaceRevision,
    );
    if (!result.ok) {
      const errorEntry = result.results.find((entry) => !entry.ok);
      throw new Error(errorEntry?.error || result.error || 'Parallel merge write failed.');
    }
    currentWorkspaceRevision = result.workspace_revision;
  }
  return currentWorkspaceRevision;
}

async function applyParallelMergeDeletes(
  sandboxId: string,
  deletes: ParallelDelegationMergeAssignment[],
  expectedWorkspaceRevision?: number,
): Promise<number | undefined> {
  let currentWorkspaceRevision = expectedWorkspaceRevision;
  for (const entry of deletes) {
    currentWorkspaceRevision = await deleteFromSandbox(sandboxId, entry.path, currentWorkspaceRevision);
  }
  return currentWorkspaceRevision;
}

async function runParallelMergeChecks(
  sandboxId: string,
  acceptanceCriteria?: AcceptanceCriterion[],
): Promise<CriterionResult[]> {
  const checks: AcceptanceCriterion[] = [
    {
      id: 'merge_diff_check',
      check: 'cd /workspace && git diff --check --no-color',
      description: 'Merged workspace passes git diff --check',
    },
    ...(acceptanceCriteria || []),
  ];

  const results: CriterionResult[] = [];
  for (const criterion of checks) {
    try {
      const checkResult = await execInSandbox(sandboxId, criterion.check);
      const expectedExit = criterion.exitCode ?? 0;
      results.push({
        id: criterion.id,
        passed: checkResult.exitCode === expectedExit,
        exitCode: checkResult.exitCode,
        output: (checkResult.stdout + '\n' + checkResult.stderr).trim().slice(0, 2000),
      });
    } catch (err) {
      results.push({
        id: criterion.id,
        passed: false,
        exitCode: -1,
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function formatParallelMergeChecks(results: CriterionResult[]): string {
  if (results.length === 0) return 'No combined checks were run.';
  const passed = results.filter((result) => result.passed).length;
  const lines = [`Combined checks: ${passed}/${results.length} passed.`];
  for (const result of results) {
    lines.push(`- ${result.passed ? 'PASS' : 'FAIL'} ${result.id} (exit=${result.exitCode})${result.passed || !result.output ? '' : `: ${result.output.slice(0, 200)}`}`);
  }
  return lines.join('\n');
}

function getTaskStatusLabel(criteriaResults?: CriterionResult[]): 'OK' | 'CHECKS_FAILED' {
  if (!criteriaResults || criteriaResults.length === 0) return 'OK';
  const allPassed = criteriaResults.every((r) => r.passed);
  return allPassed ? 'OK' : 'CHECKS_FAILED';
}

// ---------------------------------------------------------------------------
// Merge target selection
// ---------------------------------------------------------------------------

/**
 * Pick the worker with the most file changes as the merge target.
 * Its changes are already in-place, minimizing cross-worker file transfers.
 * Tie-break: lowest task index for determinism.
 */
function pickMergeTarget(
  successfulWorkers: SuccessfulWorker[],
  mergePlan: ParallelDelegationMergePlan,
): number {
  const changeCounts = new Map<number, number>();
  for (const w of mergePlan.writes) {
    changeCounts.set(w.workerIndex, (changeCounts.get(w.workerIndex) || 0) + 1);
  }
  for (const d of mergePlan.deletes) {
    changeCounts.set(d.workerIndex, (changeCounts.get(d.workerIndex) || 0) + 1);
  }

  let bestIndex = successfulWorkers[0].taskIndex;
  let bestCount = changeCounts.get(bestIndex) || 0;
  for (const worker of successfulWorkers) {
    const count = changeCounts.get(worker.taskIndex) || 0;
    if (count > bestCount) {
      bestCount = count;
      bestIndex = worker.taskIndex;
    }
  }
  return bestIndex;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runParallelDelegation(
  envelope: ParallelDelegationEnvelope,
  callbacks: ParallelDelegationCallbacks,
): Promise<ParallelDelegationResult> {
  const {
    tasks,
    files,
    acceptanceCriteria,
    intent,
    constraints,
    branchContext,
    provider,
    model,
    projectInstructions,
    instructionFilename,
    activeSandboxId,
    sourceRepo,
    sourceBranch,
    authToken,
    appCommitIdentity,
    recentChatHistory,
  } = envelope;

  const workerSandboxIds: string[] = [];
  const workerSandboxIdsByTask: string[] = [];
  const allCards: ChatCard[] = [];
  const taskResults: ParallelDelegationTaskResult[] = [];
  let totalRounds = 0;
  let totalCheckpoints = 0;

  const parallelStartTime = Date.now();

  try {
    if (callbacks.signal?.aborted) {
      throwParallelDelegationAbort();
    }

    // 1. Capture baseline fingerprint + snapshot
    callbacks.onStatus('Preparing parallel coder workers...');

    const baseFingerprint = await getSandboxWorkspaceFingerprint(activeSandboxId);
    const snapshot = await downloadFromSandbox(activeSandboxId, '/workspace');
    if (!snapshot.ok || !snapshot.archiveBase64) {
      throw new Error(snapshot.error || 'Failed to capture workspace snapshot for parallel delegation.');
    }
    const snapshotArchiveBase64 = snapshot.archiveBase64;

    // 2. Fan out — create workers, restore snapshot, run Coders
    const settledResults = await Promise.allSettled(
      tasks.map(async (task, taskIndex) => {
        const taskStartTime = Date.now();
        const prefix = `[${taskIndex + 1}/${tasks.length}] `;

        // Stagger worker setup to avoid thundering-herd on Modal endpoints
        if (taskIndex > 0) {
          await new Promise<void>((r) => setTimeout(r, taskIndex * WORKER_STAGGER_MS));
        }

        if (callbacks.signal?.aborted) {
          throwParallelDelegationAbort();
        }

        callbacks.onStatus(`${prefix}Starting worker sandbox...`);

        // Create worker sandbox + restore snapshot with retry
        let workerSandboxId = '';
        for (let setupAttempt = 0; setupAttempt < MAX_SETUP_ATTEMPTS; setupAttempt++) {
          const workerSession = await createSandbox(sourceRepo, sourceBranch, authToken, appCommitIdentity);
          if (workerSession.status === 'error' || !workerSession.sandboxId) {
            throw new Error(workerSession.error || `Failed to create worker sandbox for task ${taskIndex + 1}.`);
          }
          const candidateId = workerSession.sandboxId;
          workerSandboxIds.push(candidateId);

          try {
            const restore = await hydrateSnapshotInSandbox(candidateId, snapshotArchiveBase64, '/workspace');
            if (!restore.ok) {
              throw new Error(restore.error || `Failed to restore worker snapshot for task ${taskIndex + 1}.`);
            }
            workerSandboxId = candidateId;
            workerSandboxIdsByTask[taskIndex] = candidateId;
            break;
          } catch (restoreErr) {
            try { await cleanupSandbox(candidateId); } catch { /* best effort */ }
            if (setupAttempt === 0) {
              callbacks.onStatus(`${prefix}Retrying worker setup...`);
              continue;
            }
            throw restoreErr;
          }
        }

        if (!workerSandboxId) {
          throw new Error(`Worker sandbox setup failed for task ${taskIndex + 1} after retries.`);
        }

        // Checkpoint callback: generates answers using the Orchestrator's LLM
        const handleCheckpoint = async (question: string, context: string): Promise<string> => {
          callbacks.onStatus(`${prefix}Coder checkpoint`, question);
          const answer = await generateCheckpointAnswer(
            question,
            context,
            recentChatHistory.slice(-6),
            callbacks.signal,
            provider as ActiveProvider,
            model || undefined,
          );
          callbacks.onStatus(`${prefix}Coder resuming...`);
          return answer;
        };

        try {
          const coderResult = await runCoderAgent(
            task,
            workerSandboxId,
            files,
            (phase, detail) => {
              callbacks.onStatus(`${prefix}${phase}`, detail);
            },
            projectInstructions || undefined,
            callbacks.signal,
            handleCheckpoint,
            acceptanceCriteria,
            (state) => { callbacks.onWorkingMemoryUpdate?.(state); },
            provider as ActiveProvider,
            model || undefined,
            {
              intent,
              constraints,
              branchContext,
              instructionFilename,
            },
          );
          const workerChanges = await collectParallelWorkerChanges(workerSandboxId);
          const taskElapsedMs = Date.now() - taskStartTime;
          return { taskIndex, workerSandboxId, coderResult, elapsedMs: taskElapsedMs, workerChanges };
        } catch (taskErr) {
          if (isAbortError(taskErr) || callbacks.signal?.aborted) {
            throwParallelDelegationAbort();
          }
          const taskElapsedMs = Date.now() - taskStartTime;
          const wrapped = new Error(
            taskErr instanceof Error ? taskErr.message : String(taskErr),
          );
          (wrapped as ErrorWithElapsed).elapsedMs = taskElapsedMs;
          throw wrapped;
        }
      }),
    );

    const parallelElapsedMs = Date.now() - parallelStartTime;

    if (callbacks.signal?.aborted || settledResults.some((result) => result.status === 'rejected' && isAbortError(result.reason))) {
      throwParallelDelegationAbort();
    }

    // 3. Aggregate results
    let succeededCount = 0;
    let failedCount = 0;
    const successfulWorkers: SuccessfulWorker[] = [];
    let canAutoMerge = true;

    settledResults.forEach((result, taskIndex) => {
      if (result.status === 'fulfilled') {
        const { coderResult, elapsedMs, workerSandboxId, workerChanges } = result.value;
        totalRounds += coderResult.rounds;
        totalCheckpoints += coderResult.checkpoints;
        const statusLabel = getTaskStatusLabel(coderResult.criteriaResults);
        if (statusLabel === 'OK') {
          succeededCount++;
          successfulWorkers.push({ taskIndex, workerSandboxId, elapsedMs, coderResult, workerChanges });
        } else {
          failedCount++;
          canAutoMerge = false;
        }
        taskResults.push({
          taskIndex,
          status: statusLabel,
          summary: coderResult.summary,
          elapsedMs,
          cards: coderResult.cards,
          rounds: coderResult.rounds,
          checkpoints: coderResult.checkpoints,
          criteriaResults: coderResult.criteriaResults,
        });
        allCards.push(...coderResult.cards);
      } else {
        failedCount++;
        canAutoMerge = false;
        const reason = result.reason;
        const errorMsg = reason instanceof Error ? reason.message : String(reason);
        const elapsedMs = (reason as ErrorWithElapsed)?.elapsedMs;
        taskResults.push({
          taskIndex,
          status: 'FAILED',
          summary: errorMsg,
          elapsedMs: elapsedMs ?? 0,
          cards: [],
          rounds: 0,
          checkpoints: 0,
        });
      }
    });

    const wallTime = formatElapsedTime(parallelElapsedMs);
    const mergePrefix = `\n[Parallel] ${succeededCount} succeeded, ${failedCount} failed — wall time ${wallTime}.`;

    // 4. Merge phase
    if (!canAutoMerge) {
      return {
        outcome: 'partial_failure',
        tasks: taskResults,
        totalRounds,
        totalCheckpoints,
        cards: allCards,
        mergeNote: `${mergePrefix} Tasks remained isolated because at least one worker failed or did not pass its own checks.`,
        wallTimeMs: parallelElapsedMs,
        filesMerged: 0,
      };
    }

    const mergePlan = buildParallelDelegationMergePlan(
      successfulWorkers.map(({ taskIndex, workerChanges }) => ({
        workerIndex: taskIndex,
        changes: workerChanges.changes,
        unsupported: workerChanges.unsupported,
      })),
    );

    if (!mergePlan.mergeable) {
      const reasons = [
        ...mergePlan.conflicts.map((path) => `overlap: ${path}`),
        ...mergePlan.unsupported,
      ];
      return {
        outcome: 'merge_conflicts',
        tasks: taskResults,
        totalRounds,
        totalCheckpoints,
        cards: allCards,
        mergeNote: `${mergePrefix} Auto-merge skipped because the worker results were not safely disjoint.\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
        wallTimeMs: parallelElapsedMs,
        filesMerged: 0,
      };
    }

    // 5. Merge — promote one worker as merge target, apply others' changes
    try {
      const mergeTargetIndex = pickMergeTarget(successfulWorkers, mergePlan);
      const mergeTargetWorker = successfulWorkers.find((w) => w.taskIndex === mergeTargetIndex)!;
      const mergeTargetSandboxId = mergeTargetWorker.workerSandboxId;

      // Writes/deletes from OTHER workers (merge target already has its own changes)
      const otherWorkerWrites = mergePlan.writes.filter((w) => w.workerIndex !== mergeTargetIndex);
      const otherWorkerDeletes = mergePlan.deletes.filter((d) => d.workerIndex !== mergeTargetIndex);

      if (otherWorkerWrites.length > 0 || otherWorkerDeletes.length > 0) {
        callbacks.onStatus('Applying disjoint worker changes to merge target...');
        const otherWritePayloads = await loadParallelMergeWritePayloads(workerSandboxIdsByTask, otherWorkerWrites);
        const mergeRevision = await applyParallelMergeWrites(mergeTargetSandboxId, otherWritePayloads);
        await applyParallelMergeDeletes(mergeTargetSandboxId, otherWorkerDeletes, mergeRevision);
      }

      // Run checks on the merge target
      callbacks.onStatus('Verifying merged workspace...');
      const mergeChecks = await runParallelMergeChecks(mergeTargetSandboxId, acceptanceCriteria);
      const mergeChecksPassed = mergeChecks.every((r) => r.passed);

      if (!mergeChecksPassed) {
        return {
          outcome: 'merge_checks_failed',
          tasks: taskResults,
          totalRounds,
          totalCheckpoints,
          cards: allCards,
          mergeNote: `${mergePrefix} Auto-merge verification failed, so nothing was applied to the active workspace.\n${formatParallelMergeChecks(mergeChecks)}`,
          wallTimeMs: parallelElapsedMs,
          mergeCheckResults: mergeChecks,
          filesMerged: 0,
        };
      }

      // Verify active sandbox hasn't changed
      const activeFingerprint = await getSandboxWorkspaceFingerprint(activeSandboxId);
      const currentActiveSandboxId = callbacks.getActiveSandboxId?.() ?? activeSandboxId;
      if (currentActiveSandboxId !== activeSandboxId || !sameSandboxWorkspaceFingerprint(baseFingerprint, activeFingerprint)) {
        return {
          outcome: 'active_changed',
          tasks: taskResults,
          totalRounds,
          totalCheckpoints,
          cards: allCards,
          mergeNote: `${mergePrefix} Merge verification passed, but the active workspace changed during fan-out, so the merged result was not applied automatically.\n${formatParallelMergeChecks(mergeChecks)}`,
          wallTimeMs: parallelElapsedMs,
          mergeCheckResults: mergeChecks,
          filesMerged: 0,
        };
      }

      // Apply ALL changes to the active sandbox
      if (callbacks.signal?.aborted) {
        throwParallelDelegationAbort();
      }

      callbacks.onStatus('Applying merged workspace...');
      const allWritePayloads = await loadParallelMergeWritePayloads(workerSandboxIdsByTask, mergePlan.writes);
      let activeWorkspaceRevision = baseFingerprint.workspaceRevision ?? undefined;
      activeWorkspaceRevision = await applyParallelMergeWrites(activeSandboxId, allWritePayloads, activeWorkspaceRevision);
      await applyParallelMergeDeletes(activeSandboxId, mergePlan.deletes, activeWorkspaceRevision);

      const mergedPaths = mergePlan.writes.length + mergePlan.deletes.length;
      return {
        outcome: 'merged',
        tasks: taskResults,
        totalRounds,
        totalCheckpoints,
        cards: allCards,
        mergeNote: `${mergePrefix} Auto-merged ${mergedPaths} file${mergedPaths === 1 ? '' : 's'} into the active workspace.\n${formatParallelMergeChecks(mergeChecks)}`,
        wallTimeMs: parallelElapsedMs,
        mergeCheckResults: mergeChecks,
        filesMerged: mergedPaths,
      };
    } catch (mergeErr) {
      const message = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      return {
        outcome: 'merge_error',
        tasks: taskResults,
        totalRounds,
        totalCheckpoints,
        cards: allCards,
        mergeNote: `${mergePrefix} Auto-merge failed after fan-in, so the worker results were left isolated.\n- ${message}`,
        wallTimeMs: Date.now() - parallelStartTime,
        filesMerged: 0,
      };
    }
  } catch (err) {
    if (isAbortError(err)) {
      throwParallelDelegationAbort();
    }

    // Setup failure — caller should fall back to sequential
    console.error('[Parallel Delegation Failure]', err);
    return {
      outcome: 'setup_failed',
      tasks: taskResults,
      totalRounds,
      totalCheckpoints,
      cards: allCards,
      mergeNote: '',
      wallTimeMs: Date.now() - parallelStartTime,
      filesMerged: 0,
    };
  } finally {
    // Best-effort cleanup of all worker sandboxes
    await Promise.all(workerSandboxIds.map(async (id) => {
      try {
        await cleanupSandbox(id);
      } catch {
        // Best effort — containers auto-terminate after 30 min anyway.
      }
    }));
  }
}
