import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { setConversationVerificationState } from '@/lib/chat-runtime-state';
import {
  getDefaultVerificationPolicy,
  resolveVerificationPolicy,
  type VerificationPolicy,
} from '@/lib/verification-policy';
import { hydrateVerificationRuntimeState } from '@/lib/verification-runtime';
import type {
  Conversation,
  VerificationRuntimeState,
  WorkspaceContext,
  WorkspaceMode,
} from '@/types';

export interface UseVerificationStateParams {
  activeChatId: string;
  activeConversationVerificationPolicy: VerificationPolicy | undefined;
  activeChatIdRef: React.MutableRefObject<string>;
  conversationsRef: React.MutableRefObject<Record<string, Conversation>>;
  updateConversations: (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => void;
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
}

export interface UseVerificationStateResult {
  getVerificationPolicyForChat: (chatId: string | null | undefined) => VerificationPolicy;
  getVerificationStateForChat: (chatId: string | null | undefined) => VerificationRuntimeState;
  writeVerificationStateForChat: (chatId: string, state: VerificationRuntimeState) => void;
  setWorkspaceContext: (ctx: WorkspaceContext | null) => void;
  setWorkspaceMode: (mode: WorkspaceMode | null) => void;
  workspaceContextRef: React.MutableRefObject<WorkspaceContext | null>;
  workspaceModeRef: React.MutableRefObject<WorkspaceMode | null>;
}

// Owns the verification + workspace-context cluster split across useChat.
// The hook is deliberately scoped to pure verification/workspace logic;
// the journal-write side of persistVerificationState stays in useChat as
// a composition wrapper because runJournalEntryRef + persistRunJournal
// live in useRunEngine and wiring both hooks bidirectionally would create
// a circular dep at call time. `writeVerificationStateForChat` is the
// hook's ref+conversation write primitive; useChat composes it with the
// journal write into the familiar `persistVerificationState` name.
//
// `verificationStateByChatRef` and `baseWorkspaceContextRef` stay
// private -- no external reader needs either. `applyWorkspaceContext`
// is also private -- its only callers are `setWorkspaceContext` and
// the workspace-apply effect, both inside this hook.
export function useVerificationState({
  activeChatId,
  activeConversationVerificationPolicy,
  activeChatIdRef,
  conversationsRef,
  updateConversations,
  dirtyConversationIdsRef,
}: UseVerificationStateParams): UseVerificationStateResult {
  const verificationStateByChatRef = useRef<Record<string, VerificationRuntimeState>>({});
  const workspaceContextRef = useRef<WorkspaceContext | null>(null);
  const workspaceModeRef = useRef<WorkspaceMode | null>(null);
  const baseWorkspaceContextRef = useRef<WorkspaceContext | null>(null);

  const getVerificationPolicyForChat = useCallback(
    (chatId: string | null | undefined): VerificationPolicy => {
      if (!chatId) return getDefaultVerificationPolicy();
      return resolveVerificationPolicy(conversationsRef.current[chatId]?.verificationPolicy);
    },
    [conversationsRef],
  );

  const getVerificationStateForChat = useCallback(
    (chatId: string | null | undefined): VerificationRuntimeState => {
      const policy = getVerificationPolicyForChat(chatId);
      const key = chatId || '';
      const cached = verificationStateByChatRef.current[key];
      const persisted = chatId
        ? conversationsRef.current[chatId]?.runState?.verificationState
        : undefined;
      const hydrated = hydrateVerificationRuntimeState(policy, cached ?? persisted);
      verificationStateByChatRef.current[key] = hydrated;
      return hydrated;
    },
    [getVerificationPolicyForChat, conversationsRef],
  );

  const writeVerificationStateForChat = useCallback(
    (chatId: string, verificationState: VerificationRuntimeState) => {
      verificationStateByChatRef.current[chatId] = verificationState;
      updateConversations((prev) => {
        const conversation = prev[chatId];
        if (!conversation) return prev;
        dirtyConversationIdsRef.current.add(chatId);
        return {
          ...prev,
          [chatId]: setConversationVerificationState(conversation, verificationState),
        };
      });
    },
    [updateConversations, dirtyConversationIdsRef],
  );

  const applyWorkspaceContext = useCallback(
    (ctx: WorkspaceContext | null, chatId: string | null) => {
      if (!ctx) {
        workspaceContextRef.current = null;
        return;
      }
      workspaceContextRef.current = {
        ...ctx,
        verificationPolicy: getVerificationPolicyForChat(chatId),
      };
    },
    [getVerificationPolicyForChat],
  );

  const setWorkspaceContext = useCallback(
    (ctx: WorkspaceContext | null) => {
      baseWorkspaceContextRef.current = ctx;
      workspaceModeRef.current = ctx?.mode ?? null;
      applyWorkspaceContext(ctx, activeChatIdRef.current);
    },
    [applyWorkspaceContext, activeChatIdRef],
  );

  // Synchronous mode setter -- call during render to avoid stale ref
  // between workspace transitions.
  const setWorkspaceMode = useCallback((mode: WorkspaceMode | null) => {
    workspaceModeRef.current = mode;
  }, []);

  useEffect(() => {
    applyWorkspaceContext(baseWorkspaceContextRef.current, activeChatId);
  }, [activeChatId, activeConversationVerificationPolicy, applyWorkspaceContext]);

  return {
    getVerificationPolicyForChat,
    getVerificationStateForChat,
    writeVerificationStateForChat,
    setWorkspaceContext,
    setWorkspaceMode,
    workspaceContextRef,
    workspaceModeRef,
  };
}
