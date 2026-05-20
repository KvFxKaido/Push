/**
 * useWorkspacePatchCapture — captures the uncommitted working-tree diff
 * at the end of every Coder-touched round and attaches it as a
 * `workspace-patch` chat card to the assistant message that produced it.
 *
 * Behavior contract (PR 2 of persist-diffs-chat):
 *
 *   - Runs only when the round emitted a `subagent.completed` event
 *     with `agent: 'coder'`. The decision lives in the standalone
 *     `shouldCaptureWorkspacePatch` seam below so a future PR can
 *     swap the heuristic for the precise `markWorkspaceMutated` flag
 *     without touching the loop.
 *
 *   - Captures via `fetchSandboxDiffWithMeta` + `git rev-parse HEAD`.
 *     Empty `diffBytes` → no card (per V1 spec: only attach when there
 *     is something to persist). Non-empty → one card with
 *     `applyState.kind === 'pending'`.
 *
 *   - Active-conversation-only storage. The card lands on the latest
 *     assistant tool-call message in the chat that just produced the
 *     turn (via `appendCardsToLatestToolCall`). Cross-conversation
 *     `repoFullName + branch` lookup is shaped into the schema but
 *     not wired here.
 *
 *   - Capture failures are logged via `console.debug` per the
 *     surrounding `useSandbox` convention — never silently swallowed,
 *     never escalated into a degraded card (V1 keeps the apply-state
 *     refusal vocabulary reserved for true replay-time refusals).
 */

import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { execInSandbox, fetchSandboxDiffWithMeta } from '@/lib/sandbox-client';
import type { ChatCard, Conversation, RunEventInput } from '@/types';
import {
  WORKSPACE_PATCH_CARD_SCHEMA_VERSION,
  type WorkspacePatchCardData,
} from '@push/lib/protocol-schema';

export interface WorkspacePatchRoundContext {
  chatId: string;
  round: number;
  outcome: 'continued' | 'completed' | 'aborted' | 'error' | 'steered';
  /** Events emitted via `appendRunEvent` during this round. The
   *  capture seam reads this to decide whether to fire. */
  roundEvents: readonly RunEventInput[];
  /** Stable id of the assistant tool-call message this round produced,
   *  snapshotted by the loop at round-end *before* the capture fires.
   *  Capture is fire-and-forget; if we re-scanned for "latest" at
   *  resolve time, a slow sandbox exec could let a later round's
   *  tool-call message hijack attribution (the contract is "attach
   *  to the message that produced it"). Targeting by id is race-free.
   *  Null when no tool-call message exists in the conversation — the
   *  hook skips capture in that case. */
  assistantToolCallMessageId: string | null;
}

/**
 * Standalone capture-decision seam. Today: capture when the round
 * emitted a `subagent.completed` event with `agent: 'coder'`. Tomorrow
 * (when tools propagate a precise `workspaceMutated` flag through the
 * loop), swap the body to read that flag — the rest of the wiring
 * stays put.
 */
export function shouldCaptureWorkspacePatch(ctx: WorkspacePatchRoundContext): boolean {
  return ctx.roundEvents.some(
    (event) => event.type === 'subagent.completed' && event.agent === 'coder',
  );
}

export interface UseWorkspacePatchCaptureArgs {
  sandboxIdRef: MutableRefObject<string | null>;
  repoRef: MutableRefObject<string | null>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  /** `useConversationPersistence` only flushes ids present in this set.
   *  Without marking the chat dirty, a capture that lands after the
   *  last flush would never reach storage. */
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
}

export interface UseWorkspacePatchCaptureResult {
  captureWorkspacePatchAtRoundEnd: (ctx: WorkspacePatchRoundContext) => Promise<void>;
}

export function useWorkspacePatchCapture(
  args: UseWorkspacePatchCaptureArgs,
): UseWorkspacePatchCaptureResult {
  const { sandboxIdRef, repoRef, branchInfoRef, setConversations, dirtyConversationIdsRef } = args;

  const captureWorkspacePatchAtRoundEnd = useCallback(
    async (ctx: WorkspacePatchRoundContext): Promise<void> => {
      if (!shouldCaptureWorkspacePatch(ctx)) return;

      const sandboxId = sandboxIdRef.current;
      if (!sandboxId) return;

      const repoFullName = repoRef.current;
      const branch = branchInfoRef.current?.currentBranch;
      // We need both to build a well-formed card; the schema requires
      // non-empty strings. If either is missing, the round happened
      // outside a repo-scoped session (scratch mode) — nothing to persist.
      if (!repoFullName || !branch) return;

      // The loop snapshots the target message id synchronously at
      // round-end (see chat-round-loop.ts:fireWorkspacePatchCapture).
      // A null id means there was no tool-call message in the round,
      // which shouldn't happen when shouldCapture is true (Coder runs
      // via a delegate tool call) — log so we notice if the invariant
      // breaks.
      if (!ctx.assistantToolCallMessageId) {
        console.debug(
          '[WorkspacePatchCapture] no assistant tool-call message id — skipping capture',
          { chatId: ctx.chatId, round: ctx.round },
        );
        return;
      }
      const targetMessageId = ctx.assistantToolCallMessageId;

      try {
        const [diffCapture, headResult] = await Promise.all([
          fetchSandboxDiffWithMeta(sandboxId),
          execInSandbox(sandboxId, 'cd /workspace && git rev-parse HEAD'),
        ]);

        if (!diffCapture.diff) return; // V1: no card on empty diff.

        const baseSha = (headResult.stdout || '').trim();
        if (!baseSha) {
          console.debug(
            '[WorkspacePatchCapture] git rev-parse HEAD produced no output — skipping capture',
            { chatId: ctx.chatId, round: ctx.round },
          );
          return;
        }

        const card: ChatCard = {
          type: 'workspace-patch',
          data: buildWorkspacePatchCard({
            repoFullName,
            branch,
            baseSha,
            diffBytes: diffCapture.diff,
            truncated: diffCapture.truncated,
          }),
        };

        setConversations((prev) => {
          const conversation = prev[ctx.chatId];
          if (!conversation) return prev;
          const idx = conversation.messages.findIndex((m) => m.id === targetMessageId);
          if (idx < 0) {
            // Message was deleted (chat purge, branch fork migration,
            // etc.) between round-end and capture resolve. Skip
            // silently — the card has nowhere to land.
            return prev;
          }
          const target = conversation.messages[idx];
          const nextMessages = [...conversation.messages];
          nextMessages[idx] = {
            ...target,
            cards: [...(target.cards || []), card],
          };
          dirtyConversationIdsRef.current.add(ctx.chatId);
          return {
            ...prev,
            [ctx.chatId]: { ...conversation, messages: nextMessages },
          };
        });
      } catch (err) {
        console.debug('[WorkspacePatchCapture] capture failed:', err, {
          chatId: ctx.chatId,
          round: ctx.round,
        });
      }
    },
    [sandboxIdRef, repoRef, branchInfoRef, setConversations, dirtyConversationIdsRef],
  );

  return { captureWorkspacePatchAtRoundEnd };
}

function buildWorkspacePatchCard(input: {
  repoFullName: string;
  branch: string;
  baseSha: string;
  diffBytes: string;
  truncated: boolean;
}): WorkspacePatchCardData {
  return {
    schemaVersion: WORKSPACE_PATCH_CARD_SCHEMA_VERSION,
    repoFullName: input.repoFullName,
    branch: input.branch,
    baseSha: input.baseSha,
    diffBytes: input.diffBytes,
    truncated: input.truncated,
    capturedAt: Date.now(),
    applyState: { kind: 'pending' },
  };
}
