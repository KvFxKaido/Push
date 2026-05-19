import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  FolderGit2,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SendLiftIcon } from '@/components/icons/push-custom-icons';
import { useDraftChatComposer, type DraftChatSeed } from '@/hooks/useDraftChatComposer';
import { useBranchManager } from '@/hooks/useBranchManager';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import type { ActiveRepo, RepoWithActivity } from '@/types';
import type { RepoAppearance } from '@/lib/repo-appearance';

export interface ComposerDraftCommit {
  mode: 'repo' | 'chat' | 'scratch';
  repoFullName: string | null;
  branch: string | null;
  text: string;
}

interface ComposerDraftScreenProps {
  seed: DraftChatSeed | null;
  repos: RepoWithActivity[];
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  onCancel: () => void;
  onCommit: (commit: ComposerDraftCommit) => void;
}

const PILL_CLASS =
  'inline-flex items-center gap-1.5 rounded-full border border-push-edge-subtle bg-push-grad-input px-3 py-1.5 text-push-xs text-push-fg-secondary shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-colors hover:border-push-edge-hover hover:text-push-fg';

const MODE_OPTIONS: {
  mode: 'repo' | 'chat' | 'scratch';
  label: string;
  icon: typeof FolderGit2;
}[] = [
  { mode: 'repo', label: 'Repo', icon: FolderGit2 },
  { mode: 'chat', label: 'Chat', icon: MessageSquare },
  { mode: 'scratch', label: 'Scratch', icon: Sparkles },
];

export function ComposerDraftScreen({
  seed,
  repos,
  resolveRepoAppearance,
  onCancel,
  onCommit,
}: ComposerDraftScreenProps) {
  const draftActiveRepo: ActiveRepo | null = useMemo(() => {
    if (!seed?.repoFullName) return null;
    const repo = repos.find((r) => r.full_name === seed.repoFullName);
    if (!repo) return null;
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      owner: repo.owner,
      default_branch: repo.default_branch,
      current_branch: seed.branch || repo.default_branch,
      private: repo.private,
    };
  }, [repos, seed]);

  const branchManager = useBranchManager(
    draftActiveRepo,
    draftActiveRepo ? { id: 'draft', kind: 'repo', repo: draftActiveRepo, sandboxId: null } : null,
  );

  const { state, setMode, setRepo, setBranch, setText } = useDraftChatComposer({
    seed,
    repos,
    loadRepoBranches: branchManager.loadRepoBranches,
  });

  const [repoSheetOpen, setRepoSheetOpen] = useState(false);
  const [branchSheetOpen, setBranchSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');

  const selectedRepo = useMemo(
    () => repos.find((r) => r.full_name === state.repoFullName) ?? null,
    [repos, state.repoFullName],
  );

  const filteredRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => `${r.name} ${r.full_name}`.toLowerCase().includes(q));
  }, [repoQuery, repos]);

  const branchOptions = useMemo(() => {
    if (state.mode !== 'repo') return [];
    return branchManager.displayBranches;
  }, [branchManager.displayBranches, state.mode]);

  const trimmedText = state.text.trim();
  const isReadyToSend =
    trimmedText.length > 0 && (state.mode !== 'repo' || Boolean(state.repoFullName));

  const handleSend = () => {
    if (!isReadyToSend) return;
    onCommit({
      mode: state.mode,
      repoFullName: state.mode === 'repo' ? state.repoFullName : null,
      branch: state.mode === 'repo' ? state.branch : null,
      text: trimmedText,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSend();
    }
  };

  const modeLabel = MODE_OPTIONS.find((m) => m.mode === state.mode)?.label ?? 'Mode';
  const ModeIcon = MODE_OPTIONS.find((m) => m.mode === state.mode)?.icon ?? FolderGit2;

  return (
    <div className="relative flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom text-push-fg">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white/[0.03] to-transparent" />

      <header className="relative flex items-center justify-between px-4 pt-3">
        <button
          onClick={onCancel}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-push-fg-secondary transition-colors hover:bg-white/[0.04] hover:text-push-fg"
          aria-label="Cancel new chat"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="text-push-sm font-medium text-push-fg-secondary">New chat</div>
        <div className="h-9 w-9" aria-hidden />
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-3">
          <button onClick={() => setModeSheetOpen(true)} className={PILL_CLASS} aria-label="Mode">
            <ModeIcon className="h-3.5 w-3.5 text-push-fg-dim" />
            <span>{modeLabel}</span>
            <ChevronDown className="h-3 w-3 text-push-fg-dim" />
          </button>

          {state.mode === 'repo' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setRepoSheetOpen(true)}
                className={PILL_CLASS}
                aria-label="Select repository"
              >
                {selectedRepo ? (
                  <>
                    <RepoAppearanceBadge
                      appearance={resolveRepoAppearance(selectedRepo.full_name)}
                      className="h-4 w-4 rounded-sm"
                      iconClassName="h-2.5 w-2.5"
                    />
                    <span className="max-w-[180px] truncate">{selectedRepo.full_name}</span>
                  </>
                ) : (
                  <>
                    <Plus className="h-3.5 w-3.5 text-push-fg-dim" />
                    <span>Select repo</span>
                  </>
                )}
                <ChevronDown className="h-3 w-3 text-push-fg-dim" />
              </button>

              {selectedRepo && (
                <button
                  onClick={() => setBranchSheetOpen(true)}
                  className={PILL_CLASS}
                  aria-label="Select branch"
                  disabled={branchManager.repoBranchesLoading && branchOptions.length === 0}
                >
                  <span className="text-push-fg-dim">on</span>
                  <span className="max-w-[140px] truncate">
                    {state.branch || selectedRepo.default_branch || 'main'}
                  </span>
                  <ChevronDown className="h-3 w-3 text-push-fg-dim" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-push-edge/60 bg-[#040608] px-4 pb-4 pt-3">
        <div className="mx-auto flex w-full max-w-md flex-col gap-2">
          <div className="rounded-2xl border border-push-edge-subtle bg-push-grad-input shadow-[0_12px_34px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <textarea
              value={state.text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              rows={3}
              placeholder={
                state.mode === 'chat'
                  ? 'Ask anything…'
                  : state.mode === 'scratch'
                    ? 'Describe what you want to build…'
                    : state.repoFullName
                      ? 'Describe what you want to do in this repo…'
                      : 'Pick a repo to get started…'
              }
              className="block min-h-[3.25rem] w-full resize-none bg-transparent px-4 pt-3 text-push-sm text-push-fg outline-none placeholder:text-push-fg-dim"
            />
            <div className="flex items-center justify-end gap-2 px-2 pb-2">
              <button
                onClick={handleSend}
                disabled={!isReadyToSend}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-push-accent text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send"
              >
                <SendLiftIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
          <p className="text-center text-push-2xs text-push-fg-dim">
            Sends as a new chat in the selected context.
          </p>
        </div>
      </div>

      <Sheet open={modeSheetOpen} onOpenChange={setModeSheetOpen}>
        <SheetContent
          side="bottom"
          className="border-t border-push-edge bg-push-grad-panel px-0 pb-6 pt-0 text-push-fg"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle className="text-push-fg">Select mode</SheetTitle>
            <SheetDescription className="text-push-fg-muted">
              Choose how this chat should be scoped.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-1 px-3 pt-2">
            {MODE_OPTIONS.map(({ mode, label, icon: Icon }) => {
              const active = state.mode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => {
                    setMode(mode);
                    setModeSheetOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                    active ? 'bg-push-surface-raised/80' : 'hover:bg-push-surface-hover/60'
                  }`}
                >
                  <Icon className="h-4 w-4 text-push-fg-dim" />
                  <div className="flex-1">
                    <p className="text-push-sm text-push-fg">{label}</p>
                    <p className="text-push-2xs text-push-fg-muted">
                      {mode === 'repo'
                        ? 'Work on a GitHub repository'
                        : mode === 'chat'
                          ? 'Lightweight chat, no sandbox'
                          : 'Sandbox without a repo'}
                    </p>
                  </div>
                  {active && <Check className="h-4 w-4 text-push-link" />}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={repoSheetOpen} onOpenChange={setRepoSheetOpen}>
        <SheetContent
          side="bottom"
          className="h-[80dvh] border-t border-push-edge bg-push-grad-panel px-0 pb-0 pt-0 text-push-fg"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle className="flex items-center gap-2 text-push-fg">
              <Cloud className="h-4 w-4 text-push-fg-dim" />
              Select repository
            </SheetTitle>
            <SheetDescription className="text-push-fg-muted">
              Pick a repo for this chat.
            </SheetDescription>
          </SheetHeader>
          <div className="px-3 pb-2 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-push-fg-dim" />
              <input
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="Search repos"
                className="h-9 w-full rounded-full border border-push-edge-subtle bg-push-grad-input pl-9 pr-3 text-push-xs text-push-fg-secondary outline-none placeholder:text-push-fg-dim focus:border-push-sky/50"
              />
              {repoQuery && (
                <button
                  onClick={() => setRepoQuery('')}
                  className="absolute right-2 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-push-fg-dim hover:text-push-fg-secondary"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <div className="max-h-[58dvh] overflow-y-auto px-3 pb-5">
            {filteredRepos.length === 0 ? (
              <div className="rounded-xl border border-dashed border-push-edge/70 bg-push-surface/15 px-3 py-6 text-center text-push-sm text-push-fg-muted">
                No repositories match.
              </div>
            ) : (
              filteredRepos.map((repo) => {
                const active = state.repoFullName === repo.full_name;
                return (
                  <button
                    key={repo.id}
                    onClick={() => {
                      setRepo(repo.full_name);
                      setRepoSheetOpen(false);
                      setRepoQuery('');
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                      active ? 'bg-push-surface-raised/80' : 'hover:bg-push-surface-hover/60'
                    }`}
                  >
                    <RepoAppearanceBadge
                      appearance={resolveRepoAppearance(repo.full_name)}
                      className="h-7 w-7 rounded-md"
                      iconClassName="h-4 w-4"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-push-sm text-push-fg">{repo.full_name}</p>
                      <p className="truncate text-push-2xs text-push-fg-muted">
                        Default branch: {repo.default_branch}
                      </p>
                    </div>
                    {active && <Check className="h-4 w-4 text-push-link" />}
                  </button>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={branchSheetOpen} onOpenChange={setBranchSheetOpen}>
        <SheetContent
          side="bottom"
          className="border-t border-push-edge bg-push-grad-panel px-0 pb-6 pt-0 text-push-fg"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle className="text-push-fg">Select branch</SheetTitle>
            <SheetDescription className="text-push-fg-muted">
              {selectedRepo?.full_name ?? 'No repo selected'}
            </SheetDescription>
          </SheetHeader>
          <div className="max-h-[50dvh] overflow-y-auto px-3 pb-3 pt-2">
            {branchManager.repoBranchesLoading && branchOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-push-xs text-push-fg-muted">
                Loading branches…
              </div>
            ) : branchOptions.length === 0 ? (
              <div className="px-3 py-4 text-center text-push-xs text-push-fg-muted">
                No branches available.
              </div>
            ) : (
              branchOptions.map((branch) => {
                const active = (state.branch || selectedRepo?.default_branch) === branch.name;
                return (
                  <button
                    key={branch.name}
                    onClick={() => {
                      setBranch(branch.name);
                      setBranchSheetOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      active ? 'bg-push-surface-raised/80' : 'hover:bg-push-surface-hover/60'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-push-sm text-push-fg-secondary">
                      {branch.name}
                    </span>
                    {branch.isDefault && (
                      <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-push-2xs text-[#58a6ff]">
                        default
                      </span>
                    )}
                    {active && <Check className="h-4 w-4 text-push-link" />}
                  </button>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default ComposerDraftScreen;
