/**
 * chat-card-actions.ts
 *
 * Extracted from useChat.ts — the post-response UI workflow subsystem.
 * Handles commit review, CI refresh, sandbox state, ask-user, and editor cards.
 *
 * All dependencies threaded in explicitly; no closures over hook state.
 */

import { useCallback, useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  AIProviderType,
  AgentStatus,
  AgentStatusSource,
  CardAction,
  ChatCard,
  ChatMessage,
  CommitReviewCardData,
  Conversation,
  SandboxStateCardData,
} from '@/types';
import { execInSandbox, writeToSandbox } from '@/lib/sandbox-client';
import { computeSandboxPushPlan, createSandboxPushGit } from '@/lib/git-backend';
import { executeToolCall } from '@/lib/github-tools';
import type { ActiveProvider } from '@/lib/orchestrator';
import { executeSandboxToolCall } from '@/lib/sandbox-tools';
import { createId } from '@/hooks/chat-persistence';
import { resolveMessageWriteBranch } from '@/lib/chat-message';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { notifyWorkspaceMutation } from '@/lib/sandbox-mutation-signal';
import {
  resolveApproval,
  setApprovalCardInjector,
  setApprovalCardResolver,
} from '@/lib/approval-bridge';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ChatCardActionsParams {
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  activeChatId: string;
  sandboxIdRef: MutableRefObject<string | null>;
  isMainProtectedRef: MutableRefObject<boolean>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  repoRef: MutableRefObject<string | null>;
  lockedProvider?: AIProviderType | null;
  lockedModel?: string | null;
  updateAgentStatus: (
    status: AgentStatus,
    options?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  // Ref rather than callback: handleCardAction must always call the latest sendMessage
  // without taking it as a useCallback dependency (avoids stale closures in async paths).
  sendMessageRef: MutableRefObject<((text: string) => Promise<void>) | null>;
  isStreaming: boolean;
  messages: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatCardActions({
  setConversations,
  dirtyConversationIdsRef,
  activeChatId,
  sandboxIdRef,
  isMainProtectedRef,
  branchInfoRef,
  repoRef,
  lockedProvider,
  lockedModel,
  updateAgentStatus,
  sendMessageRef,
  isStreaming,
  messages,
}: ChatCardActionsParams) {
  const updateCardInMessage = useCallback(
    (
      chatId: string,
      messageId: string,
      cardIndex: number,
      updater: (card: ChatCard) => ChatCard,
    ) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msgs = conv.messages.map((msg) => {
          if (msg.id !== messageId || !msg.cards) return msg;
          const cards = msg.cards.map((card, i) => (i === cardIndex ? updater(card) : card));
          return { ...msg, cards };
        });
        const updated = { ...prev, [chatId]: { ...conv, messages: msgs } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [setConversations, dirtyConversationIdsRef],
  );

  const injectSyntheticMessage = useCallback(
    (chatId: string, content: string) => {
      const msg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'done',
      };
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        // Resolve the stamp inside the updater so it prefers the fresh
        // conversation branch over the possibly-stale live ref.
        const branch = resolveMessageWriteBranch(branchInfoRef.current, conv.branch);
        const stamped = branch !== undefined ? { ...msg, branch } : msg;
        const updated = {
          ...prev,
          [chatId]: { ...conv, messages: [...conv.messages, stamped], lastMessageAt: Date.now() },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [branchInfoRef, setConversations, dirtyConversationIdsRef],
  );

  const injectAssistantCardMessage = useCallback(
    (chatId: string, content: string, card: ChatCard) => {
      if (card.type === 'sandbox-state') {
        return;
      }
      const msg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'done',
        cards: [card],
      };
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const branch = resolveMessageWriteBranch(branchInfoRef.current, conv.branch);
        const stamped = branch !== undefined ? { ...msg, branch } : msg;
        const updated = {
          ...prev,
          [chatId]: { ...conv, messages: [...conv.messages, stamped], lastMessageAt: Date.now() },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [branchInfoRef, setConversations, dirtyConversationIdsRef],
  );

  // Flip an already-injected approval card to a terminal status by approvalId.
  // Used by the bridge's abort handler so a stopped turn's card stops showing
  // live Approve/Reject. Only touches still-'pending' cards, so it never
  // clobbers a card the user already resolved.
  const updateApprovalCardStatus = useCallback(
    (chatId: string, approvalId: string, status: 'expired') => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        let changed = false;
        const messages = conv.messages.map((m) => {
          if (
            !m.cards?.some(
              (c) =>
                c.type === 'approval' &&
                c.data.approvalId === approvalId &&
                c.data.status === 'pending',
            )
          ) {
            return m;
          }
          changed = true;
          return {
            ...m,
            cards: m.cards.map((c) =>
              c.type === 'approval' &&
              c.data.approvalId === approvalId &&
              c.data.status === 'pending'
                ? { ...c, data: { ...c.data, status } }
                : c,
            ),
          };
        });
        if (!changed) return prev;
        dirtyConversationIdsRef.current.add(chatId);
        return { ...prev, [chatId]: { ...conv, messages } };
      });
    },
    [setConversations, dirtyConversationIdsRef],
  );

  // Register the injector + resolver the approval bridge uses to surface and (on
  // Stop) expire a Confirmation card when a policy gate suspends a tool call
  // (lib/approval-bridge.ts → requestApproval routes here). Cleared on unmount
  // so a stale closure can't touch a torn-down chat.
  useEffect(() => {
    setApprovalCardInjector((chatId, data) =>
      injectAssistantCardMessage(chatId, '', { type: 'approval', data }),
    );
    setApprovalCardResolver(updateApprovalCardStatus);
    return () => {
      setApprovalCardInjector(null);
      setApprovalCardResolver(null);
    };
  }, [injectAssistantCardMessage, updateApprovalCardStatus]);

  const handleCardAction = useCallback(
    async (action: CardAction) => {
      const chatId = activeChatId;
      if (!chatId) return;

      const formatToolResultDetail = (text: string): string => {
        const trimmed = text.trim();
        if (!trimmed) return 'Unknown error';
        const lines = trimmed.split('\n');
        if (lines.length <= 1) return trimmed;
        return lines.slice(1).join('\n').trim() || lines[0];
      };

      switch (action.type) {
        case 'commit-refresh': {
          const sandboxId = sandboxIdRef.current;
          if (!sandboxId) {
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return {
                ...card,
                data: {
                  ...card.data,
                  status: 'error',
                  error: 'Sandbox expired. Start a new sandbox.',
                } as CommitReviewCardData,
              };
            });
            return;
          }

          // Gate-at-Push Move A: the review card is the push-time Auditor card.
          // Refresh re-runs `prepare_push` (re-audit the cumulative push diff) —
          // there is no commit-message to re-audit against; commits are silent
          // now. A legacy commit-kind card (from an old persisted conversation)
          // also refreshes as a push review, which is the coherent post-migration
          // behavior.
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'commit-review') return card;
            return {
              ...card,
              data: {
                ...card.data,
                status: 'refreshing',
                error: undefined,
              } as CommitReviewCardData,
            };
          });

          updateAgentStatus(
            { active: true, phase: 'Refreshing push review...' },
            { chatId, source: 'system' },
          );

          try {
            const refreshResult = await executeSandboxToolCall(
              { tool: 'prepare_push', args: {} },
              sandboxId,
              {
                auditorProviderOverride:
                  lockedProvider && lockedProvider !== 'demo'
                    ? (lockedProvider as ActiveProvider)
                    : undefined,
                auditorModelOverride: lockedModel ?? null,
              },
            );

            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              if (refreshResult.card?.type === 'commit-review') {
                return refreshResult.card;
              }
              if (refreshResult.card?.type === 'audit-verdict') {
                return {
                  ...card,
                  data: {
                    ...card.data,
                    auditVerdict: refreshResult.card.data,
                    status: 'error',
                    error: formatToolResultDetail(refreshResult.text),
                  } as CommitReviewCardData,
                };
              }
              return {
                ...card,
                data: {
                  ...card.data,
                  status: 'error',
                  error: formatToolResultDetail(refreshResult.text),
                } as CommitReviewCardData,
              };
            });
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'commit-approve': {
          const sandboxId = sandboxIdRef.current;
          if (!sandboxId) {
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return {
                ...card,
                data: {
                  ...card.data,
                  status: 'error',
                  error: 'Sandbox expired. Start a new sandbox.',
                } as CommitReviewCardData,
              };
            });
            return;
          }

          // Gate-at-Push Move A: a push-kind card's commits already exist
          // locally (made silently via sandbox_commit). Approval runs the PUSH
          // only through the gated PushGit path. The legacy commit-kind card
          // keeps the in-hook commit()+push() path below.
          const approveSourceCard = messages.find((m) => m.id === action.messageId)?.cards?.[
            action.cardIndex
          ];
          const isPushKind =
            approveSourceCard?.type === 'commit-review' && approveSourceCard.data.kind === 'push';

          // Enforce Protect Main for UI-driven delivery (early friendly error;
          // the push boundary gate is the authoritative backstop for push-kind).
          if (isMainProtectedRef.current) {
            try {
              const currentBranch = await createSandboxPushGit(sandboxId).currentBranch();
              const mainBranches = new Set(['main', 'master']);
              const defBranch = branchInfoRef.current?.defaultBranch;
              if (defBranch) mainBranches.add(defBranch);
              if (!currentBranch || mainBranches.has(currentBranch)) {
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return {
                    ...card,
                    data: {
                      ...card.data,
                      status: 'error',
                      error: 'Protect Main is enabled. Create a feature branch before delivering.',
                    } as CommitReviewCardData,
                  };
                });
                return;
              }
            } catch {
              // Fail-safe: block if we can't determine the branch
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return {
                  ...card,
                  data: {
                    ...card.data,
                    status: 'error',
                    error: 'Protect Main is enabled and branch could not be verified.',
                  } as CommitReviewCardData,
                };
              });
              return;
            }
          }

          // Step 1: Mark as approved (prevents double-tap)
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'commit-review') return card;
            return {
              ...card,
              data: {
                ...card.data,
                status: 'approved',
                ...(isPushKind ? {} : { commitMessage: action.commitMessage }),
              } as CommitReviewCardData,
            };
          });

          // --- Push-kind: commits already exist; ship via a direct gated push.
          if (isPushKind) {
            updateAgentStatus({ active: true, phase: 'Pushing...' }, { chatId, source: 'system' });
            try {
              // Staleness guard: this card's verdict was audited against a
              // specific HEAD and destination (branch, upstream, and origin's
              // resolved URL). If a sandbox_commit landed after the review, HEAD
              // moved; if a branch op happened at the same HEAD, the branch /
              // upstream moved while the HEAD pin still passes; if `git remote
              // set-url` repointed origin, the URL moved while HEAD, branch, and
              // the upstream *ref* all still match. Since the approved push
              // deliberately skips re-auditing, refuse stale cards and ask for a
              // refresh. Fail closed when any required pin is missing or unreadable.
              const approveSourceData =
                approveSourceCard?.type === 'commit-review' ? approveSourceCard.data : undefined;
              const auditedHeadSha = approveSourceData?.auditedHeadSha;
              const auditedBranch = approveSourceData?.auditedBranch;
              const auditedUpstream = approveSourceData?.auditedUpstream ?? null;
              const auditedRemoteUrl = approveSourceData?.auditedRemoteUrl;
              const pushGit = createSandboxPushGit(sandboxId);
              const [liveHeadSha, liveBranch, liveUpstream, liveRemoteUrl] = await Promise.all([
                pushGit.headSha(),
                pushGit.currentBranch(),
                pushGit.upstreamRef(),
                pushGit.remoteUrl('origin', { push: true }),
              ]);
              if (!auditedHeadSha || !liveHeadSha || liveHeadSha !== auditedHeadSha) {
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return {
                    ...card,
                    data: {
                      ...card.data,
                      status: 'error',
                      error:
                        'New commits since this review — refresh to re-audit the full diff before pushing.',
                    } as CommitReviewCardData,
                  };
                });
                return;
              }
              if (
                !auditedBranch ||
                !liveBranch ||
                liveBranch !== auditedBranch ||
                liveUpstream !== auditedUpstream
              ) {
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return {
                    ...card,
                    data: {
                      ...card.data,
                      status: 'error',
                      error:
                        'Branch destination changed since this review — refresh to re-audit before pushing.',
                    } as CommitReviewCardData,
                  };
                });
                return;
              }
              // Remote-identity guard: the upstream *ref* (`origin/foo`) survives
              // a `git remote set-url origin <other>` or `remote.origin.pushurl`
              // change, so HEAD + branch + upstream can all still match while
              // origin now pushes to a different repo. Pin and re-verify origin's
              // resolved push URL; fail closed when it's missing (legacy card /
              // no remote) or has moved.
              if (!auditedRemoteUrl || !liveRemoteUrl || liveRemoteUrl !== auditedRemoteUrl) {
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return {
                    ...card,
                    data: {
                      ...card.data,
                      status: 'error',
                      error:
                        'Remote identity changed since this review — origin was repointed; refresh to re-audit before pushing.',
                    } as CommitReviewCardData,
                  };
                });
                return;
              }

              // Force-with-lease guard: the verdict was audited against the diff
              // base origin had at review time. If origin's tip for this branch
              // moved since (a teammate pushed, CI amended), the audited diff no
              // longer describes what ships — git would reject it non-fast-forward
              // and any reconcile would be unaudited. Re-read the live tip the
              // same way prepare_push pinned it and refuse on drift. Only enforced
              // when a lease was actually pinned (origin reachable at audit time);
              // a live read failure fails closed but retryable, since "can't
              // confirm the remote didn't move" is exactly what this guard exists
              // to refuse. (git-sync's --force-with-lease, applied at our gate.)
              const auditedRemoteTipSha = approveSourceData?.auditedRemoteTipSha;
              if (auditedRemoteTipSha) {
                const livePlan = await computeSandboxPushPlan(sandboxId, undefined, {
                  ref: liveBranch,
                });
                if (!livePlan.leaseEstablished) {
                  updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                    if (card.type !== 'commit-review') return card;
                    return {
                      ...card,
                      data: {
                        ...card.data,
                        status: 'error',
                        error:
                          'Could not reach origin to confirm the remote tip before pushing — retry to verify.',
                      } as CommitReviewCardData,
                    };
                  });
                  return;
                }
                // `leasedRemoteSha` re-read here is origin's CURRENT live tip (the
                // plan recomputes it); `auditedRemoteTipSha` is the historical lease
                // pinned at review time. Drift between the two means origin moved.
                const liveRemoteTip = livePlan.leasedRemoteSha;
                if (liveRemoteTip !== auditedRemoteTipSha) {
                  updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                    if (card.type !== 'commit-review') return card;
                    return {
                      ...card,
                      data: {
                        ...card.data,
                        status: 'error',
                        error:
                          'Origin moved since this review — the remote branch advanced; refresh to re-audit against the new base before pushing.',
                      } as CommitReviewCardData,
                    };
                  });
                  return;
                }
              }

              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return {
                  ...card,
                  data: { ...card.data, status: 'pushing' } as CommitReviewCardData,
                };
              });

              // Re-run only the CHEAP DETERMINISTIC gates at execution (Protect
              // Main + secret scan — they can't drift). The expensive,
              // non-deterministic Auditor already ran at prepare_push and its
              // verdict is on this card; re-running it here would risk flipping
              // an already-approved SAFE delivery to UNSAFE. The push-time
              // Auditor gate stays ON for DIRECT sandbox_push calls that bypass
              // prepare_push (this approved path is not one of those).
              const pushResult = await createSandboxPushGit(sandboxId, {
                secretScan: true,
                protectMain: isMainProtectedRef.current,
                defaultBranch: branchInfoRef.current?.defaultBranch,
              }).push();

              if (!pushResult.ok) {
                // A gate block (Protect Main / secret scan) reads cleanly on its
                // own; a real push failure keeps the "Push failed:" prefix.
                const pushErrorDetail = pushResult.stderr || pushResult.stdout || 'Unknown error';
                const errorText = pushResult.blocked
                  ? pushErrorDetail
                  : `Push failed: ${pushErrorDetail}`;
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return {
                    ...card,
                    data: {
                      ...card.data,
                      status: 'error',
                      error: errorText,
                    } as CommitReviewCardData,
                  };
                });
                return;
              }

              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                const committedBranch = branchInfoRef.current?.currentBranch || undefined;
                const defaultBranch = branchInfoRef.current?.defaultBranch || undefined;
                return {
                  ...card,
                  data: {
                    ...card.data,
                    status: 'committed',
                    committedBranch,
                    defaultBranch,
                  } as CommitReviewCardData,
                };
              });

              injectSyntheticMessage(chatId, 'Pushed to the remote.');

              // Auto-fetch CI after 3s delay (same as the commit-kind path).
              const repo = repoRef.current;
              if (repo) {
                setTimeout(async () => {
                  try {
                    const ciResult = await executeToolCall(
                      { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
                      repo,
                    );
                    if (ciResult.card) {
                      const ciMsg: ChatMessage = {
                        id: createId(),
                        role: 'assistant',
                        content: 'CI status after push:',
                        timestamp: Date.now(),
                        status: 'done',
                        cards: [ciResult.card],
                      };
                      setConversations((prev) => {
                        const conv = prev[chatId];
                        if (!conv) return prev;
                        // Stamp from the fresh conversation branch — this fires in a
                        // setTimeout after push, so the live ref may have moved on.
                        const branch = resolveMessageWriteBranch(
                          branchInfoRef.current,
                          conv.branch,
                        );
                        const stamped = branch !== undefined ? { ...ciMsg, branch } : ciMsg;
                        const updated = {
                          ...prev,
                          [chatId]: {
                            ...conv,
                            messages: [...conv.messages, stamped],
                            lastMessageAt: Date.now(),
                          },
                        };
                        dirtyConversationIdsRef.current.add(chatId);
                        return updated;
                      });
                    }
                  } catch {
                    // CI fetch is best-effort
                  }
                }, 3000);
              }
            } finally {
              updateAgentStatus({ active: false, phase: '' });
            }
            break;
          }

          updateAgentStatus(
            { active: true, phase: 'Committing & pushing...' },
            { chatId, source: 'system' },
          );

          try {
            const normalizedCommitMessage = action.commitMessage.replace(/[\r\n]+/g, ' ').trim();
            if (!normalizedCommitMessage) {
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return {
                  ...card,
                  data: {
                    ...card.data,
                    status: 'error',
                    error: 'Commit message cannot be empty.',
                  } as CommitReviewCardData,
                };
              });
              return;
            }

            // Step 2: Commit via the sanctioned backend write. The Auditor
            // already ran at the prepare step, so this approved commit needs no
            // gate; the backend shell-escapes the message and marks the
            // workspace mutated.
            const pushGit = createSandboxPushGit(sandboxId, { secretScan: true });
            // Non-blocking desync check: warn (don't block) if the sandbox HEAD
            // drifted from the branch Push tracks as active. PushGit only
            // verifies the invariant; any future enforcement is the caller's.
            const expectedBranch = branchInfoRef.current?.currentBranch;
            if (expectedBranch) {
              try {
                const branchCheck = await pushGit.validateActiveBranch(expectedBranch);
                if (!branchCheck.inSync) {
                  console.warn(
                    `[commit] sandbox HEAD (${branchCheck.actual ?? 'detached'}) differs from tracked branch (${branchCheck.expected}); committing anyway.`,
                  );
                }
              } catch (err) {
                // Best-effort observability — a failing/slow desync check must
                // never block or fail the commit itself.
                console.warn('[commit] branch validation failed:', err);
              }
            }
            const commit = await pushGit.commit({ message: normalizedCommitMessage });

            if (!commit.ok) {
              notifyWorkspaceMutation(sandboxId);
              const errorDetail = commit.result?.stderr || commit.result?.stdout || 'Unknown error';
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return {
                  ...card,
                  data: {
                    ...card.data,
                    status: 'error',
                    error: `Commit failed: ${errorDetail}`,
                  } as CommitReviewCardData,
                };
              });
              return;
            }

            // Step 3: Push
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return { ...card, data: { ...card.data, status: 'pushing' } as CommitReviewCardData };
            });

            const pushResult = await pushGit.push();

            if (!pushResult.ok) {
              // A secret-scan block reads cleanly on its own; a real push
              // failure keeps the "Push failed:" prefix.
              const pushErrorDetail = pushResult.stderr || pushResult.stdout || 'Unknown error';
              const errorText = pushResult.blocked
                ? pushErrorDetail
                : `Push failed: ${pushErrorDetail}`;
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return {
                  ...card,
                  data: {
                    ...card.data,
                    status: 'error',
                    error: errorText,
                  } as CommitReviewCardData,
                };
              });
              return;
            }

            // Step 4: Success
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              const committedBranch =
                branchInfoRef.current?.currentBranch || expectedBranch || undefined;
              const defaultBranch = branchInfoRef.current?.defaultBranch || undefined;
              return {
                ...card,
                data: {
                  ...card.data,
                  status: 'committed',
                  committedBranch,
                  defaultBranch,
                } as CommitReviewCardData,
              };
            });

            injectSyntheticMessage(chatId, `Committed and pushed: "${action.commitMessage}"`);

            // Step 5: Auto-fetch CI after 3s delay
            const repo = repoRef.current;
            if (repo) {
              setTimeout(async () => {
                try {
                  const ciResult = await executeToolCall(
                    { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
                    repo,
                  );
                  if (ciResult.card) {
                    const ciMsg: ChatMessage = {
                      id: createId(),
                      role: 'assistant',
                      content: 'CI status after push:',
                      timestamp: Date.now(),
                      status: 'done',
                      cards: [ciResult.card],
                    };
                    setConversations((prev) => {
                      const conv = prev[chatId];
                      if (!conv) return prev;
                      // Stamp from the fresh conversation branch — this fires in a
                      // setTimeout after push, so the live ref may have moved on.
                      const branch = resolveMessageWriteBranch(branchInfoRef.current, conv.branch);
                      const stamped = branch !== undefined ? { ...ciMsg, branch } : ciMsg;
                      const updated = {
                        ...prev,
                        [chatId]: {
                          ...conv,
                          messages: [...conv.messages, stamped],
                          lastMessageAt: Date.now(),
                        },
                      };
                      dirtyConversationIdsRef.current.add(chatId);
                      return updated;
                    });
                  }
                } catch {
                  // CI fetch is best-effort
                }
              }, 3000);
            }
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'commit-reject': {
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'commit-review') return card;
            return { ...card, data: { ...card.data, status: 'rejected' } as CommitReviewCardData };
          });
          injectSyntheticMessage(chatId, 'Commit cancelled.');
          break;
        }

        case 'ci-refresh': {
          const repo = repoRef.current;
          if (!repo) return;

          updateAgentStatus(
            { active: true, phase: 'Refreshing CI status...' },
            { chatId, source: 'system' },
          );
          try {
            const ciResult = await executeToolCall(
              { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
              repo,
            );
            if (ciResult.card && ciResult.card.type === 'ci-status') {
              updateCardInMessage(chatId, action.messageId, action.cardIndex, () => ciResult.card!);
            }
          } catch {
            // Best-effort
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'sandbox-state-refresh': {
          updateAgentStatus(
            { active: true, phase: 'Refreshing sandbox state...' },
            { chatId, source: 'system' },
          );
          try {
            const statusResult = await execInSandbox(
              action.sandboxId,
              'cd /workspace && git status -sb --porcelain=1',
            );
            if (statusResult.exitCode !== 0) {
              break;
            }

            const lines = statusResult.stdout
              .split('\n')
              .map((line) => line.trimEnd())
              .filter(Boolean);
            const statusLine =
              lines
                .find((line) => line.startsWith('##'))
                ?.slice(2)
                .trim() || 'unknown';
            const branch = statusLine.split('...')[0].trim() || 'unknown';
            const entries = lines.filter((line) => !line.startsWith('##'));

            let stagedFiles = 0;
            let unstagedFiles = 0;
            let untrackedFiles = 0;

            for (const entry of entries) {
              const x = entry[0] || ' ';
              const y = entry[1] || ' ';
              if (x === '?' && y === '?') {
                untrackedFiles++;
                continue;
              }
              if (x !== ' ') stagedFiles++;
              if (y !== ' ') unstagedFiles++;
            }

            const nextData: SandboxStateCardData = {
              sandboxId: action.sandboxId,
              repoPath: '/workspace',
              branch,
              statusLine,
              changedFiles: entries.length,
              stagedFiles,
              unstagedFiles,
              untrackedFiles,
              preview: entries
                .slice(0, 6)
                .map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line)),
              fetchedAt: new Date().toISOString(),
            };

            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'sandbox-state') return card;
              return { ...card, data: nextData };
            });
          } catch {
            // Best-effort refresh
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'ask-user-submit': {
          const responseText = action.responseText.trim();
          if (!responseText || isStreaming || !sendMessageRef.current) {
            return;
          }

          const sourceMessage = messages.find((message) => message.id === action.messageId);
          const sourceCard = sourceMessage?.cards?.[action.cardIndex];
          const question = sourceCard?.type === 'ask-user' ? sourceCard.data.question.trim() : '';

          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'ask-user') return card;
            return {
              ...card,
              data: {
                ...card.data,
                responseText,
                selectedOptionIds: action.selectedOptionIds,
              },
            };
          });

          const contextualReply = question
            ? `Answer to your question "${question}": ${responseText}`
            : responseText;

          await sendMessageRef.current(contextualReply);
          break;
        }

        case 'editor-save': {
          updateAgentStatus(
            { active: true, phase: 'Saving file...' },
            { chatId, source: 'system' },
          );
          try {
            const writeResult = await writeToSandbox(
              action.sandboxId,
              action.path,
              action.content,
              action.expectedVersion,
              action.expectedWorkspaceRevision,
            );

            if (!writeResult.ok) {
              if (writeResult.code === 'WORKSPACE_CHANGED') {
                const expected =
                  writeResult.expected_workspace_revision ??
                  action.expectedWorkspaceRevision ??
                  'unknown';
                const current =
                  writeResult.current_workspace_revision ??
                  writeResult.workspace_revision ??
                  'unknown';
                injectSyntheticMessage(
                  chatId,
                  `Save blocked for ${action.path}: workspace changed since last read (expected revision ${expected}, current ${current}). Re-open and retry.`,
                );
              } else if (writeResult.code === 'STALE_FILE') {
                const expected =
                  writeResult.expected_version || action.expectedVersion || 'unknown';
                const current = writeResult.current_version || 'missing';
                injectSyntheticMessage(
                  chatId,
                  `Save blocked for ${action.path}: file changed since last read (expected ${expected}, current ${current}). Re-open and retry.`,
                );
              } else {
                injectSyntheticMessage(
                  chatId,
                  `Save failed for ${action.path}: ${writeResult.error || 'Unknown error'}`,
                );
              }
              break;
            }

            fileLedger.recordMutation(action.path, 'user');
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'editor') return card;
              return {
                ...card,
                data: {
                  ...card.data,
                  content: action.content,
                  truncated: false,
                  version:
                    typeof writeResult.new_version === 'string'
                      ? writeResult.new_version
                      : card.data.version,
                  workspaceRevision:
                    typeof writeResult.workspace_revision === 'number'
                      ? writeResult.workspace_revision
                      : card.data.workspaceRevision,
                },
              };
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            injectSyntheticMessage(chatId, `Save failed for ${action.path}: ${message}`);
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'approval-approve':
        case 'approval-reject': {
          // Runtime-driven approval: release the suspended tool call, then flip
          // the card to match. Only mark approved/rejected when a waiter was
          // actually released — a stale card (refreshed, or already settled by
          // Stop/abort) has none, so resolveApproval returns false and we mark
          // it 'expired' rather than falsely reporting an action that never ran.
          const approved = action.type === 'approval-approve';
          const settled = resolveApproval(action.approvalId, approved);
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'approval') return card;
            const status = settled ? (approved ? 'approved' : 'rejected') : 'expired';
            return { ...card, data: { ...card.data, status } };
          });
          break;
        }
      }
    },
    [
      activeChatId,
      branchInfoRef,
      dirtyConversationIdsRef,
      injectSyntheticMessage,
      isMainProtectedRef,
      isStreaming,
      lockedModel,
      lockedProvider,
      messages,
      repoRef,
      sandboxIdRef,
      sendMessageRef,
      setConversations,
      updateAgentStatus,
      updateCardInMessage,
    ],
  );

  return {
    updateCardInMessage,
    injectSyntheticMessage,
    injectAssistantCardMessage,
    handleCardAction,
  };
}
