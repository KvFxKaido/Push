import { useState } from 'react';
import { LogOut, Settings, UserRound } from 'lucide-react';
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
import { RepoLauncherPanel } from '@/components/launcher/RepoLauncherPanel';
import type { ActiveRepo, Conversation, GitHubUser, RepoWithActivity } from '@/types';

interface HomeScreenProps {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: Record<string, Conversation>;
  activeRepo: ActiveRepo | null;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  onOpenSettings: (tab: 'you' | 'workspace' | 'ai') => void;
  onDisconnect: () => void;
  onSandboxMode: () => void;
  user: GitHubUser | null;
}

export function HomeScreen({
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  onSelectRepo,
  onResumeConversation,
  onOpenSettings,
  onDisconnect,
  onSandboxMode,
  user,
}: HomeScreenProps) {
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);

  return (
    <div className="relative flex h-dvh flex-col bg-[#000] safe-area-top safe-area-bottom">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white/[0.03] to-transparent" />

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-4">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#1e2634] bg-push-grad-icon shadow-push-sm">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-push-accent">
                  <path d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-push-fg">Push</h1>
                <p className="text-push-sm text-[#788396]">Resume work or jump into a repo.</p>
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-push-edge bg-push-surface text-push-fg-secondary shadow-push-sm spring-press transition-colors hover:border-push-edge-hover hover:text-push-fg"
                  aria-label="Open account menu"
                >
                  {user?.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt={`${user.login} avatar`}
                      className="h-full w-full rounded-[11px] object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <UserRound className="h-4 w-4" />
                  )}
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#000] bg-emerald-500" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="w-[220px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]"
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
                  onSelect={() => onOpenSettings('you')}
                  className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-push-fg-secondary hover:bg-push-surface-hover"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setDisconnectDialogOpen(true)}
                  className="mx-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-red-300 hover:bg-red-950/30 hover:text-red-200"
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
            onSelectRepo={onSelectRepo}
            onResumeConversation={onResumeConversation}
            onSandboxMode={onSandboxMode}
          />
        </div>
      </div>

      <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] rounded-xl border border-push-edge bg-push-grad-card p-4 text-push-fg shadow-[0_16px_40px_rgba(0,0,0,0.7)] sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-push-fg">
              Disconnect GitHub?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-push-fg-dim">
              This will clear local chats and return you to onboarding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-1 flex-row justify-end gap-2">
            <AlertDialogCancel className="h-8 rounded-lg border-push-edge bg-push-surface px-3 text-xs text-push-fg-secondary hover:border-push-edge-hover hover:bg-push-surface-raised hover:text-push-fg">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onDisconnect}
              className="h-8 rounded-lg border border-red-500/40 bg-red-950/30 px-3 text-xs text-red-200 hover:bg-red-900/35"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
