/**
 * useBranchSwitchActions — the UI-facing branch operations (fork / switch /
 * merge) plus the single chat-migration entry point they all route through.
 *
 * Extracted from `useChat` to keep that hook under its line cap. The four
 * callbacks are cohesive (every one funnels through `applyBranchSwitchPayload`)
 * and self-contained — nothing else in `useChat` references
 * `applyBranchSwitchFromUI`. `useChat` spreads the returned callbacks straight
 * into its public surface, so consumers are unchanged. Field types are reused
 * from `BranchForkMigrationContext` so no extra type plumbing is introduced.
 */

import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import {
  applyBranchSwitchPayload,
  type BranchForkMigrationContext,
} from '@/lib/branch-fork-migration';
import {
  forkBranchInWorkspace,
  switchBranchInWorkspace,
  type ForkBranchInWorkspaceResult,
  type SwitchBranchInWorkspaceResult,
} from '@/lib/fork-branch-in-workspace';
import type { BranchSwitchPayload, BranchSwitchSource } from '@/types';

export interface BranchSwitchActionsDeps {
  activeChatIdRef: BranchForkMigrationContext['activeChatIdRef'];
  conversationsRef: BranchForkMigrationContext['conversationsRef'];
  branchInfoRef: BranchForkMigrationContext['branchInfoRef'];
  skipAutoCreateRef: BranchForkMigrationContext['skipAutoCreateRef'];
  setConversations: BranchForkMigrationContext['setConversations'];
  dirtyConversationIdsRef: BranchForkMigrationContext['dirtyConversationIdsRef'];
  runtimeHandlersRef: BranchForkMigrationContext['runtimeHandlersRef'];
  sandboxIdRef: MutableRefObject<string | null>;
}

export interface BranchSwitchActions {
  applyBranchSwitchFromUI: (payload: BranchSwitchPayload) => void;
  forkBranchFromUI: (name: string, from?: string) => Promise<ForkBranchInWorkspaceResult>;
  switchBranchFromUI: (branch: string) => Promise<SwitchBranchInWorkspaceResult>;
  mergeBranchInUI: (
    toBranch: string,
    opts?: { from?: string; prNumber?: number; source?: BranchSwitchSource },
  ) => void;
}

export function useBranchSwitchActions(deps: BranchSwitchActionsDeps): BranchSwitchActions {
  const {
    activeChatIdRef,
    conversationsRef,
    branchInfoRef,
    skipAutoCreateRef,
    setConversations,
    dirtyConversationIdsRef,
    runtimeHandlersRef,
    sandboxIdRef,
  } = deps;

  // applyBranchSwitchPayload — single source of truth for chat migration, no
  // parallel implementation in the UI handlers.
  const applyBranchSwitchFromUI = useCallback(
    (payload: BranchSwitchPayload): void => {
      applyBranchSwitchPayload(payload, {
        activeChatIdRef,
        conversationsRef,
        branchInfoRef,
        skipAutoCreateRef,
        setConversations,
        dirtyConversationIdsRef,
        runtimeHandlersRef,
      });
    },
    [
      activeChatIdRef,
      conversationsRef,
      branchInfoRef,
      skipAutoCreateRef,
      setConversations,
      dirtyConversationIdsRef,
      runtimeHandlersRef,
    ],
  );

  const forkBranchFromUI = useCallback(
    async (name: string, from?: string): Promise<ForkBranchInWorkspaceResult> => {
      const result = await forkBranchInWorkspace(sandboxIdRef.current, name, from);
      if (!result.ok || !result.branchSwitch) return result;
      applyBranchSwitchFromUI(result.branchSwitch);
      return result;
    },
    [applyBranchSwitchFromUI, sandboxIdRef],
  );

  const switchBranchFromUI = useCallback(
    async (branch: string): Promise<SwitchBranchInWorkspaceResult> => {
      const result = await switchBranchInWorkspace(sandboxIdRef.current, branch);
      if (!result.ok || !result.branchSwitch) return result;
      applyBranchSwitchFromUI(result.branchSwitch);
      return result;
    },
    [applyBranchSwitchFromUI, sandboxIdRef],
  );

  // Post-merge migration: emit kind:'merged' through the shared dispatcher.
  const mergeBranchInUI = useCallback(
    (
      toBranch: string,
      opts?: { from?: string; prNumber?: number; source?: BranchSwitchSource },
    ): void => {
      applyBranchSwitchFromUI({
        name: toBranch,
        kind: 'merged',
        from: opts?.from,
        prNumber: opts?.prNumber,
        source: opts?.source ?? 'ui-merge',
      });
    },
    [applyBranchSwitchFromUI],
  );

  return { applyBranchSwitchFromUI, forkBranchFromUI, switchBranchFromUI, mergeBranchInUI };
}
