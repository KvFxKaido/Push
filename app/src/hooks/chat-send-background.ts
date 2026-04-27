/**
 * Background-mode entry path for `useChat.sendMessage`.
 *
 * When the global `push:background-mode-preference` flag is on, the
 * user's turn runs server-side in the CoderJob DO instead of the
 * in-browser loop. This module owns the envelope construction +
 * sandbox/repo/branch precondition checks + handoff to the hook —
 * extracted out of `useChat.ts` to keep the orchestrator file under
 * its line-count budget and to give the bg-mode path its own
 * testable seam.
 *
 * No priorMessages, no inlined chat history. The envelope carries the
 * latest user message as the Coder's task; chatRef hands the DO the
 * durable handles (chatId / repo / branch / checkpoint) PR 3 will use
 * to load context. Until then chatRef is wire-shape only.
 */

import type React from 'react';
import type { AIProviderType, Conversation, DelegationEnvelope } from '@/types';
import { getSandboxOwnerToken } from '@/lib/sandbox-client';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UseBackgroundCoderJobResult } from './useBackgroundCoderJob';

/** Returns true when the conversation has at least one background job
 *  in a non-terminal state. Used as the v1 writer/viewer lock for
 *  background-mode main chat: any tab with an active job for a chat
 *  blocks new sends from any tab, including its own — the job is the
 *  current "run", and a second send would race the server's run loop.
 *  Tab races, toggle flips, and reconnects all converge on this single
 *  source of truth (persisted in IndexedDB via `pendingJobIds`). */
export function hasActiveBackgroundJob(conv: Conversation | undefined): boolean {
  if (!conv?.pendingJobIds) return false;
  for (const entry of Object.values(conv.pendingJobIds)) {
    if (entry.status === 'queued' || entry.status === 'running') return true;
  }
  return false;
}

/** Ref bundle the bg-mode entry path needs to dereference at call
 *  time. Passing refs (not their `.current` values) keeps useChat.ts
 *  callers compact — the helper does the dereferencing in one spot. */
export interface BackgroundMainChatRefs {
  sandboxIdRef: React.MutableRefObject<string | null>;
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | null | undefined
  >;
  isMainProtectedRef: React.MutableRefObject<boolean>;
  agentsMdRef: React.MutableRefObject<string | null>;
  instructionFilenameRef: React.MutableRefObject<string | null>;
}

export interface StartBackgroundMainChatTurnInput {
  chatId: string;
  trimmedText: string;
  lockedProvider: AIProviderType;
  resolvedModel: string | undefined;
  refs: BackgroundMainChatRefs;
  backgroundCoderJob: UseBackgroundCoderJobResult;
}

export type StartBackgroundMainChatTurnResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

export async function startBackgroundMainChatTurn(
  input: StartBackgroundMainChatTurnInput,
): Promise<StartBackgroundMainChatTurnResult> {
  const { chatId, trimmedText, lockedProvider, resolvedModel, refs, backgroundCoderJob } = input;

  const sandboxId = refs.sandboxIdRef.current;
  const repoFullName = refs.repoRef.current;
  const branchInfo = refs.branchInfoRef.current;
  const branch = branchInfo?.currentBranch ?? branchInfo?.defaultBranch ?? '';

  if (!sandboxId || !repoFullName || !branch) {
    return {
      ok: false,
      error: 'Background mode requires an active sandbox, repo, and branch.',
    };
  }

  const ownerToken = getSandboxOwnerToken(sandboxId) ?? '';
  if (!ownerToken) {
    return {
      ok: false,
      error: 'Missing sandbox owner token; cannot start background job.',
    };
  }

  const envelope: DelegationEnvelope = {
    task: trimmedText,
    files: [],
    provider: lockedProvider,
    model: resolvedModel,
    branchContext: {
      activeBranch: branch,
      defaultBranch: branchInfo?.defaultBranch ?? '',
      protectMain: refs.isMainProtectedRef.current,
    },
    originBranch: branchInfo?.currentBranch,
    projectInstructions: refs.agentsMdRef.current ?? undefined,
    instructionFilename: refs.instructionFilenameRef.current ?? undefined,
  };

  const startResult = await backgroundCoderJob.startMainChatJob({
    chatId,
    repoFullName,
    branch,
    sandboxId,
    ownerToken,
    envelope,
    provider: lockedProvider,
    model: resolvedModel,
    userProfile: getUserProfile(),
    taskPreview: trimmedText.slice(0, 140),
    chatRef: { chatId, repoFullName, branch },
  });

  if (!startResult.ok) {
    return {
      ok: false,
      error: `Background job failed to start: ${startResult.error}`,
    };
  }

  return { ok: true, jobId: startResult.jobId };
}
