import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { LauncherHomeContent } from './LauncherHomeContent';
import type { LauncherSandboxSession } from './RepoLauncherPanel';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo, ConversationIndex, GitHubUser, RepoWithActivity } from '@/types';

interface RepoLauncherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  sandboxSession?: LauncherSandboxSession | null;
  onResumeSandbox?: () => void;
  onStartWorkspace?: () => void;
  onStartChat?: () => void;
  onDisconnect: () => void;
  user: GitHubUser | null;
}

export function RepoLauncherSheet({
  open,
  onOpenChange,
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
  sandboxSession,
  onResumeSandbox,
  onStartWorkspace,
  onStartChat,
  onDisconnect,
  user,
}: RepoLauncherSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] border-t border-push-edge bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] px-0 pb-0 pt-0 text-push-fg"
      >
        <SheetHeader className="sr-only">
          <SheetTitle className="text-sm font-semibold text-push-fg">Launcher</SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Resume repo work, reopen your sandbox, or switch context without leaving chat.
          </SheetDescription>
        </SheetHeader>

        <div className="relative flex h-full flex-col">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white/[0.03] to-transparent" />
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4">
            <LauncherHomeContent
              repos={repos}
              loading={loading}
              error={error}
              conversations={conversations}
              activeRepo={activeRepo}
              resolveRepoAppearance={resolveRepoAppearance}
              setRepoAppearance={setRepoAppearance}
              clearRepoAppearance={clearRepoAppearance}
              onSelectRepo={(repo, branch) => {
                onSelectRepo(repo, branch);
                onOpenChange(false);
              }}
              onResumeConversation={(chatId) => {
                onResumeConversation(chatId);
                onOpenChange(false);
              }}
              onDisconnect={() => {
                onDisconnect();
                onOpenChange(false);
              }}
              onStartWorkspace={onStartWorkspace
                ? () => {
                    onStartWorkspace();
                    onOpenChange(false);
                  }
                : undefined}
              onStartChat={onStartChat
                ? () => {
                    onStartChat();
                    onOpenChange(false);
                  }
                : undefined}
              sandboxSession={sandboxSession}
              onResumeSandbox={sandboxSession
                ? () => {
                    onResumeSandbox?.();
                    onOpenChange(false);
                  }
                : undefined}
              user={user}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
