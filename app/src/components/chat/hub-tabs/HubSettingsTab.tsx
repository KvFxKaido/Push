import { useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { SettingsSectionContent } from '@/components/SettingsSectionContent';
import {
  PROVIDER_LABELS,
  SETTINGS_SECTION_ICONS,
  type SettingsSectionIcon,
} from '@/components/settings-shared';
import { SettingsCellsIcon } from '@/components/icons/push-custom-icons';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
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
  description: string;
  icon: SettingsSectionIcon;
  lines: string[];
  title: string;
  onClick: () => void;
}

interface DetailShellProps {
  description: string;
  icon: SettingsSectionIcon;
  title: string;
  onBack: () => void;
  children: ReactNode;
}

const DETAIL_META: Record<
  SettingsTabKey,
  { title: string; description: string; icon: SettingsSectionIcon }
> = {
  you: {
    title: 'You',
    description: 'GitHub, profile, and the context Push carries into chats.',
    icon: SETTINGS_SECTION_ICONS.you,
  },
  workspace: {
    title: 'Workspace',
    description: 'Long-chat behavior, runtime warm-up, and branch safety.',
    icon: SETTINGS_SECTION_ICONS.workspace,
  },
  ai: {
    title: 'AI',
    description: 'Default providers, model choices, and connector setup.',
    icon: SETTINGS_SECTION_ICONS.ai,
  },
};

const SETTINGS_PILL_CLASS =
  'inline-flex items-center rounded-full border border-push-edge/80 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-push-fg-dim';

function DetailShell({ description, icon: Icon, title, onBack, children }: DetailShellProps) {
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
        <div className={`${HUB_PANEL_SURFACE_CLASS} px-4 py-4`}>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-push-edge/80 bg-white/[0.04] text-push-fg shadow-[0_12px_24px_rgba(0,0,0,0.24)]">
              <Icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <span className={SETTINGS_PILL_CLASS}>Settings</span>
              <h3 className="mt-2 text-base font-semibold text-push-fg">{title}</h3>
              <p className="mt-1 text-push-xs leading-5 text-push-fg-muted">{description}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function NotebookCard({
  badge,
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
      className={`group w-full px-4 py-4 text-left transition-all duration-200 hover:border-push-edge-hover hover:-translate-y-0.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-push-edge/80 bg-white/[0.035] shadow-[0_12px_20px_rgba(0,0,0,0.2)]">
          <Icon className="h-4 w-4 text-push-fg-dim transition-colors group-hover:text-push-fg-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-push-fg">{title}</h3>
              <p className="mt-1 text-push-xs leading-5 text-push-fg-muted">{description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={SETTINGS_PILL_CLASS}>{badge}</span>
              <ChevronRight className="h-4 w-4 text-push-fg-dim transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-push-fg-secondary" />
            </div>
          </div>
          <div className="mt-3 space-y-2 border-t border-push-edge/70 pt-3">
            {lines.map((line) => (
              <div
                key={line}
                className="flex items-start gap-2 text-push-xs leading-5 text-push-fg-secondary"
              >
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-push-fg-dim/80" />
                <span className="min-w-0 truncate">{line}</span>
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

  const defaultProvider =
    ai.activeBackend ?? (ai.activeProviderLabel === 'demo' ? null : ai.activeProviderLabel);
  const profileName =
    profile.profile.displayName.trim() || profile.validatedUser?.login || 'unnamed';
  const sandboxLabel =
    workspace.sandboxStatus === 'ready'
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
      badge: auth.isConnected ? 'linked' : 'offline',
      icon: SETTINGS_SECTION_ICONS.you,
      lines: [
        `Push knows you as ${profileName}.`,
        `GitHub ${auth.isConnected ? `is connected ${profile.profile.githubLogin || profile.validatedUser?.login ? `as ${profile.profile.githubLogin || profile.validatedUser?.login}.` : 'and ready.'}` : 'is not connected yet.'}`,
        `${profile.profile.bio.trim() || profile.profile.chatInstructions?.trim() ? 'Personal context and chat instructions saved.' : 'No personal context saved yet.'}`,
      ],
      onClick: () => setActiveView('you'),
    },
    {
      title: 'Workspace',
      description: 'Notebook controls for context, sandbox, and branch safety.',
      badge: sandboxLabel,
      icon: SETTINGS_SECTION_ICONS.workspace,
      lines: [
        `Long chats are set to ${workspace.contextMode === 'graceful' ? 'keep steady' : 'keep everything'}.`,
        `Runtime warm-up is ${workspace.sandboxStartMode === 'off' ? 'manual' : workspace.sandboxStartMode}.`,
        `Main protection is ${workspace.protectMainGlobal ? 'on' : 'off'} and the console is ${workspace.showToolActivity ? 'visible' : 'hidden'}.`,
      ],
      onClick: () => setActiveView('workspace'),
    },
    {
      title: 'AI',
      description: 'Provider defaults, model picks, and connector readiness.',
      badge: configuredProviderCount > 0 ? `${configuredProviderCount} ready` : 'offline',
      icon: SETTINGS_SECTION_ICONS.ai,
      lines: [
        `New chats start on ${defaultProvider ? PROVIDER_LABELS[defaultProvider] : 'auto routing'}.`,
        `${ai.lockedModel ? `This chat is currently locked to ${ai.lockedModel}.` : 'New chats inherit your saved defaults.'}`,
        `${ai.tavilyProvider.hasKey ? 'Tavily web search is ready.' : 'Web search will use fallback providers.'}`,
      ],
      onClick: () => setActiveView('ai'),
    },
  ].map((card) => ({ ...card, lines: card.lines.filter(Boolean) }));

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
          <section
            className="min-w-0 flex h-full flex-col"
            style={{ width: `${100 / views.length}%` }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
              <div className={`${HUB_PANEL_SURFACE_CLASS} px-4 py-4`}>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-push-edge/80 bg-white/[0.04] text-push-fg shadow-[0_12px_24px_rgba(0,0,0,0.24)]">
                    <SettingsCellsIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-push-fg">Settings</h2>
                    <p className="mt-1 text-push-xs leading-5 text-push-fg-muted">
                      Your profile, workspace behavior, and AI defaults live here. Pick a section to
                      tune the details without leaving the hub.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 text-push-2xs text-push-fg-dim">
                  <span className={SETTINGS_PILL_CLASS}>
                    {workspace.activeRepoFullName?.split('/').pop() || 'Scratch workspace'}
                  </span>
                  <span className={SETTINGS_PILL_CLASS}>
                    {auth.isConnected ? 'GitHub linked' : 'GitHub not linked'}
                  </span>
                  <span className={SETTINGS_PILL_CLASS}>
                    {defaultProvider
                      ? `${PROVIDER_LABELS[defaultProvider]} default`
                      : 'Auto provider'}
                  </span>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                {notebookCards.map((card) => (
                  <NotebookCard key={card.title} {...card} />
                ))}
              </div>

              {defaultProvider && (
                <div
                  className={`mt-3 flex items-center gap-2 px-4 py-3 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
                >
                  <ProviderIcon provider={defaultProvider} size={16} className="shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-push-fg">Current default provider</p>
                    <p className="truncate text-push-2xs text-push-fg-dim">
                      {PROVIDER_LABELS[defaultProvider]}
                      {ai.lockedModel
                        ? ` for new chats · current chat stays on ${ai.lockedModel}`
                        : ' for new chats'}
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
                  title={meta.title}
                  description={meta.description}
                  icon={meta.icon}
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
