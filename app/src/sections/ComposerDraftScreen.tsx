import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
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
import { useDraftChatComposer, type DraftChatSeed } from '@/hooks/useDraftChatComposer';
import { useBranchManager } from '@/hooks/useBranchManager';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { formatModelDisplayName, type PreferredProvider } from '@/lib/providers';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { ActiveRepo, RepoWithActivity } from '@/types';
import { getRepoAppearanceColorHex, type RepoAppearance } from '@/lib/repo-appearance';

// The composer is where you pick the mode you're about to enter, so its glow
// previews that destination: indigo for chat, emerald for scratch, and the
// chosen repo's own accent in repo mode (respecting its glow toggle). All
// pulled from the repo-appearance palette so no raw hex lands in the screen.
const COMPOSER_CHAT_GLOW = getRepoAppearanceColorHex('indigo');
const COMPOSER_SCRATCH_GLOW = getRepoAppearanceColorHex('emerald');

export interface ComposerDraftCommit {
  mode: 'repo' | 'chat' | 'scratch';
  repoFullName: string | null;
  branch: string | null;
  /** Optional provider override. When non-null, the workspace anchors
   * the newly minted chat to this provider via its own per-chat draft
   * store; the catalog-wide default is left alone. */
  provider: PreferredProvider | null;
  /** Model id paired with `provider`. Either the explicit pick from
   * the model sheet, or — when the user only picked a provider — a
   * snapshot of the catalog's current default model for that
   * provider, taken at confirm time. The workspace anchors the new
   * chat to exactly this model. Null only when `provider` is also
   * null. */
  model: string | null;
}

interface ComposerDraftScreenProps {
  seed: DraftChatSeed | null;
  repos: RepoWithActivity[];
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  catalog: ModelCatalog;
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

function modelOptionsForProvider(catalog: ModelCatalog, provider: PreferredProvider): string[] {
  switch (provider) {
    case 'ollama':
      return catalog.ollamaModelOptions;
    case 'openrouter':
      return catalog.openRouterModelOptions;
    case 'zai':
      return catalog.zaiModelOptions;
    case 'kimi':
      return catalog.kimiModelOptions;
    case 'cloudflare':
      return catalog.cloudflareModelOptions;
    case 'zen':
      return catalog.zenModelOptions;
    case 'nvidia':
      return catalog.nvidiaModelOptions;
    case 'fireworks':
      return catalog.fireworksModelOptions;
    case 'sakana':
      return catalog.sakanaModelOptions;
    case 'anthropic':
      return catalog.anthropicModelOptions;
    case 'openai':
      return catalog.openaiModelOptions;
    case 'xai':
      return catalog.xaiModelOptions;
    case 'google':
      return catalog.googleModelOptions;
    default:
      return [];
  }
}

function defaultModelForProvider(
  catalog: ModelCatalog,
  provider: PreferredProvider,
): string | null {
  switch (provider) {
    case 'ollama':
      return catalog.ollama.model || null;
    case 'openrouter':
      return catalog.openRouter.model || null;
    case 'zai':
      return catalog.zai.model || null;
    case 'kimi':
      return catalog.kimi.model || null;
    case 'cloudflare':
      return catalog.cloudflare.model || null;
    case 'zen':
      return catalog.zen.model || null;
    case 'nvidia':
      return catalog.nvidia.model || null;
    case 'fireworks':
      return catalog.fireworks.model || null;
    case 'sakana':
      return catalog.sakana.model || null;
    case 'anthropic':
      return catalog.anthropic.model || null;
    case 'openai':
      return catalog.openai.model || null;
    case 'xai':
      return catalog.xai.model || null;
    case 'google':
      return catalog.google.model || null;
    default:
      return null;
  }
}

export function ComposerDraftScreen({
  seed,
  repos,
  resolveRepoAppearance,
  catalog,
  onCancel,
  onCommit,
}: ComposerDraftScreenProps) {
  // Composer state has to drive the branch manager so the branch picker
  // tracks whatever repo the user picked in the sheet, not whatever the
  // seed started with. But the draft hook needs `loadRepoBranches` from
  // the manager and the manager needs an `activeRepo` from state — so
  // we break the cycle with a ref. The hook calls into the ref-stable
  // proxy; the effect below points the ref at the current loader as
  // soon as the manager mounts.
  const branchLoaderRef = useRef<((repoFullName: string) => Promise<void> | void) | null>(null);
  const proxyLoadRepoBranches = useCallback((name: string) => branchLoaderRef.current?.(name), []);

  const { state, setMode, setRepo, setBranch, setProvider, setModel } = useDraftChatComposer({
    seed,
    repos,
    loadRepoBranches: proxyLoadRepoBranches,
  });

  const stateActiveRepo: ActiveRepo | null = useMemo(() => {
    if (!state.repoFullName) return null;
    const repo = repos.find((r) => r.full_name === state.repoFullName);
    if (!repo) return null;
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      owner: repo.owner,
      default_branch: repo.default_branch,
      current_branch: state.branch || repo.default_branch,
      private: repo.private,
    };
  }, [repos, state.branch, state.repoFullName]);

  const branchManager = useBranchManager(
    stateActiveRepo,
    stateActiveRepo ? { id: 'draft', kind: 'repo', repo: stateActiveRepo, sandboxId: null } : null,
  );

  useEffect(() => {
    branchLoaderRef.current = branchManager.loadRepoBranches;
  }, [branchManager.loadRepoBranches]);

  const [repoSheetOpen, setRepoSheetOpen] = useState(false);
  const [branchSheetOpen, setBranchSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState('');

  // Effective provider used for display + commit. If the user hasn't
  // explicitly picked, fall back to the workspace-wide default
  // (`catalog.activeBackend`) so the pill reflects what would actually
  // run. State stays null until override so "Default" remains Default.
  const effectiveProvider: PreferredProvider | null = state.provider ?? catalog.activeBackend;
  const effectiveModel: string | null = useMemo(() => {
    if (!effectiveProvider) return null;
    return state.model ?? defaultModelForProvider(catalog, effectiveProvider);
  }, [catalog, effectiveProvider, state.model]);

  const providerLabelMap = useMemo(() => {
    const map = new Map<PreferredProvider, string>();
    for (const [provider, label] of catalog.availableProviders) {
      map.set(provider, label);
    }
    return map;
  }, [catalog.availableProviders]);

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

  const isReadyToConfirm = state.mode !== 'repo' || Boolean(state.repoFullName);

  const confirmLabel =
    state.mode === 'chat'
      ? 'Start chat'
      : state.mode === 'scratch'
        ? 'Open scratch workspace'
        : state.repoFullName
          ? `Open ${state.repoFullName}`
          : 'Select a repo to continue';

  const confirmHint =
    state.mode === 'repo' && !state.repoFullName
      ? 'Pick a repo from the menu above.'
      : 'Opens a new chat in the selected context.';

  const handleConfirm = () => {
    if (!isReadyToConfirm) return;
    // Pass the provider/model pick through to the commit envelope —
    // the workspace anchors the new chat to it via per-chat draft
    // (the first-send-anchors-lock mechanism then locks the chat in
    // place). Catalog-wide defaults are intentionally NOT touched
    // here: picking Anthropic in the menu locks just this chat to
    // Anthropic; the global default lives in Settings.
    onCommit({
      mode: state.mode,
      repoFullName: state.mode === 'repo' ? state.repoFullName : null,
      branch: state.mode === 'repo' ? state.branch : null,
      provider: state.provider,
      model:
        state.model ?? (state.provider ? defaultModelForProvider(catalog, state.provider) : null),
    });
  };

  const handlePickProvider = (provider: PreferredProvider) => {
    setProvider(provider, defaultModelForProvider(catalog, provider));
    setModelSheetOpen(false);
  };

  const handlePickModel = (provider: PreferredProvider, model: string) => {
    setProvider(provider, model);
    setModelSheetOpen(false);
  };

  const handleClearProviderOverride = () => {
    setProvider(null);
    setModel(null);
    setModelSheetOpen(false);
  };

  useEffect(() => {
    if (!modelSheetOpen) return;
    // Lazy-fetch model lists for every configured provider that has a
    // dynamic catalog when the picker opens. Skips already-loaded ones
    // — the refresh handlers are idempotent and short-circuit if the
    // list is fresh. Anthropic / OpenAI / Google ship static model lists,
    // so nothing to refresh there.
    for (const [provider] of catalog.availableProviders) {
      if (provider === 'openrouter' && catalog.openRouterModelOptions.length === 0)
        void catalog.refreshOpenRouterModels();
      if (provider === 'ollama' && catalog.ollamaModelOptions.length === 0)
        void catalog.refreshOllamaModels();
      if (provider === 'cloudflare' && catalog.cloudflareModelOptions.length === 0)
        void catalog.refreshCloudflareModels();
      if (provider === 'zen' && catalog.zenModelOptions.length === 0)
        void catalog.refreshZenModels();
      if (provider === 'nvidia' && catalog.nvidiaModelOptions.length === 0)
        void catalog.refreshNvidiaModels();
      if (provider === 'fireworks' && catalog.fireworksModelOptions.length === 0)
        void catalog.refreshFireworksModels();
      if (provider === 'sakana' && catalog.sakanaModelOptions.length === 0)
        void catalog.refreshSakanaModels();
    }
  }, [catalog, modelSheetOpen]);

  const modeLabel = MODE_OPTIONS.find((m) => m.mode === state.mode)?.label ?? 'Mode';
  const ModeIcon = MODE_OPTIONS.find((m) => m.mode === state.mode)?.icon ?? FolderGit2;

  const glow = useMemo(() => {
    // Chat and scratch are fixed-chrome lanes: they paint a constant brand
    // glow color (not a per-repo accent) and have no RepoAppearance to read,
    // so the gradient style is intentional here. Only repo mode honors the
    // user's glowStyle pick.
    if (state.mode === 'chat')
      return { active: true, color: COMPOSER_CHAT_GLOW, variant: 'gradient' as const };
    if (state.mode === 'scratch')
      return { active: true, color: COMPOSER_SCRATCH_GLOW, variant: 'gradient' as const };
    const appearance = resolveRepoAppearance(state.repoFullName);
    return {
      active: appearance.glowEnabled,
      color: getRepoAppearanceColorHex(appearance.color),
      variant: appearance.glowStyle,
    };
  }, [resolveRepoAppearance, state.mode, state.repoFullName]);

  return (
    <div className="relative isolate flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom text-push-fg">
      <ChatBackgroundGlow active={glow.active} color={glow.color} variant={glow.variant} />
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
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setModeSheetOpen(true)} className={PILL_CLASS} aria-label="Mode">
              <ModeIcon className="h-3.5 w-3.5 text-push-fg-dim" />
              <span>{modeLabel}</span>
              <ChevronDown className="h-3 w-3 text-push-fg-dim" />
            </button>
            <button
              onClick={() => setModelSheetOpen(true)}
              className={PILL_CLASS}
              aria-label="Select model"
            >
              <Cpu className="h-3.5 w-3.5 text-push-fg-dim" />
              {effectiveProvider ? (
                <span className="flex items-center gap-1">
                  <span className="text-push-fg-dim">
                    {providerLabelMap.get(effectiveProvider) ?? effectiveProvider}
                  </span>
                  {effectiveModel && (
                    <span className="max-w-[160px] truncate">
                      · {formatModelDisplayName(effectiveProvider, effectiveModel)}
                    </span>
                  )}
                  {state.provider == null && <span className="text-push-fg-dim">(default)</span>}
                </span>
              ) : (
                <span>Default</span>
              )}
              <ChevronDown className="h-3 w-3 text-push-fg-dim" />
            </button>
          </div>

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
                  aria-label="Select starting branch"
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

      <div className="border-t border-push-edge/60 bg-push-surface-inset px-4 pb-4 pt-3">
        <div className="mx-auto flex w-full max-w-md flex-col gap-2">
          <button
            onClick={handleConfirm}
            disabled={!isReadyToConfirm}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-push-accent px-4 text-push-sm font-medium text-black shadow-[0_12px_34px_rgba(0,0,0,0.5)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
          <p className="text-center text-push-2xs text-push-fg-dim">{confirmHint}</p>
        </div>
      </div>

      <Sheet open={modeSheetOpen} onOpenChange={setModeSheetOpen}>
        <SheetContent
          side="bottom"
          className="border-t border-push-edge bg-push-grad-panel px-0 pb-6 pt-0 text-push-fg"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle className="text-push-lg font-display font-semibold text-push-fg">
              Select mode
            </SheetTitle>
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
            <SheetTitle className="flex items-center gap-2 text-push-lg font-display font-semibold text-push-fg">
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
            <SheetTitle className="text-push-lg font-display font-semibold text-push-fg">
              Starting branch
            </SheetTitle>
            <SheetDescription className="text-push-fg-muted">
              {selectedRepo
                ? `Open ${selectedRepo.full_name} from this branch.`
                : 'No repo selected'}
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
                      <span className="rounded-full bg-push-surface-active px-1.5 py-0.5 text-push-2xs text-push-link">
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

      <Sheet open={modelSheetOpen} onOpenChange={setModelSheetOpen}>
        <SheetContent
          side="bottom"
          className="h-[80dvh] border-t border-push-edge bg-push-grad-panel px-0 pb-0 pt-0 text-push-fg"
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle className="flex items-center gap-2 text-push-fg">
              <Cpu className="h-4 w-4 text-push-fg-dim" />
              Select model
            </SheetTitle>
            <SheetDescription className="text-push-fg-muted">
              Overrides the default backend for this chat's first message.
            </SheetDescription>
          </SheetHeader>
          <div className="max-h-[64dvh] overflow-y-auto px-3 pb-5 pt-2">
            <button
              onClick={handleClearProviderOverride}
              className={`mb-2 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                state.provider == null
                  ? 'bg-push-surface-raised/80'
                  : 'hover:bg-push-surface-hover/60'
              }`}
            >
              <div className="flex-1">
                <p className="text-push-sm text-push-fg">Default</p>
                <p className="text-push-2xs text-push-fg-muted">
                  Use the workspace's configured backend
                </p>
              </div>
              {state.provider == null && <Check className="h-4 w-4 text-push-link" />}
            </button>

            {catalog.availableProviders.length === 0 ? (
              <div className="rounded-xl border border-dashed border-push-edge/70 bg-push-surface/15 px-3 py-4 text-center text-push-sm text-push-fg-muted">
                No providers configured. Add an API key in Settings.
              </div>
            ) : (
              catalog.availableProviders.map(([provider, label]) => {
                const options = modelOptionsForProvider(catalog, provider);
                const defaultModel = defaultModelForProvider(catalog, provider);
                const providerActive = state.provider === provider;
                return (
                  <div key={provider} className="mb-3">
                    <button
                      onClick={() => handlePickProvider(provider)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    >
                      <span className="text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">
                        {label}
                      </span>
                      {providerActive && state.model == null && (
                        <Check className="h-3 w-3 text-push-link" />
                      )}
                    </button>
                    {options.length === 0 && defaultModel ? (
                      <button
                        onClick={() => handlePickModel(provider, defaultModel)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                          providerActive && state.model === defaultModel
                            ? 'bg-push-surface-raised/80'
                            : 'hover:bg-push-surface-hover/60'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-push-sm text-push-fg-secondary">
                          {formatModelDisplayName(provider, defaultModel)}
                        </span>
                        {providerActive && state.model === defaultModel && (
                          <Check className="h-4 w-4 text-push-link" />
                        )}
                      </button>
                    ) : (
                      options.map((model) => {
                        const isActive = providerActive && state.model === model;
                        return (
                          <button
                            key={`${provider}::${model}`}
                            onClick={() => handlePickModel(provider, model)}
                            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors ${
                              isActive
                                ? 'bg-push-surface-raised/80'
                                : 'hover:bg-push-surface-hover/60'
                            }`}
                          >
                            <span className="min-w-0 flex-1 truncate text-push-sm text-push-fg-secondary">
                              {formatModelDisplayName(provider, model)}
                            </span>
                            {isActive && <Check className="h-4 w-4 text-push-link" />}
                          </button>
                        );
                      })
                    )}
                  </div>
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
