import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';

// The heavy children used by ChatScreen are mocked to shallow stubs so the
// test focuses on ChatScreen's own layout and conditional rendering.
vi.mock('@/components/chat/ChatContainer', () => ({
  ChatContainer: () => <div data-testid="chat-container">chat-container</div>,
}));
vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input">chat-input</div>,
}));
vi.mock('@/components/chat/RepoChatDrawer', () => ({
  RepoChatDrawer: () => <div data-testid="repo-drawer">repo-drawer</div>,
}));
vi.mock('@/components/chat/SandboxStatusBanner', () => ({
  SandboxStatusBanner: ({ status }: { status: string }) => (
    <div data-testid="sandbox-status-banner">status:{status}</div>
  ),
}));
vi.mock('@/components/chat/SandboxExpiryBanner', () => ({
  SandboxExpiryBanner: () => <div data-testid="sandbox-expiry-banner">expiry</div>,
}));
vi.mock('@/hooks/usePerfMark', () => ({ usePerfMark: () => {} }));

const { ChatScreen } = await import('./ChatScreen');

type Props = ComponentProps<typeof ChatScreen>;

function baseWorkspace(overrides: Partial<Props['workspace']> = {}): Props['workspace'] {
  return {
    activeRepo: null,
    isScratch: false,
    activeRepoAppearance: null,
    sandboxStatus: 'idle',
    sandboxDownloading: false,
    onSandboxDownload: vi.fn(async () => {}),
    instructions: {
      projectInstructionsChecked: false,
      projectInstructionsCheckFailed: false,
      agentsMdContent: null,
      instructionFilename: null,
      creatingAgentsMd: false,
      creatingAgentsMdWithAI: false,
      handleCreateAgentsMd: vi.fn(),
      handleCreateAgentsMdWithAI: vi.fn(),
    } as Props['workspace']['instructions'],
    snapshots: {
      latestSnapshot: null,
      snapshotSaving: false,
      snapshotRestoring: false,
      snapshotRestoreProgress: null,
      captureSnapshot: vi.fn(),
      handleRestoreFromSnapshot: vi.fn(),
    } as unknown as Props['workspace']['snapshots'],
    snapshotAgeLabel: null,
    snapshotIsStale: false,
    ...overrides,
  };
}

function baseShell(overrides: Partial<Props['shell']> = {}): Props['shell'] {
  return {
    launcherLabel: 'Workspace',
    hasWorkspaceActivityIndicator: false,
    chatShellTransform: 'translateX(0)',
    chatShellShadow: '',
    onOpenLauncher: vi.fn(),
    onOpenWorkspaceHub: vi.fn(),
    drawerProps: {} as Props['shell']['drawerProps'],
    ...overrides,
  };
}

function baseChat(): Props['chat'] {
  return {
    containerProps: {
      agentStatus: { active: false },
    } as unknown as Props['chat']['containerProps'],
    inputProps: {} as Props['chat']['inputProps'],
  };
}

function baseBanners(): Props['banners'] {
  return {
    sandboxStatusBannerProps: {
      status: 'idle',
      isStreaming: false,
    } as Props['banners']['sandboxStatusBannerProps'],
    sandboxExpiryBannerProps: null,
  };
}

describe('ChatScreen', () => {
  it('renders the active repo name and the launcher pill when a repo is active', () => {
    const html = renderToStaticMarkup(
      <ChatScreen
        workspace={baseWorkspace({
          activeRepo: { id: 'r1', fullName: 'owner/repo', name: 'repo' } as never,
        })}
        shell={baseShell({ launcherLabel: 'my-launcher' })}
        chat={baseChat()}
        banners={baseBanners()}
      />,
    );

    expect(html).toContain('repo');
    expect(html).toContain('my-launcher');
    // Approval-mode button is hidden when no mode is provided.
    expect(html).not.toContain('Supervised mode');
  });

  it('renders the scratch/ephemeral workspace pill', () => {
    const html = renderToStaticMarkup(
      <ChatScreen
        workspace={baseWorkspace({ isScratch: true })}
        shell={baseShell()}
        chat={baseChat()}
        banners={baseBanners()}
      />,
    );

    expect(html).toContain('ephemeral');
  });

  it('renders the approval-mode cycle button when a mode is supplied', () => {
    const html = renderToStaticMarkup(
      <ChatScreen
        workspace={baseWorkspace()}
        shell={baseShell()}
        chat={baseChat()}
        banners={baseBanners()}
        approvalMode="autonomous"
        onCycleApprovalMode={vi.fn()}
      />,
    );

    expect(html).toContain('Autonomous mode');
  });

  it('renders the AGENTS.md banner when the repo is checked but has no AGENTS.md', () => {
    const html = renderToStaticMarkup(
      <ChatScreen
        workspace={baseWorkspace({
          activeRepo: { id: 'r1', fullName: 'owner/repo', name: 'repo' } as never,
          instructions: {
            projectInstructionsChecked: true,
            projectInstructionsCheckFailed: false,
            agentsMdContent: null,
            instructionFilename: null,
            creatingAgentsMd: false,
            creatingAgentsMdWithAI: false,
            handleCreateAgentsMd: vi.fn(),
            handleCreateAgentsMdWithAI: vi.fn(),
          } as Props['workspace']['instructions'],
        })}
        shell={baseShell()}
        chat={baseChat()}
        banners={baseBanners()}
      />,
    );

    expect(html).toContain('No AGENTS.md found');
    expect(html).toContain('Create with AI');
    expect(html).toContain('Create Template');
  });

  it('renders the sandbox expiry banner when expiry props are provided', () => {
    const html = renderToStaticMarkup(
      <ChatScreen
        workspace={baseWorkspace()}
        shell={baseShell()}
        chat={baseChat()}
        banners={{
          sandboxStatusBannerProps: {
            status: 'ready',
            isStreaming: false,
          } as Props['banners']['sandboxStatusBannerProps'],
          sandboxExpiryBannerProps: {} as Props['banners']['sandboxExpiryBannerProps'],
        }}
      />,
    );

    expect(html).toContain('sandbox-expiry-banner');
  });
});
