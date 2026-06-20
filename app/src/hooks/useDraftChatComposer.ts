import { useCallback, useEffect, useState } from 'react';
import type { PreferredProvider } from '@/lib/providers';
import type { RepoWithActivity } from '@/types';

export type DraftChatMode = 'repo' | 'chat' | 'scratch';

export interface DraftChatState {
  mode: DraftChatMode;
  repoFullName: string | null;
  branch: string | null;
  /** When null, the workspace falls back to its default provider (the
   * one Settings selects). The pre-flight menu only overrides on
   * explicit pick — "Default" stays Default. */
  provider: PreferredProvider | null;
  /** Model id within `provider`. Null lets the workspace pick the
   * remembered or catalog default for the provider. */
  model: string | null;
}

export interface DraftChatSeed {
  mode?: DraftChatMode;
  repoFullName?: string | null;
  branch?: string | null;
  provider?: PreferredProvider | null;
  model?: string | null;
}

const EMPTY_STATE: DraftChatState = {
  mode: 'repo',
  repoFullName: null,
  branch: null,
  provider: null,
  model: null,
};

function seedToState(seed: DraftChatSeed | null | undefined): DraftChatState {
  if (!seed) return { ...EMPTY_STATE };
  return {
    mode: seed.mode ?? (seed.repoFullName ? 'repo' : 'chat'),
    repoFullName: seed.repoFullName ?? null,
    branch: seed.branch ?? null,
    provider: seed.provider ?? null,
    model: seed.model ?? null,
  };
}

interface UseDraftChatComposerArgs {
  seed: DraftChatSeed | null;
  repos: RepoWithActivity[];
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
}

export function useDraftChatComposer({ seed, repos, loadRepoBranches }: UseDraftChatComposerArgs) {
  const [state, setState] = useState<DraftChatState>(() => seedToState(seed));

  // Re-seed when the menu is reopened with a new seed (key change in
  // parent resets the hook, but if the parent re-renders without
  // remount, this keeps state aligned with the latest seed).
  useEffect(() => {
    const id = setTimeout(() => setState(seedToState(seed)), 0);
    return () => clearTimeout(id);
  }, [seed]);

  // Trigger branch fetch whenever a repo is selected. Safe to call repeatedly —
  // `loadRepoBranches` is idempotent.
  useEffect(() => {
    if (state.mode === 'repo' && state.repoFullName) {
      void loadRepoBranches(state.repoFullName);
    }
  }, [state.mode, state.repoFullName, loadRepoBranches]);

  const setMode = useCallback((mode: DraftChatMode) => {
    setState((prev) => {
      if (prev.mode === mode) return prev;
      // Clear repo/branch when leaving repo mode so the pills hide cleanly.
      if (mode !== 'repo') return { ...prev, mode, repoFullName: null, branch: null };
      return { ...prev, mode };
    });
  }, []);

  const setRepo = useCallback(
    (repoFullName: string | null, branch?: string | null) => {
      setState((prev) => {
        if (!repoFullName) return { ...prev, repoFullName: null, branch: null };
        const repo = repos.find((r) => r.full_name === repoFullName);
        const defaultBranch = repo?.default_branch ?? null;
        return {
          ...prev,
          mode: 'repo',
          repoFullName,
          branch: branch ?? defaultBranch,
        };
      });
    },
    [repos],
  );

  const setBranch = useCallback((branch: string | null) => {
    setState((prev) => ({ ...prev, branch }));
  }, []);

  const setProvider = useCallback((provider: PreferredProvider | null, model?: string | null) => {
    setState((prev) => ({
      ...prev,
      provider,
      // When provider changes, default the model unless the caller
      // supplied a specific one. `null` keeps the workspace's own
      // resolution (remembered or catalog default).
      model: model === undefined ? null : model,
    }));
  }, []);

  const setModel = useCallback((model: string | null) => {
    setState((prev) => ({ ...prev, model }));
  }, []);

  return {
    state,
    setMode,
    setRepo,
    setBranch,
    setProvider,
    setModel,
  };
}
