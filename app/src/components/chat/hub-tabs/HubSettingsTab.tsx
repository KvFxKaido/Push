import { useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Cpu, FolderCog, Sparkles, User } from 'lucide-react';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { SettingsSectionContent } from '@/components/SettingsSectionContent';
import { PROVIDER_LABELS } from '@/components/settings-shared';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import {
  type SettingsAIProps,
  type SettingsAuthProps,
  type SettingsDataProps,
  type SettingsProfileProps,
  type SettingsTabKey,
  type SettingsWorkspaceProps,
} from '@/components/SettingsSheet';

type SettingsSubview = 'landing' | SettingsTabKey;

interface HubSettingsTabProps {
  auth: SettingsAuthProps;
  profile: SettingsProfileProps;
  ai: SettingsAIProps;
  workspace: SettingsWorkspaceProps;
  data: SettingsDataProps;
  onCloseHub: () => void;
}

interface NotebookCardProps {
  badge: string;
  cellLabel: string;
  description: string;
  icon: typeof User;
  lines: string[];
  title: string;
  onClick: () => void;
}

interface DetailShellProps {
  cellLabel: string;
  description: string;
  title: string;
  onBack: () => void;
  children: ReactNode;
}

const DETAIL_META: Record<SettingsTabKey, { title: string; description: string; cellLabel: string }> = {
  you: {
    title: 'You',
    description: 'GitHub, profile, and personal context',
    cellLabel: 'cell 01',
  },
  workspace: {
    title: 'Workspace',
    description: 'Context policy, sandbox behavior, and repo safety',
    cellLabel: 'cell 02',
  },
  ai: {
    title: 'AI',
    description: 'Provider defaults, keys, and model wiring',
    cellLabel: 'cell 03',
  },
};

function DetailShell({ cellLabel, description, title, onBack, children }: DetailShellProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-push-edge px-3 py-3">
        <button
          type="button"
          onClick={onBack}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} mb-3 px-3`}
        >
          <HubControlGlow />
          <ArrowLeft className="relative z-10 h-3.5 w-3.5" />
          <span className="relative z-10">Back</span>
        </button>
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-push-fg-dim">
            {cellLabel}
          </p>
          <h3 className="mt-1 text-sm font-semibold text-push-fg">{title}</h3>
          <p className="mt-1 text-push-xs text-push-fg-muted">{description}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function NotebookCard({
  badge,
  cellLabel,
  description,
  icon: Icon,
  lines,
  title,
  onClick,
}: NotebookCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full px-4 py-3 text-left transition-all duration-200 hover:border-push-edge-hover ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-push-fg-dim transition-colors group-hover:text-push-fg-secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-push-fg-dim">
                {cellLabel}
              </p>
              <h3 className="truncate text-sm font-semibold text-push-fg">{title}</h3>
              <p className="mt-1 text-push-xs text-push-fg-muted">{description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={HUB_TAG_CLASS}>{badge}</span>
              <ChevronRight className="h-4 w-4 text-push-fg-dim transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-push-fg-secondary" />
            </div>
          </div>
          <div className="mt-3 space-y-1.5 border-t border-push-edge/70 pt-3 font-mono text-[11px] leading-5 text-push-fg-secondary">
            {lines.map((line) => (
              <div key={line} className="truncate">
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

export function HubSettingsTab({
  auth,
  profile,
  ai,
  workspace,
  data,
  onCloseHub,
}: HubSettingsTabProps) {
  const [activeView, setActiveView] = useState<SettingsSubview>('landing');

  const configuredProviderCount = [
    ...Object.values(ai.builtInProviders).map((provider) => provider.hasKey),
    ...Object.values(ai.experimentalProviders).map((provider) => provider.hasKey),
    ai.vertexProvider.hasKey,
  ].filter(Boolean).length;

  const defaultProvider = ai.activeBackend ?? (ai.activeProviderLabel === 'demo' ? null : ai.activeProviderLabel);
  const profileName = profile.profile.displayName.trim() || profile.validatedUser?.login || 'unnamed';
  const sandboxLabel = workspace.sandboxStatus === 'ready'
    ? 'live'
    : workspace.sandboxStatus === 'creating'
    ? 'booting'
    : workspace.sandboxStatus === 'error'
    ? 'error'
    : 'idle';

  const notebookCards: NotebookCardProps[] = [
    {
      title: 'You',
      description: 'Identity and GitHub state available to every chat.',
      cellLabel: DETAIL_META.you.cellLabel,
      badge: auth.isDemo ? 'demo' : auth.isConnected ? 'linked' : 'offline',
      icon: User,
      lines: [
        `profile  ${profileName}`,
        `github   ${profile.profile.githubLogin || profile.validatedUser?.login || 'not set'}`,
        `auth     ${auth.isDemo ? 'Demo mode' : auth.isConnected ? auth.isAppAuth ? 'GitHub App' : 'Token saved' : 'Not connected'}`,
      ],
      onClick: () => setActiveView('you'),
    },
    {
      title: 'Workspace',
      description: 'Notebook controls for context, sandbox, and branch safety.',
      cellLabel: DETAIL_META.workspace.cellLabel,
      badge: sandboxLabel,
      icon: FolderCog,
      lines: [
        `context  ${workspace.contextMode === 'graceful' ? 'Graceful digest' : 'No trimming'}`,
        `sandbox  ${workspace.sandboxStartMode} start · ${sandboxLabel}`,
        `safety   protect-main ${workspace.protectMainGlobal ? 'on' : 'off'} · tool log ${workspace.showToolActivity ? 'on' : 'off'}`,
      ],
      onClick: () => setActiveView('workspace'),
    },
    {
      title: 'AI',
      description: 'Provider defaults, model picks, and connector readiness.',
      cellLabel: DETAIL_META.ai.cellLabel,
      badge: configuredProviderCount > 0 ? `${configuredProviderCount} ready` : 'offline',
      icon: Cpu,
      lines: [
        `default  ${defaultProvider ? PROVIDER_LABELS[defaultProvider] : 'Auto routing'}`,
        `models   ${ai.lockedModel ? `chat locked to ${ai.lockedModel}` : 'new chats inherit defaults'}`,
        `search   ${ai.tavilyProvider.hasKey ? 'Tavily key saved' : 'fallback web search only'}`,
      ],
      onClick: () => setActiveView('ai'),
    },
  ];

  const views: SettingsSubview[] = ['landing', 'you', 'workspace', 'ai'];
  const activeViewIndex = views.indexOf(activeView);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(7,10,15,0.98)_0%,rgba(4,6,10,1)_100%)]">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-out"
          style={{
            width: `${views.length * 100}%`,
            transform: `translateX(-${activeViewIndex * (100 / views.length)}%)`,
          }}
        >
          <section className="min-w-0 flex h-full flex-col" style={{ width: `${100 / views.length}%` }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
              <div className={`${HUB_PANEL_SURFACE_CLASS} px-4 py-4`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-push-fg-dim">
                      settings/notebook
                    </p>
                    <h2 className="mt-2 text-sm font-semibold text-push-fg">Live configuration cells</h2>
                    <p className="mt-1 text-push-xs text-push-fg-muted">
                      Identity, workspace, and model wiring in one panel. Tap a cell to drill in and edit the underlying state.
                    </p>
                  </div>
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-push-fg-dim">
                  <span className={HUB_TAG_CLASS}>
                    repo {workspace.activeRepoFullName?.split('/').pop() || 'sandbox'}
                  </span>
                  <span className={HUB_TAG_CLASS}>
                    chats {data.activeRepo ? data.activeRepo.name : 'global'}
                  </span>
                  <span className={HUB_TAG_CLASS}>
                    provider {defaultProvider ? PROVIDER_LABELS[defaultProvider] : 'auto'}
                  </span>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                {notebookCards.map((card) => (
                  <NotebookCard key={card.title} {...card} />
                ))}
              </div>

              {defaultProvider && (
                <div className={`mt-3 flex items-center gap-2 px-4 py-3 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
                  <ProviderIcon provider={defaultProvider} size={16} className="shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-push-fg">Current default provider</p>
                    <p className="truncate font-mono text-push-2xs text-push-fg-dim">
                      {PROVIDER_LABELS[defaultProvider]}{ai.lockedModel ? ` · locked chat model ${ai.lockedModel}` : ' · new chats inherit defaults'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {(['you', 'workspace', 'ai'] as const).map((sectionKey) => {
            const meta = DETAIL_META[sectionKey];
            return (
              <section
                key={sectionKey}
                className="min-w-0 flex h-full flex-col"
                style={{ width: `${100 / views.length}%` }}
              >
                <DetailShell
                  cellLabel={meta.cellLabel}
                  title={meta.title}
                  description={meta.description}
                  onBack={() => setActiveView('landing')}
                >
                  <SettingsSectionContent
                    settingsTab={sectionKey}
                    auth={auth}
                    profile={profile}
                    ai={ai}
                    workspace={workspace}
                    data={data}
                    onDismiss={onCloseHub}
                  />
                </DetailShell>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
