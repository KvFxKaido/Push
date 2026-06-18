/**
 * chat-card-actions.ts
 *
 * Extracted from useChat.ts — the post-response UI workflow subsystem.
 * Handles commit review, CI refresh, sandbox state, ask-user, and editor cards.
 *
 * All dependencies threaded in explicitly; no closures over hook state.
 */

import { useCallback } from 'react';
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
import { createSandboxPushGit } from '@/lib/git-backend';
import { executeToolCall } from '@/lib/github-tools';
import type { ActiveProvider } from '@/lib/orchestrator';
import { executeSandboxToolCall } from '@/lib/sandbox-tools';
import { createId } from '@/hooks/chat-persistence';
import { fileLedger } from '@/lib/file-awareness-ledger';

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
        const updated = {
          ...prev,
          [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [setConversations, dirtyConversationIdsRef],
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
        const updated = {
          ...prev,
          [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [setConversations, dirtyConversationIdsRef],
  );

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
          // only — routed through the sandbox_push tool so the full gate
          // (Protect Main boundary, secret scan, Auditor) re-runs at execution,
          // with no second commit + push code path to drift. The legacy
          // commit-kind card keeps the in-hook commit()+push() path below.
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

          // --- Push-kind: commits already exist; ship via the sandbox_push tool.
          if (isPushKind) {
            updateAgentStatus({ active: true, phase: 'Pushing...' }, { chatId, source: 'system' });
            try {
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
                        const updated = {
                          ...prev,
                          [chatId]: {
                            ...conv,
                            messages: [...conv.messages, ciMsg],
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
                      const updated = {
                        ...prev,
                        [chatId]: {
                          ...conv,
                          messages: [...conv.messages, ciMsg],
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
