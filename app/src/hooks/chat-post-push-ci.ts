/**
 * chat-post-push-ci.ts
 *
 * Post-push CI status follow-up — the single owner of "a push just landed;
 * fetch the checks and put the result where the model can see it" (#1298
 * item 4). Consumed by three sites:
 *
 *   - the `prepare_push` approval path (push-kind card) in chat-card-actions
 *   - the commit-and-push approval path (commit-kind card) in chat-card-actions
 *   - the DIRECT `sandbox_push` tool arm, via side effect #9 in
 *     `applyPostExecutionSideEffects` (chat-send-helpers)
 *
 * The injected assistant message carries the compact per-check summary in its
 * `content` (model-visible on later turns), not just the `ci-status` card —
 * the card is UI-only, and a model that can't see the checks re-derives CI
 * state from predictions instead of facts.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatCard, ChatMessage, Conversation } from '@/types';
import { executeToolCall } from '@/lib/github-tools';
import { resolveMessageWriteBranch } from '@/lib/chat-message';
import { createId } from '@/hooks/chat-persistence';

/** Checks need a beat to spawn after the push lands before they're queryable. */
export const POST_PUSH_CI_DELAY_MS = 3000;

export interface PostPushCIDeps {
  chatId: string;
  repo: string;
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
}

/**
 * The model-visible message body: the fetch_checks result text minus its
 * `[Tool Result — …]` envelope header, under a stable lead line. The tool
 * text is already the compact summary (overall verdict + one icon line per
 * check) — reuse it rather than re-deriving from the card.
 */
export function buildPostPushCIContent(toolText: string): string {
  const summary = toolText.replace(/^\[Tool Result[^\]]*\]\n?/, '').trim();
  return summary ? `CI status after push:\n${summary}` : 'CI status after push:';
}

/**
 * Fetch CI checks for HEAD and shape the injectable message parts. Returns
 * null when the fetch fails or returns an error result — post-push CI is
 * best-effort and must never turn a successful push into a failure.
 */
export async function fetchPostPushCIStatus(
  repo: string,
): Promise<{ content: string; card: ChatCard | null } | null> {
  try {
    const result = await executeToolCall(
      { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
      repo,
    );
    if (result.text.includes('[Tool Error]')) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'post_push_ci_fetch_failed',
          repo,
          message: result.text.slice(0, 200),
        }),
      );
      return null;
    }
    return {
      content: buildPostPushCIContent(result.text),
      card: result.card && result.card.type === 'ci-status' ? result.card : null,
    };
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'post_push_ci_fetch_failed',
        repo,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Schedule the delayed CI fetch and inject the result as an assistant
 * message. Fire-and-forget by design: the push already succeeded, so every
 * failure branch logs (`post_push_ci_fetch_failed` ↔ `post_push_ci_injected`)
 * and drops out without touching chat state.
 */
export function schedulePostPushCIStatus(deps: PostPushCIDeps, opts?: { delayMs?: number }): void {
  const { chatId, repo, setConversations, dirtyConversationIdsRef, branchInfoRef } = deps;
  setTimeout(async () => {
    const status = await fetchPostPushCIStatus(repo);
    if (!status) return;

    const msg: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: status.content,
      timestamp: Date.now(),
      status: 'done',
      ...(status.card ? { cards: [status.card] } : {}),
    };
    setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      // Resolve the stamp inside the updater so it prefers the fresh
      // conversation branch over the possibly-stale live ref — this fires
      // seconds after the push, so the ref may have moved on.
      const branch = resolveMessageWriteBranch(branchInfoRef.current, conv.branch);
      const stamped = branch !== undefined ? { ...msg, branch } : msg;
      const updated = {
        ...prev,
        [chatId]: { ...conv, messages: [...conv.messages, stamped], lastMessageAt: Date.now() },
      };
      dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });
    console.log(JSON.stringify({ level: 'info', event: 'post_push_ci_injected', repo, chatId }));
  }, opts?.delayMs ?? POST_PUSH_CI_DELAY_MS);
}
