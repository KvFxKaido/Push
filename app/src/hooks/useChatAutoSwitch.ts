import type React from 'react';
import { useEffect, useRef } from 'react';
import { createId } from '@push/lib/id-utils';
import { saveActiveChatId } from '@/hooks/chat-persistence';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import { getMigrationMarker } from '@/lib/branch-migration-marker';
import type { Conversation } from '@/types';

// Decision function intentionally pure — `getMigrationMarker()` side effects
// are read once by the hook and passed in, so this stays unit-testable
// without touching localStorage. Keeps the auto-switch state machine
// (create / switch / noop) testable in isolation from the dispatch.
export interface AutoSwitchDecisionInput {
  sortedChatIds: string[];
  activeChatId: string;
  activeRepoFullName: string | null;
  skipAutoCreate: boolean;
  migrationActive: boolean;
}

export type AutoSwitchAction =
  | { kind: 'noop' }
  | { kind: 'create' }
  | { kind: 'switch'; chatId: string };

export function decideAutoSwitchAction(input: AutoSwitchDecisionInput): AutoSwitchAction {
  if (input.skipAutoCreate || input.migrationActive) return { kind: 'noop' };
  if (input.sortedChatIds.length === 0 && input.activeRepoFullName) {
    return { kind: 'create' };
  }
  if (input.sortedChatIds.length > 0 && !input.sortedChatIds.includes(input.activeChatId)) {
    return { kind: 'switch', chatId: input.sortedChatIds[0] };
  }
  return { kind: 'noop' };
}

export interface UseChatAutoSwitchParams {
  sortedChatIds: string[];
  activeChatId: string;
  activeRepoFullName: string | null;
  branchInfoRef: React.MutableRefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined
  >;
  // Typed as unknown because the caller's ref carries a MigrationGuard
  // payload, but this hook only cares whether it's set. Decoupling here
  // keeps useChatAutoSwitch independent of the migration-guard schema.
  skipAutoCreateRef: React.MutableRefObject<unknown>;
  updateConversations: (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => void;
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
  setActiveChatId: (id: string) => void;
}

// Drives auto-create-or-switch on (sortedChatIds, activeChatId, repo) changes.
// `autoCreateRef` is a per-tick reentrancy guard: the create branch sets it,
// React rerenders fire the effect again with the new chat in scope, and the
// setTimeout clears it on the next tick so a subsequent legitimate create
// (e.g. after a delete-all) isn't suppressed.
export function useChatAutoSwitch({
  sortedChatIds,
  activeChatId,
  activeRepoFullName,
  branchInfoRef,
  skipAutoCreateRef,
  updateConversations,
  dirtyConversationIdsRef,
  setActiveChatId,
}: UseChatAutoSwitchParams) {
  const autoCreateRef = useRef(false);

  useEffect(() => {
    const action = decideAutoSwitchAction({
      sortedChatIds,
      activeChatId,
      activeRepoFullName,
      skipAutoCreate: Boolean(skipAutoCreateRef.current),
      migrationActive: Boolean(getMigrationMarker()),
    });

    if (action.kind === 'create' && activeRepoFullName) {
      if (autoCreateRef.current) return;
      autoCreateRef.current = true;
      const id = createId();
      const bi = branchInfoRef.current;
      const branch = bi?.currentBranch || bi?.defaultBranch || 'main';
      const newConv: Conversation = {
        id,
        title: 'New Chat',
        messages: [],
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        repoFullName: activeRepoFullName,
        branch,
        verificationPolicy: getDefaultVerificationPolicy(),
      };
      updateConversations((prev) => {
        const updated = { ...prev, [id]: newConv };
        dirtyConversationIdsRef.current.add(id);
        return updated;
      });
      setActiveChatId(id);
      saveActiveChatId(id);
      setTimeout(() => {
        autoCreateRef.current = false;
      }, 0);
      return;
    }

    if (action.kind === 'switch') {
      setActiveChatId(action.chatId);
      saveActiveChatId(action.chatId);
    }
  }, [
    sortedChatIds,
    activeChatId,
    activeRepoFullName,
    updateConversations,
    skipAutoCreateRef,
    dirtyConversationIdsRef,
    branchInfoRef,
    setActiveChatId,
  ]);
}
