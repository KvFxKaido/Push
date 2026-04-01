import type { ComponentProps } from 'react';
import { Loader2, Download, Save, RotateCcw } from 'lucide-react';
import { LauncherGridIcon, WorkspaceDockIcon } from '@/components/icons/push-custom-icons';
import { RepoAppearanceBadge } from '@/components/repo/repo-appearance';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatInput } from '@/components/chat/ChatInput';
import { RepoChatDrawer } from '@/components/chat/RepoChatDrawer';
import { SandboxExpiryBanner } from '@/components/chat/SandboxExpiryBanner';
import { SandboxStatusBanner } from '@/components/chat/SandboxStatusBanner';
import { usePerfMark } from '@/hooks/usePerfMark';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { ProjectInstructionsManager } from '@/hooks/useProjectInstructions';
import { snapshotStagePercent, type SnapshotManager } from '@/hooks/useSnapshotManager';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo } from '@/types';

type RepoChatDrawerProps = ComponentProps<typeof RepoChatDrawer>;
type ChatContainerProps = ComponentProps<typeof ChatContainer>;
type ChatInputProps = ComponentProps<typeof ChatInput>;
type SandboxStatusBannerProps = ComponentProps<typeof SandboxStatusBanner>;
type SandboxExpiryBannerProps = ComponentProps<typeof SandboxExpiryBanner>;

interface ChatScreenWorkspaceProps {
  activeRepo: ActiveRepo | null;
  isScratch: boolean;
  activeRepoAppearance: RepoAppearance | null;
  sandboxStatus: SandboxStatusBannerProps['status'];
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
  onOpenLauncher: () => void;
  onOpenWorkspaceHub: () => void;
  drawerProps: RepoChatDrawerProps;
}

interface ChatScreenChatProps {
  containerProps: ChatContainerProps;
  inputProps: ChatInputProps;
}

interface ChatScreenBannerProps {
  sandboxStatusBannerProps: SandboxStatusBannerProps;
  sandboxExpiryBannerProps: SandboxExpiryBannerProps | null;
}

interface ChatScreenProps {
  workspace: ChatScreenWorkspaceProps;
  shell: ChatScreenShellProps;
  chat: ChatScreenChatProps;
  banners: ChatScreenBannerProps;
}

const HEADER_PLAIN_INTERACTIVE_CLASS =
  'relative text-push-fg-secondary transition-colors duration-200 hover:text-push-fg active:scale-[0.98]';
const HEADER_ROUND_BUTTON_CLASS =
  `flex h-9 w-9 items-center justify-center ${HEADER_PLAIN_INTERACTIVE_CLASS}`;
const HEADER_PILL_BUTTON_CLASS =
  `pointer-events-auto flex h-9 items-center gap-2 px-1.5 ${HEADER_PLAIN_INTERACTIVE_CLASS}`;

export function ChatScreen({ workspace, shell, chat, banners }: ChatScreenProps) {
  usePerfMark('workspace-chat:painted', 'screen:workspace');
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
    onOpenLauncher,
    onOpenWorkspaceHub,
    drawerProps,
  } = shell;
  const { containerProps: chatContainerProps, inputProps: chatInputProps } = chat;
  const { sandboxStatusBannerProps, sandboxExpiryBannerProps } = banners;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#000] safe-area-top safe-area-bottom">
      <div
        className={`relative z-10 flex min-h-0 flex-1 flex-col bg-[#000] transition-[transform,box-shadow] duration-500 ease-in-out will-change-transform ${chatShellShadow}`}
        style={{ transform: chatShellTransform }}
      >
        <header className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-3 pb-2">
          <div className="relative z-20 flex min-w-0 items-center gap-2">
            <div className="flex h-[34px] min-w-0 items-center gap-1 pl-0.5 pr-1">
              <RepoChatDrawer {...drawerProps} />
              {activeRepoAppearance && (
                <RepoAppearanceBadge
                  appearance={activeRepoAppearance}
                  className="relative z-10 -ml-1.5 h-[18px] w-[18px] shrink-0 rounded-md"
                  iconClassName="h-[11px] w-[11px]"
                />
              )}
              <div className={`${activeRepoAppearance ? '-ml-1.5' : '-ml-2.5'} flex min-w-0 items-center self-stretch`}>
                <p className="truncate text-sm font-medium leading-tight text-[#f5f7ff]">
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
                    {snapshotIsStale ? `snapshot stale (${snapshotAgeLabel})` : `snapshot ${snapshotAgeLabel}`}
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
                    {snapshots.snapshotSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">Save</span>
                  </button>
                )}
                {snapshots.latestSnapshot && (
                  <button
                    onClick={snapshots.handleRestoreFromSnapshot}
                    disabled={snapshots.snapshotSaving || snapshots.snapshotRestoring || sandboxStatus === 'creating'}
                    className="flex h-7 items-center gap-1 rounded-lg px-2 text-push-xs text-push-fg-dim transition-colors hover:bg-push-surface-hover hover:text-emerald-400 active:scale-95 disabled:opacity-50"
                    title="Restore from Last Snapshot"
                    aria-label="Restore from Last Snapshot"
                  >
                    {snapshots.snapshotRestoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
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
                    {sandboxDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </button>
                )}
                {snapshots.snapshotRestoring && snapshots.snapshotRestoreProgress && (
                  <div className="flex min-w-[120px] flex-col gap-1">
                    <span className="text-push-2xs text-push-fg-muted">{snapshots.snapshotRestoreProgress.message}</span>
                    <div className="h-1 w-full overflow-hidden rounded bg-[#1a2130]">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${snapshotStagePercent(snapshots.snapshotRestoreProgress.stage)}%` }}
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
                <LauncherGridIcon className="relative z-10 h-3.5 w-3.5 text-push-fg-secondary transition-colors group-hover:text-push-fg" />
                <span className="relative z-10 max-w-[92px] truncate text-xs font-medium text-push-fg-secondary transition-colors group-hover:text-push-fg sm:max-w-[128px]">
                  {launcherLabel}
                </span>
              </button>
            </div>
          )}

          <div className="relative z-20 flex min-w-0 items-center justify-end gap-2">
            {(activeRepo || isScratch) && (
              <button
                onClick={onOpenWorkspaceHub}
                className={HEADER_ROUND_BUTTON_CLASS}
                aria-label="Open workspace hub"
                title="Workspace"
              >
                <WorkspaceDockIcon className="relative z-10 h-3.5 w-3.5" />
                {hasWorkspaceActivityIndicator && (
                  <span
                    className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-push-sky ${
                      chatContainerProps.agentStatus.active ? 'animate-pulse shadow-[0_0_6px_rgba(56,189,248,0.5)]' : ''
                    }`}
                  />
                )}
              </button>
            )}
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-black to-transparent" />
        </header>

        <SandboxStatusBanner {...sandboxStatusBannerProps} />

        {sandboxExpiryBannerProps && (
          <SandboxExpiryBanner {...sandboxExpiryBannerProps} />
        )}

        {!isScratch && activeRepo && instructions.projectInstructionsChecked && !instructions.projectInstructionsCheckFailed && !instructions.agentsMdContent && (
          <div className={`mx-4 mt-5 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-push-edge/70`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-push-fg">No AGENTS.md found</p>
                <p className="text-push-xs text-push-fg-muted">Add project instructions so the agent understands your repo conventions.</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={instructions.handleCreateAgentsMdWithAI}
                  disabled={instructions.creatingAgentsMdWithAI || sandboxStatusBannerProps.isStreaming}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-emerald-300`}
                >
                  <HubControlGlow />
                  <span className="relative z-10">
                    {instructions.creatingAgentsMdWithAI ? 'Drafting...' : 'Create with AI'}
                  </span>
                </button>
                <button
                  onClick={instructions.handleCreateAgentsMd}
                  disabled={instructions.creatingAgentsMd || instructions.creatingAgentsMdWithAI}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-[#8ad4ff]`}
                >
                  <HubControlGlow />
                  <span className="relative z-10">
                    {instructions.creatingAgentsMd ? 'Creating...' : 'Create Template'}
                  </span>
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
