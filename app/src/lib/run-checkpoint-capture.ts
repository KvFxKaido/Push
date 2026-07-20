/**
 * run-checkpoint-capture.ts — Durable Runs Phase 1 capture-side wiring.
 *
 * Builds the self-contained `RunCheckpointV1` (lib/run-checkpoint.ts) from
 * the web loop's live state and persists it per turn. This is the record a
 * RunHost DO adopts from when client heartbeats lapse (Phase 2); today it
 * lands in IndexedDB next to the legacy delta checkpoint so capture fidelity
 * and size can be measured on real runs before the DO transport exists.
 *
 * Size is the open Phase 1 risk: every write logs
 * `run_checkpoint_captured` with `estimateRunCheckpointBytes` so tiering
 * decisions key off observed numbers, not guesses.
 */

import {
  assertValidRunCheckpoint,
  estimateRunCheckpointBytes,
  RUN_CHECKPOINT_VERSION,
  shouldAssertRunCheckpoints,
  validateRunCheckpoint,
  type RunCheckpointMessage,
  type RunCheckpointReason,
  type RunCheckpointV1,
} from '@push/lib/run-checkpoint';
import type { ApprovalMode } from '@push/lib/approval-gates';
import type { VerificationPolicy } from '@push/lib/verification-policy';
import type { ChatMessage, CoderWorkingMemory, LoopPhase } from '@/types';
import { buildAttachmentContentBlocks } from './attachment-content-parts';
import { saveCheckpointV1 } from './checkpoint-store';
import { publishRunCheckpointToHost } from './run-host-transport';

export interface RunCheckpointV1Snapshot {
  chatId: string;
  repoFullName: string;
  branch: string;
  workspaceSessionId?: string;
  /** The engine's run id, present only while a run is active. Carries the
   * RunHost registration identity — captures without one (expiry saves)
   * stay local and are never mirrored to the host. */
  runId?: string;
  round: number;
  phase: LoopPhase;
  reason: RunCheckpointReason;
  apiMessages: ReadonlyArray<ChatMessage>;
  accumulated: string;
  thinkingAccumulated: string;
  provider: string;
  model: string;
  approvalMode: ApprovalMode;
  verificationPolicy?: VerificationPolicy;
  zenGo?: boolean;
  workingMemory?: CoderWorkingMemory | null;
  sandboxSessionId?: string | null;
  savedDiff?: string;
  userAborted?: boolean;
}

/**
 * Map the loop's ChatMessage transcript to the checkpoint's wire-faithful
 * shape. Mirrors the wire-build rules in `orchestrator.ts`:
 *
 * - `visibleToModel: false` messages never cross the LLM boundary again
 *   (aborted partials), so they don't enter the checkpoint either.
 * - Attachments become `contentBlocks` exactly as the wire builder converts
 *   them (image → Anthropic source block, code/document → fenced text block),
 *   so an adopted run resumes image-bearing turns with the pixels intact.
 * - Reasoning blocks ride along on assistant turns for the Anthropic
 *   signed-thinking round-trip.
 */
export function toRunCheckpointMessages(
  apiMessages: ReadonlyArray<ChatMessage>,
): RunCheckpointMessage[] {
  const out: RunCheckpointMessage[] = [];
  for (const msg of apiMessages) {
    if (msg.visibleToModel === false) continue;

    const entry: RunCheckpointMessage = {
      role: msg.role,
      content: msg.content,
    };

    // Prefer the kernel's pre-converted `contentParts` (its image turns carry
    // pixels only there, not in `attachments`); fall back to rebuilding
    // `contentBlocks` from `attachments` for Orchestrator-loop messages.
    // Capturing only the attachment-rebuilt form would make an adopted/resumed
    // inline image turn text-only (Codex P2, #937).
    const contentParts =
      msg.contentParts && msg.contentParts.length > 0 ? msg.contentParts : undefined;
    if (contentParts) {
      entry.contentParts = contentParts;
    }
    const contentBlocks = contentParts
      ? undefined
      : buildAttachmentContentBlocks(msg.content, msg.attachments);
    if (contentBlocks) {
      entry.contentBlocks = contentBlocks;
    }

    if (msg.role === 'assistant' && msg.reasoningBlocks && msg.reasoningBlocks.length > 0) {
      entry.reasoningBlocks = msg.reasoningBlocks;
    }
    if (
      msg.role === 'assistant' &&
      msg.responsesReasoningItems &&
      msg.responsesReasoningItems.length > 0
    ) {
      entry.responsesReasoningItems = msg.responsesReasoningItems;
    }
    if (msg.isToolCall) entry.isToolCall = true;
    if (msg.isToolResult) entry.isToolResult = true;

    out.push(entry);
  }
  return out;
}

/**
 * The user-goal anchor: the latest real user message (steers update intent;
 * tool results are synthetic user turns and don't count). `displayContent`
 * is preferred — `content` may be runtime-wrapped scaffolding.
 */
export function deriveUserGoal(apiMessages: ReadonlyArray<ChatMessage>): string {
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const msg = apiMessages[i];
    if (msg.role !== 'user' || msg.isToolResult) continue;
    const goal = (msg.displayContent ?? msg.content).trim();
    if (goal) return goal;
  }
  return '';
}

export function buildRunCheckpointV1(snapshot: RunCheckpointV1Snapshot): RunCheckpointV1 {
  return {
    v: RUN_CHECKPOINT_VERSION,
    chatId: snapshot.chatId,
    repoFullName: snapshot.repoFullName,
    branch: snapshot.branch,
    workspaceSessionId: snapshot.workspaceSessionId,
    runId: snapshot.runId || undefined,
    round: snapshot.round,
    phase: snapshot.phase,
    savedAt: Date.now(),
    reason: snapshot.reason,
    userAborted: snapshot.userAborted || undefined,
    messages: toRunCheckpointMessages(snapshot.apiMessages),
    accumulated: snapshot.accumulated,
    thinkingAccumulated: snapshot.thinkingAccumulated,
    userGoal: deriveUserGoal(snapshot.apiMessages),
    provider: snapshot.provider,
    model: snapshot.model,
    providerOptions: snapshot.zenGo ? { zenGo: true } : undefined,
    approvalMode: snapshot.approvalMode,
    verificationPolicy: snapshot.verificationPolicy,
    workingMemory: snapshot.workingMemory ?? undefined,
    delegation:
      snapshot.phase === 'delegating_coder' || snapshot.phase === 'executing_task_graph'
        ? {
            active: true,
            lastCoderState: snapshot.workingMemory ? JSON.stringify(snapshot.workingMemory) : null,
          }
        : undefined,
    sandboxSessionId: snapshot.sandboxSessionId ?? undefined,
    savedDiff: snapshot.savedDiff || undefined,
  };
}

/**
 * Build → validate → persist → measure. Fire-and-forget like the legacy
 * checkpoint path: a failed write never breaks the round loop. Symmetric
 * structured logs cover every exit:
 *
 *   run_checkpoint_captured ↔ run_checkpoint_invalid ↔ run_checkpoint_write_failed
 *
 * A valid checkpoint is also mirrored to the RunHost ledger (Phase 2 client
 * transport) — independently of the local save, so an IndexedDB failure
 * never blocks adoption and vice versa.
 */
export function captureRunCheckpointV1(snapshot: RunCheckpointV1Snapshot): void {
  const checkpoint = buildRunCheckpointV1(snapshot);

  const issues = validateRunCheckpoint(checkpoint);
  if (issues.length > 0) {
    if (shouldAssertRunCheckpoints()) {
      assertValidRunCheckpoint(checkpoint); // throws with the full issue list
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'run_checkpoint_invalid',
        chatId: checkpoint.chatId,
        round: checkpoint.round,
        reason: checkpoint.reason,
        issues: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)),
      }),
    );
    return;
  }

  publishRunCheckpointToHost(checkpoint);

  const bytes = estimateRunCheckpointBytes(checkpoint);
  void saveCheckpointV1(checkpoint)
    .then(() => {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'run_checkpoint_captured',
          chatId: checkpoint.chatId,
          round: checkpoint.round,
          phase: checkpoint.phase,
          reason: checkpoint.reason,
          messages: checkpoint.messages.length,
          bytes,
        }),
      );
    })
    .catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'run_checkpoint_write_failed',
          chatId: checkpoint.chatId,
          round: checkpoint.round,
          reason: checkpoint.reason,
          bytes,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
}
