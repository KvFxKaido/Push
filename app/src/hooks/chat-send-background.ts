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
import {
  resolveTurnEngineTrigger,
  type EngineTrigger,
  type TurnEngineTrigger,
} from '@/lib/delegation-mode-settings';
import type { AIProviderType, Conversation, DelegationEnvelope } from '@/types';
import { getActiveProvider, isProviderAvailable } from '@/lib/orchestrator';
import { isProviderEngineCapable } from '@/lib/provider-engine-capability';
import { resolveChatProviderSelection } from '@/lib/provider-selection';
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
/**
 * `useChat.sendMessage`'s engine-routing decision, with the eligibility
 * check the route's preconditions demand: `startBackgroundMainChatTurn`
 * hard-requires an active repo AND a branch (the sandbox is lazily
 * ensured), so a no-repo workspace (scratch / chat / local-pc) must stay
 * on the foreground loop instead of routing every send into a guaranteed
 * precondition error — load-bearing now that `inline` delegation-mode is
 * the default (Codex P1, PR #887). Lives here, not in useChat.ts, per the
 * max-lines guard; the trigger-precedence kernel stays in
 * `delegation-mode-settings.ts`.
 */
export function resolveSendEngineTrigger(opts: {
  hasAttachments: boolean;
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | null | undefined
  >;
  /** Conversation store + target chat, used to peek the provider this turn
   *  will lock BEFORE `prepareSendContext` resolves it for real. The peek
   *  reuses `resolveChatProviderSelection` with the same inputs prepare
   *  passes, so the two can only disagree if that call drifts — keep them
   *  in lockstep. `chatId` may be null (new chat), and a non-null `chatId`
   *  whose conversation hasn't landed in the store yet hits the same
   *  null-provider fallback — both resolve through `getActiveProvider()`,
   *  exactly as prepare will. */
  conversationsRef: React.MutableRefObject<Record<string, Conversation>>;
  chatId: string | null;
  requestedProvider?: AIProviderType | null;
}): TurnEngineTrigger {
  const branch =
    opts.branchInfoRef.current?.currentBranch ?? opts.branchInfoRef.current?.defaultBranch;
  const conv = opts.chatId ? opts.conversationsRef.current[opts.chatId] : undefined;
  const { provider } = resolveChatProviderSelection({
    existingProvider: conv?.provider || null,
    existingModel: conv?.model || null,
    requestedProvider: opts.requestedProvider ?? null,
    requestedModel: null,
    fallbackProvider: getActiveProvider(),
    isProviderAvailable,
  });
  return resolveTurnEngineTrigger({
    hasAttachments: opts.hasAttachments,
    // Engine turns run server-side, where only Worker-held provider
    // credentials exist — a provider keyed solely via in-app Settings must
    // stay on the foreground loop (which forwards the key per-request) or
    // the job 401s at dispatch. See provider-engine-capability.ts.
    // `provider` is an ActiveProvider, a subset of AIProviderType — the
    // implicit widening here is safe today; if ActiveProvider ever diverges,
    // an unknown value resolves optimistically true (same as any unknown).
    engineEligible: Boolean(opts.repoRef.current && branch) && isProviderEngineCapable(provider),
  });
}

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
  /**
   * The named trigger that routed this turn to the durable engine
   * (`inline-delegation` for the Coder Delegation Collapse experiment, or
   * legacy `background-mode`). Forwarded only so the engine-arc
   * measurement log can be tagged for the step-1 A/B — see
   * `docs/decisions/Coder Delegation Collapse — Component Audit.md`.
   */
  engineTrigger?: EngineTrigger;
  /**
   * Lazily ensure a sandbox exists before routing the turn to the engine.
   * The engine route requires a live sandbox up front — unlike the
   * foreground loop, which can ensure one mid-run when a tool call needs
   * it — so a cold inline/background first send would otherwise reject
   * with "requires an active sandbox". Mirrors the prewarm in
   * `prepareSendContext`. Best-effort: a null/throw falls through to the
   * precondition error below. (Codex P2, PR #773.)
   */
  ensureSandbox?: () => Promise<string | null>;
}

export type StartBackgroundMainChatTurnResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

export async function startBackgroundMainChatTurn(
  input: StartBackgroundMainChatTurnInput,
): Promise<StartBackgroundMainChatTurnResult> {
  const { chatId, trimmedText, lockedProvider, resolvedModel, refs, backgroundCoderJob } = input;
  const trigger = input.engineTrigger ?? 'background-mode';

  // The engine route needs a live sandbox up front (the foreground loop
  // ensures one lazily mid-run; this path cannot). Ensure before the
  // precondition check so a cold first send doesn't reject. Best-effort —
  // a failure falls through to the precondition error below. (Codex P2.)
  if (!refs.sandboxIdRef.current && input.ensureSandbox) {
    try {
      const ensured = await input.ensureSandbox();
      if (ensured) refs.sandboxIdRef.current = ensured;
    } catch {
      /* fall through to the precondition error below */
    }
  }

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

  // Engine-arc measurement for the Coder Delegation Collapse step-1 A/B.
  // Symmetric — one paired event per outcome — so an engine-routed turn is
  // correlatable (chatId + jobId) with the CoderJob DO's own `coder_job_*`
  // latency/quality logs. Event name is nomenclature-neutral: both engine
  // triggers emit it, so the `trigger` field (not the name) is what tells
  // the `inline-delegation` experiment apart from legacy `background-mode`
  // (Kilo review, PR #773). See the decision doc.
  console.log(
    JSON.stringify(
      startResult.ok
        ? {
            level: 'info',
            event: 'delegation_engine_job_started',
            chatId,
            jobId: startResult.jobId,
            trigger,
          }
        : {
            level: 'error',
            event: 'delegation_engine_job_failed',
            chatId,
            trigger,
            error: startResult.error,
          },
    ),
  );

  if (!startResult.ok) {
    return {
      ok: false,
      error: `Background job failed to start: ${startResult.error}`,
    };
  }

  return { ok: true, jobId: startResult.jobId };
}
