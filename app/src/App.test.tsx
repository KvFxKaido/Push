import { Suspense } from 'react';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { renderToReadableStream } from 'react-dom/server';
import type {
  ActiveRepo,
  Conversation,
  ConversationIndex,
  GitHubAuthSession,
  GitHubUser,
  RepoWithActivity,
  WorkspaceScreenProps,
} from '@/types';

type OnboardingProps = {
  onConnect: (pat: string) => Promise<boolean>;
  onConnectOAuth: () => void;
  onStartWorkspace: () => void;
  onInstallApp: () => void;
  onConnectInstallationId: (installationId: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  validatedUser: GitHubUser | null;
  isAppAuth?: boolean;
};

type HomeProps = {
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: ConversationIndex;
  activeRepo: ActiveRepo | null;
  resolveRepoAppearance: (repoFullName?: string | null) => unknown;
  setRepoAppearance: (repoFullName: string, appearance: unknown) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  onDisconnect: () => void;
  onStartWorkspace: () => void;
  user: GitHubUser | null;
};

type ActiveRepoHookState = {
  activeRepo: ActiveRepo | null;
  setActiveRepo: (repo: ActiveRepo) => void;
  clearActiveRepo: () => void;
  setCurrentBranch: (branch: string) => void;
};

const mockState = vi.hoisted(() => {
  const defaultAuth = (): GitHubAuthSession => ({
    status: 'signed_out',
    token: null,
    patToken: null,
    validatedUser: null,
    isAppAuth: false,
    installationId: null,
    loading: false,
    error: null,
    appLoading: false,
    appError: null,
    connectPat: vi.fn(async () => true),
    connectApp: vi.fn(),
    installApp: vi.fn(),
    setInstallationIdManually: vi.fn(async () => true),
    disconnect: vi.fn(),
  });

  const defaultRepoAppearance = {
    resolveRepoAppearance: vi.fn(() => ({ accentHue: 200 })),
    setRepoAppearance: vi.fn(),
    clearRepoAppearance: vi.fn(),
  };

  const defaultActiveRepo: ActiveRepoHookState = {
    activeRepo: null,
    setActiveRepo: vi.fn(),
    clearActiveRepo: vi.fn(),
    setCurrentBranch: vi.fn(),
  };

  return {
    auth: defaultAuth(),
    repos: {
      repos: [] as RepoWithActivity[],
      loading: false,
      error: null as string | null,
      sync: vi.fn(),
    },
    activeRepo: defaultActiveRepo,
    repoAppearance: defaultRepoAppearance,
    migrateConversationsToIndexedDB: vi.fn(async () => ({})),
    replaceAllConversations: vi.fn(async (convs: Record<string, Conversation>) => {
      void convs;
    }),
    safeStorageRemove: vi.fn(),
    onboardingProps: null as OnboardingProps | null,
    homeProps: null as HomeProps | null,
    workspaceProps: null as WorkspaceScreenProps | null,
    defaultAuth,
    defaultRepoAppearance,
    defaultActiveRepo,
  };
});

vi.mock('@/hooks/useAuthSession', () => ({
  useAuthSession: () => mockState.auth,
}));

vi.mock('@/hooks/useRepos', () => ({
  useRepos: () => mockState.repos,
}));

vi.mock('@/hooks/useActiveRepo', () => ({
  useActiveRepo: () => mockState.activeRepo,
}));

vi.mock('@/hooks/useRepoAppearance', () => ({
  useRepoAppearance: () => mockState.repoAppearance,
}));

vi.mock('@/lib/conversation-store', () => ({
  migrateConversationsToIndexedDB: () => mockState.migrateConversationsToIndexedDB(),
  replaceAllConversations: (convs: Record<string, Conversation>) => mockState.replaceAllConversations(convs),
}));

vi.mock('@/lib/safe-storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/safe-storage')>('@/lib/safe-storage');
  return {
    ...actual,
    safeStorageRemove: (key: string, area?: 'local' | 'session') => mockState.safeStorageRemove(key, area),
  };
});

vi.mock('@/sections/OnboardingScreen', () => ({
  OnboardingScreen: (props: OnboardingProps) => {
    mockState.onboardingProps = props;
    return <div data-screen="onboarding">Onboarding Stub</div>;
  },
}));

vi.mock('@/sections/HomeScreen', () => ({
  HomeScreen: (props: HomeProps) => {
    mockState.homeProps = props;
    return <div data-screen="home">Home Stub</div>;
  },
}));

vi.mock('@/sections/WorkspaceScreen', () => ({
  WorkspaceScreen: (props: WorkspaceScreenProps) => {
    mockState.workspaceProps = props;
    return <div data-screen="workspace">Workspace Stub</div>;
  },
}));

async function renderApp() {
  const { default: App } = await import('./App');
  const element = (
    <Suspense fallback={<div data-screen="fallback">Fallback</div>}>
      <App />
    </Suspense>
  );

  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

function createRepo(overrides: Partial<RepoWithActivity> = {}): RepoWithActivity {
  return {
    id: 1,
    name: 'Push',
    full_name: 'ishaw/Push',
    owner: 'ishaw',
    private: true,
    description: 'Push test repo',
    open_issues_count: 0,
    default_branch: 'main',
    pushed_at: '2026-03-28T00:00:00Z',
    language: 'TypeScript',
    avatar_url: 'https://example.com/avatar.png',
    activity: {
      open_prs: 0,
      recent_commits: 0,
      has_new_activity: false,
      last_synced: '2026-03-28T00:00:00Z',
    },
    ...overrides,
  };
}

function toActiveRepo(repo: RepoWithActivity, currentBranch = repo.default_branch): ActiveRepo {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner,
    default_branch: repo.default_branch,
    current_branch: currentBranch,
    private: repo.private,
  };
}

describe('App auth and shell integration', () => {
  beforeEach(() => {
    mockState.auth = mockState.defaultAuth();
    mockState.repos = {
      repos: [],
      loading: false,
      error: null,
      sync: vi.fn(),
    };
    mockState.activeRepo = {
      ...mockState.defaultActiveRepo,
      activeRepo: null,
      setActiveRepo: vi.fn(),
      clearActiveRepo: vi.fn(),
      setCurrentBranch: vi.fn(),
    };
    mockState.repoAppearance = {
      resolveRepoAppearance: vi.fn(() => ({ accentHue: 200 })),
      setRepoAppearance: vi.fn(),
      clearRepoAppearance: vi.fn(),
    };
    mockState.migrateConversationsToIndexedDB = vi.fn(async () => ({}));
    mockState.replaceAllConversations = vi.fn(async (convs: Record<string, Conversation>) => {
      void convs;
    });
    mockState.safeStorageRemove = vi.fn();
    mockState.onboardingProps = null;
    mockState.homeProps = null;
    mockState.workspaceProps = null;
    vi.resetModules();
  });

  it('routes signed-out users to onboarding with the merged auth session props', async () => {
    const validatedUser = { login: 'ishaw', avatar_url: '' };
    mockState.auth = {
      ...mockState.defaultAuth(),
      loading: true,
      error: 'Proxy down',
      validatedUser,
      isAppAuth: true,
      connectApp: vi.fn(),
      installApp: vi.fn(),
      setInstallationIdManually: vi.fn(async () => true),
    };

    const html = await renderApp();

    expect(html).toContain('data-screen="onboarding"');
    expect(mockState.onboardingProps).toMatchObject({
      loading: true,
      error: 'Proxy down',
      validatedUser,
      isAppAuth: true,
    });
    expect(mockState.homeProps).toBeNull();
    expect(mockState.workspaceProps).toBeNull();
  });

  it('routes authenticated users with no active workspace to home', async () => {
    const repo = createRepo();
    const user = { login: 'ishaw', avatar_url: 'https://example.com/avatar.png' };
    mockState.auth = {
      ...mockState.defaultAuth(),
      status: 'pat',
      token: 'ghp_test',
      patToken: 'ghp_test',
      validatedUser: user,
    };
    mockState.repos = {
      repos: [repo],
      loading: false,
      error: null,
      sync: vi.fn(),
    };

    const html = await renderApp();

    expect(html).toContain('data-screen="home"');
    expect(mockState.homeProps).toMatchObject({
      repos: [repo],
      user,
      activeRepo: null,
    });
    expect(mockState.onboardingProps).toBeNull();
    expect(mockState.workspaceProps).toBeNull();
  });

  it('routes active repo sessions to the workspace and passes grouped domains', async () => {
    const repo = createRepo();
    const activeRepo = toActiveRepo(repo, 'feature/auth-boundary');
    const sync = vi.fn();
    mockState.auth = {
      ...mockState.defaultAuth(),
      status: 'app',
      token: 'ghu_app',
      patToken: 'ghp_pat',
      validatedUser: { login: 'ishaw', avatar_url: '' },
      isAppAuth: true,
      installationId: '424242',
      appLoading: true,
      appError: 'warming up',
      connectApp: vi.fn(),
      installApp: vi.fn(),
      setInstallationIdManually: vi.fn(async () => true),
    };
    mockState.repos = {
      repos: [repo],
      loading: false,
      error: null,
      sync,
    };
    mockState.activeRepo = {
      activeRepo,
      setActiveRepo: vi.fn(),
      clearActiveRepo: vi.fn(),
      setCurrentBranch: vi.fn(),
    };

    const html = await renderApp();

    expect(html).toContain('data-screen="workspace"');
    expect(sync).toHaveBeenCalledTimes(0);
    expect(mockState.workspaceProps).not.toBeNull();
    const workspaceSession = mockState.workspaceProps?.workspace.workspaceSession;
    expect(workspaceSession?.kind).toBe('repo');
    if (!workspaceSession || workspaceSession.kind !== 'repo') {
      throw new Error('Expected repo workspace session');
    }
    expect(workspaceSession.repo.full_name).toBe('ishaw/Push');
    expect(mockState.workspaceProps?.repoShell.repos).toEqual([repo]);
    expect(mockState.workspaceProps?.auth).toMatchObject({
      token: 'ghu_app',
      patToken: 'ghp_pat',
      isAppAuth: true,
      installationId: '424242',
      appLoading: true,
      appError: 'warming up',
    });
    expect(mockState.workspaceProps?.navigation.onSelectRepo).toBeTypeOf('function');
    expect(mockState.workspaceProps?.homeBridge.pendingResumeChatId).toBeNull();
  });

  it('connects PAT auth through the merged auth session and syncs repos on success', async () => {
    const connectPat = vi.fn(async () => true);
    const sync = vi.fn();
    mockState.auth = {
      ...mockState.defaultAuth(),
      connectPat,
    };
    mockState.repos = {
      repos: [],
      loading: false,
      error: null,
      sync,
    };

    await renderApp();
    const result = await mockState.onboardingProps?.onConnect('ghp_new_token');

    expect(result).toBe(true);
    expect(connectPat).toHaveBeenCalledWith('ghp_new_token');
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
