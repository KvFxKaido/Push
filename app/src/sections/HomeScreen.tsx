import { useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  HUB_MATERIAL_BUTTON_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import { PushMarkIcon } from '@/components/icons/push-custom-icons';
import { RepoLauncherPanel } from '@/components/launcher/RepoLauncherPanel';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo, ConversationIndex, GitHubUser, RepoWithActivity } from '@/types';

interface HomeScreenProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: ConversationIndex;
  activeRepo: ActiveRepo | null;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  onDisconnect: () => void;
  onStartWorkspace: () => void;
  onStartChat: () => void;
  user: GitHubUser | null;
}

export function HomeScreen({
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  resolveRepoAppearance,
  setRepoAppearance,
  clearRepoAppearance,
  onSelectRepo,
  onResumeConversation,
  onDisconnect,
  onStartWorkspace,
  onStartChat,
  user,
}: HomeScreenProps) {
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);

  return (
    <div className="relative flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white/[0.03] to-transparent" />

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-4">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center text-push-accent">
                <PushMarkIcon className="h-4 w-4 text-push-accent" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-push-fg">Push</h1>
                <p className="text-push-sm text-[#788396]">Resume work or jump into a repo.</p>
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={`${HUB_MATERIAL_BUTTON_CLASS} relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-push-fg-secondary`}
                  aria-label="Open account menu"
                >
                  <HubControlGlow />
                  {user?.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt={`${user.login} avatar`}
                      className="h-full w-full rounded-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <UserRound className="relative z-10 h-4 w-4" />
                  )}
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#000] bg-emerald-500" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className={`w-[220px] ${HUB_PANEL_SURFACE_CLASS}`}
              >
                <DropdownMenuLabel className="px-3 py-2 text-xs text-push-fg-secondary">
                  <div className="flex items-center gap-2">
                    {user?.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt={`${user.login} avatar`}
                        className="h-6 w-6 rounded-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-push-surface-raised text-push-fg-dim">
                        <UserRound className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-push-xs text-push-fg-secondary">GitHub connected</p>
                      <p className="truncate text-push-xs text-push-fg-dim">
                        {user ? `@${user.login}` : 'Connected account'}
                      </p>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-push-edge" />
                <DropdownMenuItem
                  onSelect={() => setDisconnectDialogOpen(true)}
                  className="mx-1 flex items-center gap-2 rounded-full px-3 py-2 text-xs text-red-300 focus:bg-red-950/25 focus:text-red-200"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <RepoLauncherPanel
            repos={repos}
            loading={loading}
            error={error}
            conversations={conversations}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={onSelectRepo}
            onResumeConversation={onResumeConversation}
            onStartWorkspace={onStartWorkspace}
            onStartChat={onStartChat}
          />
        </div>
      </div>

      <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <AlertDialogContent className={`max-w-[calc(100%-2rem)] p-4 text-push-fg sm:max-w-sm ${HUB_PANEL_SURFACE_CLASS}`}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-push-fg">
              Disconnect GitHub?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-push-fg-dim">
              This will clear local chats and return you to onboarding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-1 flex-row justify-end gap-2">
            <AlertDialogCancel className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-8 px-3 text-xs`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onDisconnect}
              className="h-8 rounded-full border border-red-500/30 bg-[linear-gradient(180deg,rgba(84,25,25,0.72)_0%,rgba(40,13,13,0.9)_100%)] px-3 text-xs text-red-200 transition-colors hover:border-red-500/45 hover:text-red-100"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
