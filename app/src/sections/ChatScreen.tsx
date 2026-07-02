import type { ComponentProps, CSSProperties } from 'react';
import { Loader2, Download, Save, RotateCcw, Shield, ShieldOff, Zap } from 'lucide-react';
import type { ApprovalMode } from '@/lib/approval-mode';
import { LauncherGridIcon, WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { WebSearchMenu } from '@/components/chat/WebSearchMenu';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { SandboxStatusChip } from '@/components/chat/SandboxStatusBanner';
import { AutoBackRestoreBanner } from '@/components/chat/AutoBackRestoreBanner';
import { usePerfMark } from '@/hooks/usePerfMark';
import {
  HEADER_PILL_BUTTON_CLASS,
  HEADER_ROUND_BUTTON_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
} from '@/components/chat/hub-styles';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import { snapshotStagePercent, type SnapshotManager } from '@/hooks/useSnapshotManager';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import type { ActiveRepo } from '@/types';

type RepoChatDrawerProps = ComponentProps<typeof RepoChatDrawer>;
type ChatContainerProps = ComponentProps<typeof ChatContainer>;
type ChatInputProps = ComponentProps<typeof ChatInput>;
// The sandbox-status error banner was removed; the surviving consumers are the
// SandboxStatusChip (error tooltip) and the streaming gate below.
type SandboxStatusBannerProps = { error: string | null; isStreaming: boolean };
type SandboxExpiryBannerProps = ComponentProps<typeof SandboxExpiryBanner>;
type AutoBackRestoreBannerProps = ComponentProps<typeof AutoBackRestoreBanner>;

interface ChatScreenWorkspaceProps {
  activeRepo: ActiveRepo | null;
  isScratch: boolean;
  activeRepoAppearance: RepoAppearance | null;
  sandboxStatus: ComponentProps<typeof SandboxStatusChip>['status'];
  sandboxDownloading: boolean;
  onSandboxDownload: () => Promise<void>;
  instructions: ProjectInstructionsManager;
  snapshots: SnapshotManager;
  snapshotAgeLabel: string | null;
  snapshotIsStale: boolean;
}

interface ChatScreenShellProps {
  launcherLabel: string | undefined;
  hasWorkspaceActivityIndicator: boolean;
  chatShellTransform: string;
  chatShellShadow: string;
  /** Extra inline style for the chat shell (pager-mode opacity/filter/transition). */
  chatShellStyle?: CSSProperties;
  onOpenLauncher: () => void;
  onOpenWorkspaceHub: () => void;
  drawerProps: RepoChatDrawerProps;
}

interface ChatScreenChatProps {
  containerProps: ChatContainerProps;
  inputProps: ChatInputProps;
  /** Provider the current chat is locked to (after first send), or null for a
   *  fresh chat. Forwarded to the Web Search menu so its Auto hint + gates
   *  reflect the provider the next turn actually uses. */
  lockedProvider?: string | null;
}

interface ChatScreenBannerProps {
  sandboxStatusBannerProps: SandboxStatusBannerProps;
  sandboxExpiryBannerProps: SandboxExpiryBannerProps | null;
  autoBackRestoreBannerProps?: AutoBackRestoreBannerProps | null;
}

interface ChatScreenProps {
  workspace: ChatScreenWorkspaceProps;
  shell: ChatScreenShellProps;
  chat: ChatScreenChatProps;
  banners: ChatScreenBannerProps;
  approvalMode?: ApprovalMode;
  onCycleApprovalMode?: () => void;
}

const APPROVAL_MODE_CONFIG: Record<
  ApprovalMode,
  { icon: typeof Shield; label: string; color: string }
> = {
  supervised: { icon: Shield, label: 'Supervised', color: 'text-emerald-400' },
  autonomous: { icon: ShieldOff, label: 'Autonomous', color: 'text-sky-400' },
  'full-auto': { icon: Zap, label: 'Full Auto', color: 'text-amber-400' },
};

export function ChatScreen({
  workspace,
  shell,
  chat,
  banners,
  approvalMode,
  onCycleApprovalMode,
}: ChatScreenProps) {
  usePerfMark('workspace-chat:painted', 'surface:workspace');
  const {
    activeRepo,
    isScratch,
    activeRepoAppearance,
    sandboxStatus,
    sandboxDownloading,
    onSandboxDownload,
    instructions,
    snapshots,
    snapshotAgeLabel,
    snapshotIsStale,
  } = workspace;
  const {
    launcherLabel,
    hasWorkspaceActivityIndicator,
    chatShellTransform,
    chatShellShadow,
    chatShellStyle,
    onOpenLauncher,
    onOpenWorkspaceHub,
    drawerProps,
  } = shell;
  const { containerProps: chatContainerProps, inputProps: chatInputProps } = chat;
  const { sandboxStatusBannerProps, sandboxExpiryBannerProps, autoBackRestoreBannerProps } =
    banners;

  const resolvedAppearance = activeRepoAppearance ?? DEFAULT_REPO_APPEARANCE;
  const glowColor = getRepoAppearanceColorHex(resolvedAppearance.color);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-push-surface-inset safe-area-top safe-area-bottom">
      <div
        className={`relative z-10 isolate flex min-h-0 flex-1 flex-col bg-push-surface-inset transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
        style={{ transform: chatShellTransform, ...chatShellStyle }}
      >
        <ChatBackgroundGlow
          active={resolvedAppearance.glowEnabled}
          color={glowColor}
          variant={resolvedAppearance.glowStyle}
        />
        <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
          <div className="relative z-20 flex min-w-0 items-center gap-2">
            <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
              <RepoChatDrawer {...drawerProps} />
              {activeRepoAppearance && (
                <RepoAppearanceBadge
                  appearance={activeRepoAppearance}
                  className="-ml-1.5 h-[18px] w-[18px] shrink-0 rounded-md"
                  iconClassName="h-[11px] w-[11px]"
                />
              )}
              <div
                className={`${activeRepoAppearance ? '-ml-1.5' : '-ml-2.5'} flex min-w-0 items-center self-stretch`}
              >
                <p className="truncate text-sm font-medium leading-tight text-push-fg">
                  {isScratch ? (
                    <span className="hidden sm:inline">Workspace</span>
                  ) : (
                    activeRepo?.name || 'Push'
                  )}
                </p>
              </div>
            </div>
            {isScratch && (
              <>
                <span className="text-push-2xs text-push-fg-dim">ephemeral</span>
                {snapshots.latestSnapshot && (
                  <span
                    className={`hidden text-push-2xs sm:inline ${snapshotIsStale ? 'text-amber-400' : 'text-push-fg-dim'}`}
                    title={`Latest snapshot: ${new Date(snapshots.latestSnapshot.createdAt).toLocaleString()}`}
                  >
                    {snapshotIsStale
                      ? `snapshot stale (${snapshotAgeLabel})`
                      : `snapshot ${snapshotAgeLabel}`}
                  </span>
                )}
                {sandboxStatus === 'ready' && (
                  <button
                    onClick={() => snapshots.captureSnapshot('manual')}
                    disabled={snapshots.snapshotSaving || snapshots.snapshotRestoring}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-push-xs text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Save Snapshot Now"
                    aria-label="Save Snapshot Now"
                  >
                    {snapshots.snapshotSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">Save</span>
                  </button>
                )}
                {snapshots.latestSnapshot && (
                  <button
                    onClick={snapshots.handleRestoreFromSnapshot}
                    disabled={
                      snapshots.snapshotSaving ||
                      snapshots.snapshotRestoring ||
                      sandboxStatus === 'creating'
                    }
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-push-xs text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Restore from Last Snapshot"
                    aria-label="Restore from Last Snapshot"
                  >
                    {snapshots.snapshotRestoring ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">Restore</span>
                  </button>
                )}
                {sandboxStatus === 'ready' && (
                  <button
                    onClick={() => {
                      void onSandboxDownload();
                    }}
                    disabled={sandboxDownloading}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Download workspace"
                    aria-label="Download workspace"
                  >
                    {sandboxDownloading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {snapshots.snapshotRestoring && snapshots.snapshotRestoreProgress && (
                  <div className="flex min-w-[120px] flex-col gap-1">
                    <span className="text-push-2xs text-push-fg-muted">
                      {snapshots.snapshotRestoreProgress.message}
                    </span>
                    <div className="h-1 w-full overflow-hidden rounded bg-push-edge-subtle">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-300"
                        style={{
                          width: `${snapshotStagePercent(snapshots.snapshotRestoreProgress.stage)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {(activeRepo || isScratch) && (
            <div className="flex min-w-0 justify-center">
              <button
                onClick={onOpenLauncher}
                className={`${HEADER_PILL_BUTTON_CLASS} group min-w-0 max-w-full`}
                aria-label="Open launcher"
                title="Launcher"
              >
                <LauncherGridIcon className="h-3.5 w-3.5 text-push-fg-secondary transition-colors group-hover:text-push-fg" />
                <span className="max-w-[92px] truncate text-xs font-medium text-push-fg-secondary transition-colors group-hover:text-push-fg sm:max-w-[128px]">
                  {launcherLabel}
                </span>
              </button>
            </div>
          )}

          <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
            <SandboxStatusChip
              status={sandboxStatus}
              error={sandboxStatusBannerProps.error}
              onOpenWorkspaceHub={onOpenWorkspaceHub}
            />
            <WebSearchMenu
              triggerClassName={HEADER_ROUND_BUTTON_CLASS}
              lockedProvider={chat.lockedProvider}
            />
            {approvalMode &&
              onCycleApprovalMode &&
              (() => {
                const cfg = APPROVAL_MODE_CONFIG[approvalMode];
                const Icon = cfg.icon;
                return (
                  <button
                    onClick={onCycleApprovalMode}
                    className={`${HEADER_ROUND_BUTTON_CLASS} ${cfg.color}`}
                    aria-label={`Approval mode: ${cfg.label}. Click to cycle.`}
                    title={`${cfg.label} mode — click to switch`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })()}
            {(activeRepo || isScratch) && (
              <button
                onClick={onOpenWorkspaceHub}
                className={HEADER_ROUND_BUTTON_CLASS}
                aria-label="Open workspace hub"
                title="Workspace"
              >
                <WorkspaceDockIcon className="h-3.5 w-3.5" />
                {hasWorkspaceActivityIndicator && (
                  <span
                    className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-push-sky ${
                      chatContainerProps.agentStatus.active
                        ? 'animate-pulse shadow-[0_0_6px_rgba(56,189,248,0.5)]'
                        : ''
                    }`}
                  />
                )}
              </button>
            )}
          </div>
        </header>

        {autoBackRestoreBannerProps && <AutoBackRestoreBanner {...autoBackRestoreBannerProps} />}

        {sandboxExpiryBannerProps && <SandboxExpiryBanner {...sandboxExpiryBannerProps} />}

        {!isScratch &&
          activeRepo &&
          instructions.projectInstructionsChecked &&
          !instructions.projectInstructionsCheckFailed &&
          !instructions.agentsMdContent && (
            <div
              className={`mx-4 mt-5 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-push-edge/70`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-push-fg">No AGENTS.md found</p>
                  <p className="text-push-xs text-push-fg-muted">
                    Add project instructions so the agent understands your repo conventions.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={instructions.handleCreateAgentsMdWithAI}
                    disabled={
                      instructions.creatingAgentsMdWithAI || sandboxStatusBannerProps.isStreaming
                    }
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-emerald-300`}
                  >
                    <span>
                      {instructions.creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
                    </span>
                  </button>
                  <button
                    onClick={instructions.handleCreateAgentsMd}
                    disabled={instructions.creatingAgentsMd || instructions.creatingAgentsMdWithAI}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-push-link`}
                  >
                    <span>{instructions.creatingAgentsMd ? 'Creating...' : 'Create Template'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

        <ChatContainer {...chatContainerProps} />
        <ChatInput {...chatInputProps} />
      </div>
    </div>
  );
}
