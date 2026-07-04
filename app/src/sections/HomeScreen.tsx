import { LauncherHomeContent } from '@/components/launcher/LauncherHomeContent';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { usePerfMark } from '@/hooks/usePerfMark';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import type { ActiveRepo, ConversationIndex, GitHubUser, RepoWithActivity } from '@/types';

// Same default accent the chat surface falls back to. The launcher spans
// every repo, so it stays on the neutral default rather than tinting per repo.
const HOME_GLOW_COLOR = getRepoAppearanceColorHex(DEFAULT_REPO_APPEARANCE.color);

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
  /** Optional: undefined hides the Remote tile (VITE_RELAY_MODE off). */
  onStartRelay?: () => void;
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
  onStartRelay,
  user,
}: HomeScreenProps) {
  usePerfMark('home:painted', 'screen:home');
  return (
    <div className="relative isolate flex h-dvh flex-col bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] safe-area-top safe-area-bottom">
      <ChatBackgroundGlow active color={HOME_GLOW_COLOR} />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white/[0.03] to-transparent" />

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-4">
        <LauncherHomeContent
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
          onDisconnect={onDisconnect}
          onStartWorkspace={onStartWorkspace}
          onStartChat={onStartChat}
          onStartRelay={onStartRelay}
          user={user}
        />
      </div>
    </div>
  );
}
