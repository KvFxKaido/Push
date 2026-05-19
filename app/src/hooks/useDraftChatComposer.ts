import { useCallback, useEffect, useState } from 'react';
import type { RepoWithActivity } from '@/types';

export type DraftChatMode = 'repo' | 'chat' | 'scratch';

export interface DraftChatState {
  mode: DraftChatMode;
  repoFullName: string | null;
  branch: string | null;
  text: string;
}

export interface DraftChatSeed {
  mode?: DraftChatMode;
  repoFullName?: string | null;
  branch?: string | null;
}

const EMPTY_STATE: DraftChatState = {
  mode: 'repo',
  repoFullName: null,
  branch: null,
  text: '',
};

function seedToState(seed: DraftChatSeed | null | undefined): DraftChatState {
  if (!seed) return { ...EMPTY_STATE };
  return {
    mode: seed.mode ?? (seed.repoFullName ? 'repo' : 'chat'),
    repoFullName: seed.repoFullName ?? null,
    branch: seed.branch ?? null,
    text: '',
  };
}

interface UseDraftChatComposerArgs {
  seed: DraftChatSeed | null;
  repos: RepoWithActivity[];
  loadRepoBranches: (repoFullName: string) => Promise<void> | void;
}

export function useDraftChatComposer({ seed, repos, loadRepoBranches }: UseDraftChatComposerArgs) {
  const [state, setState] = useState<DraftChatState>(() => seedToState(seed));

  // Re-seed when the composer is reopened with a new seed (key change in parent
  // resets the hook, but if the parent re-renders without remount, this keeps
  // state aligned with the latest seed).
  useEffect(() => {
    setState(seedToState(seed));
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

  const setText = useCallback((text: string) => {
    setState((prev) => ({ ...prev, text }));
  }, []);

  return {
    state,
    setMode,
    setRepo,
    setBranch,
    setText,
  };
}
