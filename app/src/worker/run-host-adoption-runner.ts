/**
 * Adopted-run loop runner — Durable Runs (Adopt-on-Silence), Phase 2 loop.
 *
 * Continues an adopted run server-side by seeding the coder kernel
 * (`@push/lib/coder-agent`) from the run's stored `RunCheckpointV1` and the
 * proven CoderJob adapter stack (stream / executor / detector adapters call
 * the Worker handlers as functions with `env` — no HTTP self-loop, no
 * credentials leaving the isolate). The `RunHost` DO owns storage, alarms,
 * and the HTTP surface; this module owns provisioning and the loop lifecycle
 * so it stays unit-testable behind a small hooks facade.
 *
 * Credential provisioning is OUT-OF-BAND by design (the CoderJobStartInput
 * precedent): the checkpoint carries the sandbox *identity*
 * (`sandboxSessionId`), and `provisionAdoption` re-derives the owner token
 * from the SANDBOX_TOKENS KV at adoption time. Provider keys live in Worker
 * env and never appear here. The deployment origin is server-derived (route
 * layer stamp persisted on the record), never client-trusted.
 *
 * Loop lifecycle (every branch logs — symmetric structured logs):
 *
 *   run_host_run_adopted        — emitted by the DO when the loop launches
 *   run_host_loop_checkpoint_persisted ↔ _oversize ↔ _invalid
 *   run_host_loop_completed     — kernel finished; run → `ended`
 *   run_host_loop_paused        — supervised approval gate; run stays
 *                                 `adopted` with `pausedForApproval` set
 *   run_host_loop_reclaimed     — a client re-registered (or the run was
 *                                 released/expired) mid-loop; the loop stops
 *                                 without writing
 *   run_host_loop_failed        — kernel threw; run parks `adoptable`, with
 *                                 a bounded retry alarm while the relaunch
 *                                 cap allows
 *
 * Reclaim contract: register always wins. The loop checks ownership
 * (`record.adoptionId`) on every per-round checkpoint and the DO aborts the
 * loop's controller the moment a register/release lands, so at most one
 * already-in-flight tool call can overlap a reclaim — the same bounded race
 * the CoderJob orphan path documents.
 */

import type { AIProviderType, LlmMessage, PushStream } from '@push/lib/provider-contract';
import {
  runCoderAgent,
  type CoderAgentOptions,
  type CoderCheckpointState,
} from '@push/lib/coder-agent';
import {
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderTurnContext,
} from '@push/lib/coder-agent-bindings';
import { CapabilityLedger, ROLE_CAPABILITIES } from '@push/lib/capabilities';
import { resolveCoderCompletionGuard } from '@push/lib/coder-policy';
import { classifyTurnIntent } from '@push/lib/turn-intent';
import {
  ADOPTION_EXTRA_ROUNDS,
  buildAdoptionDetectors,
  coderStateToRunCheckpoint,
  createAdoptionToolGate,
  runCheckpointToCoderResumeState,
} from '@push/lib/run-adoption-loop';
import {
  RUN_HOST_ADOPTED_WATCHDOG_MS,
  RUN_HOST_MAX_ADOPTION_RELAUNCHES,
  checkpointExceedsHostCap,
  type RunHostRecord,
  type RunHostResolvedApproval,
} from '@push/lib/run-host-adoption';
import {
  estimateRunCheckpointBytes,
  validateRunCheckpoint,
  type RunCheckpointPendingApproval,
  type RunCheckpointV1,
} from '@push/lib/run-checkpoint';
import { formatVerificationPolicyBlock } from '@push/lib/verification-policy';
import type { ChatCard } from '@/types';
import { buildApprovalModeBlock } from '@/lib/approval-mode';
import { getSandboxToolProtocol } from '@/lib/sandbox-tool-detection';
import { WEB_SEARCH_TOOL_PROTOCOL } from '@/lib/web-search-tools';
import { createWebDetectorAdapter, type AnyToolCall } from './coder-job-detector-adapter';
import { createWebExecutorAdapter } from './coder-job-executor-adapter';
import { createWebStreamAdapter, resolveProviderHandler } from './coder-job-stream-adapter';
import { buildCoderJobServices } from './coder-job-services';
import { readOwnerToken } from './sandbox-token-store';
import type { Env } from './worker-middleware';

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

// ---------------------------------------------------------------------------
// Provisioning — everything the checkpoint deliberately does NOT carry
// ---------------------------------------------------------------------------

export type ProvisionResult =
  | { ok: true; origin: string; sandboxId: string; ownerToken: string }
  | {
      ok: false;
      reason:
        | 'no_origin'
        | 'no_sandbox_session'
        | 'no_sandbox_credentials'
        | 'unsupported_provider';
    };

/**
 * Resolve the out-of-band pieces an adoption needs. Fails closed with a
 * stable reason token (the DO logs it as `run_host_adoption_blocked`) so a
 * blocked adoption parks `adoptable` loudly instead of half-starting.
 *
 * Trust note: the sandbox binding rides on `sandboxSessionId` from the
 * checkpoint, which the (session-gated) client supplied. That id is a
 * high-entropy UUID a client only learns by creating the sandbox — the same
 * property the rest of the sandbox surface leans on, with the owner-token
 * layer as defense in depth. The token itself never transits a client on
 * this path.
 */
export async function provisionAdoption(
  env: Env,
  record: RunHostRecord,
  checkpoint: RunCheckpointV1,
): Promise<ProvisionResult> {
  if (!record.origin) {
    return { ok: false, reason: 'no_origin' };
  }
  const sandboxId = checkpoint.sandboxSessionId;
  if (!sandboxId) {
    return { ok: false, reason: 'no_sandbox_session' };
  }
  const ownerToken = await readOwnerToken(env.SANDBOX_TOKENS, sandboxId);
  if (!ownerToken) {
    return { ok: false, reason: 'no_sandbox_credentials' };
  }
  const zenGo = checkpoint.provider === 'zen' && checkpoint.providerOptions?.zenGo === true;
  if (!resolveProviderHandler(checkpoint.provider as AIProviderType, zenGo)) {
    return { ok: false, reason: 'unsupported_provider' };
  }
  return { ok: true, origin: record.origin, sandboxId, ownerToken };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Storage/alarm facade the DO hands the runner — keeps this module free of
 * DO types and testable without storage mocking gymnastics. */
export interface AdoptionHostHooks {
  loadRecord: () => Promise<RunHostRecord | null>;
  saveRecord: (record: RunHostRecord) => Promise<void>;
  saveCheckpoint: (checkpoint: RunCheckpointV1) => Promise<void>;
  armAlarm: (at: number) => Promise<void>;
  clearAlarm: () => Promise<void>;
}

export interface RunAdoptedLoopArgs {
  env: Env;
  /** The record as persisted at launch — state `adopted`, `adoptionId` set. */
  record: RunHostRecord;
  /** The adoption-source checkpoint. */
  checkpoint: RunCheckpointV1;
  origin: string;
  sandboxId: string;
  ownerToken: string;
  /** A user decision on the gate this relaunch resumes from (Phase 3 attach
   * controls): seeds the resolution note in the transcript and configures
   * the tool gate's one-shot grant / sticky denial. */
  resolvedApproval?: RunHostResolvedApproval | null;
  /** Host-held controller. The DO aborts it on register (reclaim), release,
   * and watchdog expiry; the runner aborts it itself on a supervised pause. */
  abort: AbortController;
  hooks: AdoptionHostHooks;
}

type LoopOutcome = 'completed' | 'paused' | 'reclaimed' | 'failed';

/**
 * Run the kernel from the checkpoint until it completes, pauses, is
 * reclaimed, or fails. Never throws — every exit is a logged branch and a
 * deliberate record transition (or a deliberate hands-off when ownership was
 * lost).
 */
export async function runAdoptedLoop(args: RunAdoptedLoopArgs): Promise<void> {
  const { env, record, checkpoint, origin, sandboxId, ownerToken, abort, hooks } = args;
  const resolvedApproval = args.resolvedApproval ?? null;
  const adoptionId = record.adoptionId ?? '';
  const runId = record.runId;

  let pendingPause: RunCheckpointPendingApproval | null = null;
  let outcome: LoopOutcome | null = null;
  let lastPersistedState: Pick<
    CoderCheckpointState<ChatCard>,
    'round' | 'messages' | 'workingMemory'
  > | null = null;

  const detectors = createWebDetectorAdapter();
  const stream = createWebStreamAdapter({
    env,
    origin,
    provider: checkpoint.provider as AIProviderType,
    modelId: checkpoint.model,
    jobId: runId,
    zenGo: checkpoint.providerOptions?.zenGo === true,
    // Server-stamped run owner (register/checkpoint route stamp) — lets the
    // adopted loop dispatch with the owner's stored provider key after the
    // client is gone. Absent on pre-stamp records: env-credentials-only.
    ownerUserId: record.ownerUserId,
  });
  const executor = createWebExecutorAdapter({
    env,
    origin,
    sandboxId,
    ownerToken,
    provider: checkpoint.provider as AIProviderType,
    jobId: runId,
    // The checkpoint doesn't carry the session's Protect Main flag, so fail
    // safe: block raw `git push` via sandbox_exec in adopted runs (they ship
    // through the audited prepare_push flow, not raw pushes). Forbidden ops and
    // branch ops are unescapable regardless of this flag. (#977)
    protectMain: true,
  });
  const capabilityLedger = new CapabilityLedger(Array.from(ROLE_CAPABILITIES.coder));
  const taskInFlight = classifyTurnIntent(checkpoint.userGoal) === 'task';
  const turnCtx: CoderTurnContext = {
    role: 'coder',
    round: checkpoint.round,
    maxRounds: checkpoint.round + ADOPTION_EXTRA_ROUNDS,
    sandboxId,
    allowedRepo: record.scope.repoFullName,
    activeProvider: checkpoint.provider as AIProviderType,
    activeModel: checkpoint.model,
    taskInFlight,
    completionGuard: resolveCoderCompletionGuard(taskInFlight),
    signal: abort.signal,
  };
  const services = buildCoderJobServices({
    detectors,
    executor,
    capabilityLedger,
    turnCtx,
    onStatus: () => {},
    activeProvider: checkpoint.provider,
    activeModel: checkpoint.model,
    sandboxId,
    policyEventHost: 'worker_adoption',
    // One services/policy instance lives for this adoption invocation. A host
    // relaunch is a new adopted attempt seeded from its durable checkpoint;
    // unlike CoderJob's sandbox-restore loop, this runner does not rebuild
    // services inside one live attempt.
    // Memory tools deliberately unwired — the in-memory store is empty in a
    // Worker isolate (the CoderJob precedent); the bindings deny memory calls
    // with a model-readable reason.
  });
  const adoptionDetectors = buildAdoptionDetectors<AnyToolCall>({
    detectAllToolCalls: detectors.detectAllToolCalls,
    detectAnyToolCall: detectors.detectAnyToolCall,
  });
  const toolExec = createAdoptionToolGate<AnyToolCall, ChatCard>({
    mode: record.mode,
    execute: buildCoderToolExec(services),
    hookContext: {
      sandboxId,
      allowedRepo: record.scope.repoFullName,
      activeProvider: checkpoint.provider,
      activeModel: checkpoint.model,
      capabilityLedger,
    },
    onPause: (pending) => {
      pendingPause = pending;
    },
    resolvedApproval,
  });

  /**
   * Per-round persistence + the reclaim/pause seams. The kernel awaits this
   * and swallows its errors, so control-flow exits go through `abort` (the
   * kernel re-checks the signal before its next provider call).
   */
  const onCheckpoint = async (state: CoderCheckpointState<ChatCard>): Promise<void> => {
    const current = await hooks.loadRecord();
    if (!current || current.adoptionId !== adoptionId || current.state !== 'adopted') {
      // Ownership lost — a client re-registered (reclaim), released, or the
      // watchdog expired the run. Stop without writing; the new owner's
      // state is authoritative.
      outcome = 'reclaimed';
      abort.abort();
      return;
    }

    const snapshot = {
      round: state.round,
      messages: state.messages.map((m) => ({ ...m })),
      workingMemory: { ...state.workingMemory },
    };
    const cp = coderStateToRunCheckpoint(checkpoint, snapshot, {
      savedAt: Date.now(),
      pendingApproval: pendingPause,
    });
    const issues = validateRunCheckpoint(cp);
    if (issues.length > 0) {
      log('warn', 'run_host_loop_checkpoint_invalid', {
        runId,
        round: state.round,
        issues: issues.slice(0, 4).map((i) => `${i.path}: ${i.message}`),
      });
    } else {
      const bytes = estimateRunCheckpointBytes(cp);
      if (checkpointExceedsHostCap(bytes)) {
        // Same loud-rejection stance as the client-facing endpoint: the run
        // continues on the last persisted checkpoint rather than silently
        // truncating (tiering is the open Phase 1 follow-up).
        log('warn', 'run_host_loop_checkpoint_oversize', { runId, round: state.round, bytes });
      } else {
        await hooks.saveCheckpoint(cp);
        lastPersistedState = snapshot;
        current.round = state.round;
        current.hasCheckpoint = true;
        log('info', 'run_host_loop_checkpoint_persisted', { runId, round: state.round, bytes });
      }
    }

    if (pendingPause) {
      // Supervised pause: the gate's note is now in the persisted transcript.
      // Record the pending approval, stop the watchdog (nothing to relaunch —
      // the run waits for a returning client), and stop the loop.
      current.pausedForApproval = pendingPause;
      await hooks.saveRecord(current);
      await hooks.clearAlarm();
      outcome = 'paused';
      log('info', 'run_host_loop_paused', {
        runId,
        round: state.round,
        approvalId: pendingPause.approvalId,
        kind: pendingPause.kind,
      });
      abort.abort();
      return;
    }

    await hooks.saveRecord(current);
    await hooks.armAlarm(Date.now() + RUN_HOST_ADOPTED_WATCHDOG_MS);
  };

  const options: CoderAgentOptions<AnyToolCall, ChatCard> = {
    provider: checkpoint.provider as AIProviderType,
    stream: stream as unknown as PushStream<LlmMessage>,
    modelId: checkpoint.model,
    sandboxId,
    allowedRepo: record.scope.repoFullName,
    userProfile: null,
    // Unused on resume (the seed transcript replaces the task message), but
    // context trimming folds summaries into messages[0], so keep the goal
    // anchor here for shape-compatibility.
    taskPreamble: checkpoint.userGoal,
    symbolSummary: null,
    toolExec,
    detectAllToolCalls: adoptionDetectors.detectAllToolCalls,
    detectAnyToolCall: adoptionDetectors.detectAnyToolCall,
    webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
    sandboxToolProtocol: getSandboxToolProtocol(),
    verificationPolicyBlock: formatVerificationPolicyBlock(checkpoint.verificationPolicy),
    approvalModeBlock: buildApprovalModeBlock(record.mode),
    // Adoption resumes the conversational lead's own checkpointed turn, so it
    // wears the lead persona (identity + voice + lead guidelines). Pre-rename
    // this call site omitted `leadMode` and resumed in implementer voice — a
    // latent bug the persona seam made visible; fixed here (PR 1b).
    persona: 'lead',
    // ...but this server-side adoption surface only wires sandbox + web-search
    // (no GitHub / ask_user / artifact executors), so scope the lead guidance to
    // match — same as the background CoderJob DO lead — or it steers the model
    // toward tools it can't dispatch and wastes rounds (Codex P2 on #952).
    leadToolScope: 'sandbox',
    evaluateAfterModel: buildCoderEvaluateAfterModel(services),
    harnessMaxRounds: checkpoint.round + ADOPTION_EXTRA_ROUNDS,
    resumeState: runCheckpointToCoderResumeState<ChatCard>(checkpoint, { resolvedApproval }),
    // Server-side progress has no client mirror; persist every round.
    checkpointCadenceRounds: 1,
  };

  try {
    const result = await runCoderAgent<AnyToolCall, ChatCard>(options, {
      onStatus: () => {},
      signal: abort.signal,
      onCheckpoint,
    });
    await finishCompleted(result.summary, result.rounds);
  } catch (err) {
    const aborted =
      abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
    if (aborted) {
      // `paused` already did its bookkeeping (and logged) in onCheckpoint.
      // Anything else aborted is a reclaim: either onCheckpoint detected the
      // ownership loss, or the abort landed mid-round (register/release/
      // expiry) — no writes owed, the new owner's state is authoritative.
      if (outcome !== 'paused') {
        log('info', 'run_host_loop_reclaimed', { runId, adoptionId });
      }
      return;
    }
    await finishFailed(err);
  }

  async function finishCompleted(summary: string, rounds: number): Promise<void> {
    const current = await hooks.loadRecord();
    if (!current || current.adoptionId !== adoptionId || current.state !== 'adopted') {
      outcome = 'reclaimed';
      log('info', 'run_host_loop_reclaimed', { runId, adoptionId, at: 'completion' });
      return;
    }
    // Persist a terminal checkpoint with the kernel's summary appended so a
    // returning client (Phase 3 attach) sees the run's conclusion, not just
    // its last tool round.
    if (lastPersistedState) {
      const finalState = {
        round: lastPersistedState.round,
        messages: [
          ...lastPersistedState.messages,
          {
            id: 'adopted-final-summary',
            role: 'assistant' as const,
            content: summary,
            timestamp: Date.now(),
          },
        ],
        workingMemory: lastPersistedState.workingMemory,
      };
      const finalCp = coderStateToRunCheckpoint(checkpoint, finalState, { savedAt: Date.now() });
      if (
        validateRunCheckpoint(finalCp).length === 0 &&
        !checkpointExceedsHostCap(estimateRunCheckpointBytes(finalCp))
      ) {
        await hooks.saveCheckpoint(finalCp);
      }
    }
    current.state = 'ended';
    current.midFlight = false;
    await hooks.saveRecord(current);
    await hooks.clearAlarm();
    outcome = 'completed';
    log('info', 'run_host_loop_completed', { runId, adoptionId, rounds });
  }

  async function finishFailed(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const current = await hooks.loadRecord();
    if (!current || current.adoptionId !== adoptionId || current.state !== 'adopted') {
      outcome = 'reclaimed';
      log('info', 'run_host_loop_reclaimed', { runId, adoptionId, at: 'failure' });
      return;
    }
    const relaunches = (current.adoptionRelaunches ?? 0) + 1;
    current.adoptionRelaunches = relaunches;
    current.state = 'adoptable';
    current.lastError = message.slice(0, 500);
    await hooks.saveRecord(current);
    // `<=`: `adoptionRelaunches` counts launches CONSUMED including the one
    // this retry alarm will trigger (increment-before-launch), so a count
    // equal to the cap is the last permitted relaunch — the same budget the
    // orphan watchdog grants (`decideAdoptedAlarm` expires only at >= cap
    // BEFORE incrementing).
    const willRetry = relaunches <= RUN_HOST_MAX_ADOPTION_RELAUNCHES;
    if (willRetry) {
      // Park adoptable with a retry alarm — the DO's adoptable wake re-runs
      // provisioning and relaunches. A reclaiming client still wins: register
      // resets state to watched and the retry wake idles.
      await hooks.armAlarm(Date.now() + RUN_HOST_ADOPTED_WATCHDOG_MS);
    } else {
      await hooks.clearAlarm();
    }
    outcome = 'failed';
    log('warn', 'run_host_loop_failed', { runId, adoptionId, error: message, willRetry });
  }
}
