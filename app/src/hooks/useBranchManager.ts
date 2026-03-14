import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { fetchRepoBranches, executeDeleteBranch } from '@/lib/github-tools';
import type { ActiveRepo, WorkspaceSession } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
}

export interface BranchManager {
  repoBranches: BranchInfo[];
  repoBranchesLoading: boolean;
  repoBranchesError: string | null;
  displayBranches: BranchInfo[];
  branchMenuOpen: boolean;
  setBranchMenuOpen: (open: boolean) => void;
  pendingDeleteBranch: string | null;
  setPendingDeleteBranch: (branch: string | null) => void;
  deletingBranch: string | null;
  showBranchCreate: boolean;
  setShowBranchCreate: (open: boolean) => void;
  showMergeFlow: boolean;
  setShowMergeFlow: (open: boolean) => void;
  loadRepoBranches: (repoFullName: string) => Promise<void>;
  handleDeleteBranch: (branchName: string) => Promise<boolean>;
  currentBranch: string;
  isOnMain: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBranchManager(
  activeRepo: ActiveRepo | null,
  workspaceSession: WorkspaceSession | null,
): BranchManager {
  const [repoBranches, setRepoBranches] = useState<BranchInfo[]>([]);
  const [repoBranchesLoading, setRepoBranchesLoading] = useState(false);
  const [repoBranchesError, setRepoBranchesError] = useState<string | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [showBranchCreate, setShowBranchCreate] = useState(false);
  const [showMergeFlow, setShowMergeFlow] = useState(false);
  const branchFetchSeqRef = useRef(0);

  const activeRepoFullName = activeRepo?.full_name || null;
  const currentBranch = activeRepo?.current_branch || activeRepo?.default_branch || 'main';
  const isOnMain = currentBranch === (activeRepo?.default_branch || 'main');

  const displayBranches = useMemo(() => {
    if (!activeRepo) return repoBranches;
    if (!currentBranch) return repoBranches;
    if (repoBranches.some((b) => b.name === currentBranch)) return repoBranches;
    return [
      {
        name: currentBranch,
        isDefault: currentBranch === activeRepo.default_branch,
        isProtected: false,
      },
      ...repoBranches,
    ];
  }, [activeRepo, currentBranch, repoBranches]);

  const loadRepoBranches = useCallback(async (repoFullName: string) => {
    const seq = ++branchFetchSeqRef.current;
    setRepoBranchesLoading(true);
    setRepoBranchesError(null);
    try {
      const { branches } = await fetchRepoBranches(repoFullName, 500);
      if (seq !== branchFetchSeqRef.current) return;
      setRepoBranches(branches);
    } catch (err) {
      if (seq !== branchFetchSeqRef.current) return;
      setRepoBranches([]);
      setRepoBranchesError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      if (seq === branchFetchSeqRef.current) {
        setRepoBranchesLoading(false);
      }
    }
  }, []);

  // Auto-load branches when repo changes
  useEffect(() => {
    if (!activeRepoFullName || workspaceSession?.kind !== 'repo') {
      branchFetchSeqRef.current++;
      setRepoBranches([]);
      setRepoBranchesError(null);
      setRepoBranchesLoading(false);
      setBranchMenuOpen(false);
      setPendingDeleteBranch(null);
      setDeletingBranch(null);
      return;
    }
    setPendingDeleteBranch(null);
    setDeletingBranch(null);
    void loadRepoBranches(activeRepoFullName);
  }, [activeRepoFullName, workspaceSession, loadRepoBranches]);

  const handleDeleteBranch = useCallback(async (branchName: string): Promise<boolean> => {
    if (!activeRepo || workspaceSession?.kind !== 'repo') return false;
    const normalized = branchName.trim();
    if (!normalized) return false;

    const branchMeta = displayBranches.find((b) => b.name === normalized);
    const isDefaultBranch = normalized === activeRepo.default_branch || Boolean(branchMeta?.isDefault);
    const isProtectedBranch = Boolean(branchMeta?.isProtected);
    const isCurrentBranch = normalized === currentBranch;

    if (isCurrentBranch) {
      toast.error(`Cannot delete current branch "${normalized}"`);
      return false;
    }
    if (isDefaultBranch) {
      toast.error(`Cannot delete default branch "${normalized}"`);
      return false;
    }
    if (isProtectedBranch) {
      toast.error(`Cannot delete protected branch "${normalized}"`);
      return false;
    }

    setDeletingBranch(normalized);
    try {
      await executeDeleteBranch(activeRepo.full_name, normalized);
      toast.success(`Deleted branch "${normalized}"`);
      setPendingDeleteBranch(null);
      await loadRepoBranches(activeRepo.full_name);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^\[Tool Error\]\s*/, '') : 'Failed to delete branch';
      toast.error(message);
      return false;
    } finally {
      setDeletingBranch((prev) => (prev === normalized ? null : prev));
    }
  }, [activeRepo, currentBranch, displayBranches, workspaceSession, loadRepoBranches]);

  return {
    repoBranches,
    repoBranchesLoading,
    repoBranchesError,
    displayBranches,
    branchMenuOpen,
    setBranchMenuOpen,
    pendingDeleteBranch,
    setPendingDeleteBranch,
    deletingBranch,
    showBranchCreate,
    setShowBranchCreate,
    showMergeFlow,
    setShowMergeFlow,
    loadRepoBranches,
    handleDeleteBranch,
    currentBranch,
    isOnMain,
  };
}
