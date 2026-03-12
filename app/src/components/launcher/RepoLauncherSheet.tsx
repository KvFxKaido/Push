import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { RepoLauncherPanel } from './RepoLauncherPanel';
import type { ActiveRepo, Conversation, RepoWithActivity } from '@/types';

interface RepoLauncherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: Record<string, Conversation>;
  activeRepo: ActiveRepo | null;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  onSandboxMode?: () => void;
}

export function RepoLauncherSheet({
  open,
  onOpenChange,
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  onSelectRepo,
  onResumeConversation,
  onSandboxMode,
}: RepoLauncherSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] border-t border-push-edge bg-push-grad-panel px-0 pb-0 pt-0 text-push-fg"
      >
        <SheetHeader className="border-b border-push-edge/70 bg-[linear-gradient(180deg,rgba(10,13,20,0.84)_0%,rgba(6,8,13,0.92)_100%)] px-4 py-4 text-left backdrop-blur-xl">
          <SheetTitle className="text-sm font-semibold text-push-fg">Launcher</SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Resume work, switch repos, or start a sandbox without leaving chat.
          </SheetDescription>
        </SheetHeader>

        <div className="h-[calc(92dvh-72px)] overflow-y-auto overscroll-contain px-4 pb-6 pt-4">
          <RepoLauncherPanel
            repos={repos}
            loading={loading}
            error={error}
            conversations={conversations}
            activeRepo={activeRepo}
            onSelectRepo={(repo, branch) => {
              onSelectRepo(repo, branch);
              onOpenChange(false);
            }}
            onResumeConversation={(chatId) => {
              onResumeConversation(chatId);
              onOpenChange(false);
            }}
            onSandboxMode={onSandboxMode
              ? () => {
                  onSandboxMode();
                  onOpenChange(false);
                }
              : undefined}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
