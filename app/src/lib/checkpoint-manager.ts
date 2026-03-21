import type {
  AIProviderType,
  ChatMessage,
  CoderWorkingMemory,
  LoopPhase,
  RunCheckpoint,
} from '@/types';
import type { SandboxStatusResult } from './sandbox-client';
import {
  clearCheckpoint as clearCheckpointFromDB,
  loadCheckpoint as loadCheckpointFromDB,
  saveCheckpoint as saveCheckpointToDB,
} from './checkpoint-store';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

const CHECKPOINT_MAX_AGE_MS = 25 * 60 * 1000; // 25 min — matches sandbox max age
const RUN_ACTIVE_PREFIX = 'run_active_';
const TAB_LOCK_STALE_MS = 60_000; // Consider lock stale after 60s without heartbeat
const CHECKPOINT_DELTA_WARN_SIZE = 50 * 1024; // 50KB warning threshold

export interface ResumeEvent {
  phase: LoopPhase;
  round: number;
  timeSinceInterrupt: number;
  provider: string;
  hadAccumulated: boolean;
  hadCoderState: boolean;
}

export interface RunCheckpointSnapshot {
  chatId: string;
  round: number;
  phase: LoopPhase;
  baseMessageCount: number;
  apiMessages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content'>>;
  accumulated: string;
  thinkingAccumulated: string;
  lastCoderState: CoderWorkingMemory | null;
  provider: AIProviderType;
  model: string;
  sandboxSessionId: string;
  activeBranch: string;
  repoId: string;
  userAborted?: boolean;
  workspaceSessionId?: string;
  savedAt?: number;
  savedDiff?: string;
  reason?: 'expiry' | 'manual' | 'interrupt';
}

const resumeEvents: ResumeEvent[] = [];

export function checkpointRequiresLiveSandboxStatus(
  checkpoint: Pick<RunCheckpoint, 'reason'>,
): boolean {
  return checkpoint.reason !== 'expiry';
}

function trimCheckpointDelta(checkpoint: RunCheckpoint): RunCheckpoint {
  const deltaJson = JSON.stringify(checkpoint.deltaMessages);
  if (deltaJson.length <= CHECKPOINT_DELTA_WARN_SIZE) return checkpoint;

  console.warn(
    `[Push] Checkpoint deltaMessages exceeds ${CHECKPOINT_DELTA_WARN_SIZE / 1024}KB (${Math.round(deltaJson.length / 1024)}KB), trimming oldest deltas`,
  );

  const trimmed = [...checkpoint.deltaMessages];
  while (JSON.stringify(trimmed).length > CHECKPOINT_DELTA_WARN_SIZE && trimmed.length > 2) {
    trimmed.shift();
  }

  return { ...checkpoint, deltaMessages: trimmed };
}

export function buildRunCheckpoint(snapshot: RunCheckpointSnapshot): RunCheckpoint {
  return {
    chatId: snapshot.chatId,
    round: snapshot.round,
    phase: snapshot.phase,
    baseMessageCount: snapshot.baseMessageCount,
    deltaMessages: snapshot.apiMessages.slice(snapshot.baseMessageCount).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    accumulated: snapshot.accumulated,
    thinkingAccumulated: snapshot.thinkingAccumulated,
    coderDelegationActive: snapshot.phase === 'delegating_coder',
    lastCoderState:
      snapshot.phase === 'delegating_coder' && snapshot.lastCoderState
        ? JSON.stringify(snapshot.lastCoderState)
        : null,
    savedAt: snapshot.savedAt ?? Date.now(),
    provider: snapshot.provider,
    model: snapshot.model,
    sandboxSessionId: snapshot.sandboxSessionId,
    activeBranch: snapshot.activeBranch,
    repoId: snapshot.repoId,
    userAborted: snapshot.userAborted || undefined,
    workspaceSessionId: snapshot.workspaceSessionId,
    savedDiff: snapshot.savedDiff || undefined,
    reason: snapshot.reason,
  };
}

export function saveRunCheckpoint(checkpoint: RunCheckpoint): void {
  void saveCheckpointToDB(trimCheckpointDelta(checkpoint));
}

export function clearRunCheckpoint(chatId: string): void {
  void clearCheckpointFromDB(chatId);
}

export async function detectInterruptedRun(
  chatId: string,
  currentSandboxId: string | null,
  currentBranch: string | null,
  currentRepoId: string | null,
  currentWorkspaceSessionId?: string | null,
): Promise<RunCheckpoint | null> {
  const checkpoint = await loadCheckpointFromDB(chatId);
  if (!checkpoint) return null;

  const age = Date.now() - checkpoint.savedAt;
  if (age > CHECKPOINT_MAX_AGE_MS) {
    clearRunCheckpoint(chatId);
    return null;
  }

  if (checkpoint.userAborted) {
    clearRunCheckpoint(chatId);
    return null;
  }

  if (currentWorkspaceSessionId && !checkpoint.workspaceSessionId) {
    clearRunCheckpoint(chatId);
    return null;
  }

  if (
    currentWorkspaceSessionId &&
    checkpoint.workspaceSessionId &&
    checkpoint.workspaceSessionId !== currentWorkspaceSessionId
  ) {
    clearRunCheckpoint(chatId);
    return null;
  }

  // Expiry checkpoints survive sandbox ID mismatch — the old sandbox is gone by design.
  if (
    checkpointRequiresLiveSandboxStatus(checkpoint) &&
    currentSandboxId &&
    checkpoint.sandboxSessionId !== currentSandboxId
  ) {
    clearRunCheckpoint(chatId);
    return null;
  }
  if (currentBranch && checkpoint.activeBranch !== currentBranch) {
    clearRunCheckpoint(chatId);
    return null;
  }
  if (currentRepoId && checkpoint.repoId !== currentRepoId) {
    clearRunCheckpoint(chatId);
    return null;
  }

  return checkpoint;
}

export function buildCheckpointReconciliationMessage(
  checkpoint: RunCheckpoint,
  status: SandboxStatusResult,
): string {
  // Cold resume: prior sandbox expired. Build from saved diff instead of live status.
  if (checkpoint.reason === 'expiry') {
    let msg = '[SESSION_RESUMED]\nPrior sandbox expired. Resuming on a new sandbox (fresh clone).\n';
    if (checkpoint.savedDiff) {
      msg += `\nUncommitted changes at expiry:\n---\n${checkpoint.savedDiff}\n---\n`;
      msg += '\nRe-apply these changes to continue the task. Verify each file before editing.\n';
    } else {
      msg += '\nNo uncommitted changes were pending at expiry.\nContinue from the conversation above.\n';
    }
    msg += '\nDo not repeat work already committed to the branch.';
    return msg;
  }

  const dirtyList = status.dirtyFiles.length > 0 ? status.dirtyFiles.join('\n') : 'clean';
  const changedList = status.changedFiles.length > 0 ? status.changedFiles.join('\n') : 'none';

  let header =
    `[SESSION_RESUMED]\nSandbox state at recovery:\n` +
    `- HEAD: ${status.head}\n` +
    `- Dirty files: ${dirtyList}\n` +
    `- Diff summary: ${status.diffStat || 'none'}\n` +
    `- Changed files: ${changedList}\n`;

  if (checkpoint.phase === 'streaming_llm') {
    header += `\nInterruption: connection dropped while you were generating a response (round ${checkpoint.round}).\n`;
    if (checkpoint.accumulated) {
      header +=
        `Your partial response before disconnection:\n---\n${checkpoint.accumulated}\n---\n` +
        'Resume your response. The sandbox state above reflects the current truth.\n';
    } else {
      header +=
        'No partial response was captured. The sandbox state above reflects the current truth. ' +
        'Continue where you left off.\n';
    }
  } else if (checkpoint.phase === 'executing_tools') {
    header +=
      `\nInterruption: connection dropped while executing tool calls (round ${checkpoint.round}).\n` +
      'The tool batch may or may not have completed. Check the sandbox state above\n' +
      'against what the tools were supposed to do. If the expected changes are present,\n' +
      'proceed to the next step. If not, re-attempt the tool calls.\n';
  } else if (checkpoint.phase === 'delegating_coder') {
    header +=
      `\nInterruption: connection dropped during Coder delegation (round ${checkpoint.round}).\n`;
    if (checkpoint.lastCoderState) {
      header += `Last known Coder state:\n${checkpoint.lastCoderState}\n`;
    }
    header +=
      "The Coder's work may be partially complete. Check the sandbox state above.\n" +
      "Decide whether to re-delegate the remaining work or proceed based on what's done.\n";
  } else if (checkpoint.phase === 'delegating_explorer') {
    header +=
      `\nInterruption: connection dropped during Explorer delegation (round ${checkpoint.round}).\n`;
    header +=
      'The Explorer may have gathered partial findings already. Check the sandbox state above and the recent conversation before re-running the investigation.\n';
  }

  header += '\nDo not repeat work that is already reflected in the sandbox.';
  return header;
}

export function acquireRunTabLock(chatId: string): string | null {
  const key = `${RUN_ACTIVE_PREFIX}${chatId}`;
  const existing = safeStorageGet(key);
  if (existing) {
    try {
      const lock = JSON.parse(existing) as { tabId: string; heartbeat: number };
      if (Date.now() - lock.heartbeat < TAB_LOCK_STALE_MS) {
        return null;
      }
    } catch {
      // Malformed lock; take it over.
    }
  }

  const tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  safeStorageSet(key, JSON.stringify({ tabId, heartbeat: Date.now() }));

  const verify = safeStorageGet(key);
  if (!verify) return null;

  try {
    const parsed = JSON.parse(verify) as { tabId: string };
    return parsed.tabId === tabId ? tabId : null;
  } catch {
    return null;
  }
}

export function releaseRunTabLock(chatId: string, ownerTabId: string | null): void {
  if (!ownerTabId) return;

  const key = `${RUN_ACTIVE_PREFIX}${chatId}`;
  const existing = safeStorageGet(key);
  if (existing) {
    try {
      const lock = JSON.parse(existing) as { tabId: string };
      if (lock.tabId !== ownerTabId) return;
    } catch {
      // Malformed lock; safe to remove.
    }
  }

  safeStorageRemove(key);
}

export function heartbeatRunTabLock(chatId: string, ownerTabId: string | null): void {
  if (!ownerTabId) return;

  const key = `${RUN_ACTIVE_PREFIX}${chatId}`;
  const existing = safeStorageGet(key);
  if (!existing) return;

  try {
    const lock = JSON.parse(existing) as { tabId: string; heartbeat: number };
    if (lock.tabId !== ownerTabId) return;
    safeStorageSet(key, JSON.stringify({ ...lock, heartbeat: Date.now() }));
  } catch {
    // Ignore malformed heartbeat payloads.
  }
}

export function recordResumeEvent(checkpoint: RunCheckpoint): void {
  const event: ResumeEvent = {
    phase: checkpoint.phase,
    round: checkpoint.round,
    timeSinceInterrupt: Date.now() - checkpoint.savedAt,
    provider: checkpoint.provider,
    hadAccumulated: Boolean(checkpoint.accumulated),
    hadCoderState: Boolean(checkpoint.lastCoderState),
  };

  resumeEvents.push(event);
  if (resumeEvents.length > 50) resumeEvents.shift();
  console.log('[Push] Session resumed:', event);
}

export function getResumeEvents(): readonly ResumeEvent[] {
  return resumeEvents;
}
