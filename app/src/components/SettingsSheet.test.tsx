import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from './SettingsSheet';
import { ExperimentalProviderSection, ProviderKeySection, SettingsSheet } from './SettingsSheet';

function emptyAuth(): SettingsAuthProps {
  return {
    isConnected: false,
    isAppAuth: false,
    installationId: '',
    token: '',
    patToken: '',
    validatedUser: null,
    appLoading: false,
    appError: null,
    connectApp: vi.fn(),
    installApp: vi.fn(),
    showInstallIdInput: false,
    setShowInstallIdInput: vi.fn(),
    installIdInput: '',
    setInstallIdInput: vi.fn(),
    setInstallationIdManually: vi.fn(async () => true),
    allowlistSecretCmd: 'gh secret set ALLOWLIST',
    copyAllowlistCommand: vi.fn(),
    onDisconnect: vi.fn(),
  };
}

function emptyProfile(): SettingsProfileProps {
  return {
    displayNameDraft: '',
    setDisplayNameDraft: vi.fn(),
    onDisplayNameBlur: vi.fn(),
    bioDraft: '',
    setBioDraft: vi.fn(),
    onBioBlur: vi.fn(),
    chatInstructionsDraft: '',
    setChatInstructionsDraft: vi.fn(),
    onChatInstructionsBlur: vi.fn(),
    profile: { displayName: '', bio: '' },
    clearProfile: vi.fn(),
    validatedUser: null,
  };
}

function emptyAI(): SettingsAIProps {
  return {
    activeProviderLabel: 'kilocode',
    activeBackend: null,
    setActiveBackend: vi.fn(),
    isProviderLocked: false,
    lockedProvider: null,
    lockedModel: null,
    availableProviders: [],
    setPreferredProvider: vi.fn(),
    clearPreferredProvider: vi.fn(),
    builtInProviders: {} as never,
    experimentalProviders: {} as never,
    vertexProvider: {} as never,
    tavilyProvider: {} as never,
  };
}

function emptyWorkspace(): SettingsWorkspaceProps {
  return {
    approvalMode: 'supervised',
    updateApprovalMode: vi.fn(),
    contextMode: 'normal',
    updateContextMode: vi.fn(),
    sandboxStartMode: 'manual',
    updateSandboxStartMode: vi.fn(),
    sandboxStatus: 'idle',
    sandboxId: null,
    sandboxError: null,
    sandboxState: null,
    sandboxStateLoading: false,
    fetchSandboxState: vi.fn(),
    protectMainGlobal: true,
    setProtectMainGlobal: vi.fn(),
    protectMainRepoOverride: 'inherit',
    setProtectMainRepoOverride: vi.fn(),
    showToolActivity: true,
    setShowToolActivity: vi.fn(),
    activeRepoFullName: null,
  };
}

function emptyData(): SettingsDataProps {
  return {
    activeRepo: null,
    activeBranch: null,
    deleteAllChats: vi.fn(),
    clearMemoryByRepo: vi.fn(),
    clearMemoryByBranch: vi.fn(),
  };
}

describe('SettingsSheet', () => {
  it('does not render the settings panel content while closed', () => {
    const html = renderToStaticMarkup(
      <SettingsSheet
        open={false}
        onOpenChange={vi.fn()}
        settingsTab="you"
        setSettingsTab={vi.fn()}
        auth={emptyAuth()}
        profile={emptyProfile()}
        ai={emptyAI()}
        workspace={emptyWorkspace()}
        data={emptyData()}
      />,
    );

    // Radix renders a hidden title on close; the live dialog is portalled only
    // when open=true, so "Control center" is absent until opened.
    expect(html).not.toContain('Control center');
  });
});

describe('ProviderKeySection', () => {
  const baseProps = {
    label: 'OpenRouter',
    keyInput: '',
    setKeyInput: vi.fn(),
    saveKey: vi.fn(),
    clearKey: vi.fn(),
    activeBackend: null,
    backendId: 'openrouter' as const,
    clearPreferredProvider: vi.fn(),
    setActiveBackend: vi.fn(),
    placeholder: 'sk-or-...',
    saveLabel: 'Save key',
    hint: 'Stored locally in your browser.',
  };

  it('shows a Connected badge and the current model select when a key is present', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection
        {...baseProps}
        hasKey
        model={{
          value: 'anthropic/claude-sonnet',
          set: vi.fn(),
          options: ['anthropic/claude-sonnet', 'openai/gpt-5'],
          isLocked: false,
          lockedModel: null,
        }}
      />,
    );

    expect(html).toContain('Connected');
    expect(html).toContain('anthropic/claude-sonnet');
    expect(html).toContain('openai/gpt-5');
  });

  it('renders the locked-model warning when the current chat pins a model', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection
        {...baseProps}
        hasKey
        model={{
          value: 'openai/gpt-5',
          set: vi.fn(),
          options: ['openai/gpt-5'],
          isLocked: true,
          lockedModel: 'anthropic/claude-sonnet',
        }}
      />,
    );

    expect(html).toContain('This chat keeps using anthropic/claude-sonnet');
  });

  it('renders the empty key input state with the placeholder and save label', () => {
    const html = renderToStaticMarkup(<ProviderKeySection {...baseProps} hasKey={false} />);

    expect(html).toContain('sk-or-...');
    expect(html).toContain('Save key');
    expect(html).toContain('Stored locally in your browser.');
  });
});

describe('ExperimentalProviderSection', () => {
  const baseProps = {
    label: 'Azure',
    backendId: 'azure' as const,
    activeBackend: null,
    setActiveBackend: vi.fn(),
    clearPreferredProvider: vi.fn(),
    helperText: 'Bring your own Azure endpoint.',
    hasKey: false,
    keyInput: '',
    setKeyInput: vi.fn(),
    setKey: vi.fn(),
    clearKey: vi.fn(),
    baseUrl: '',
    baseUrlInput: '',
    setBaseUrlInput: vi.fn(),
    baseUrlError: null,
    setBaseUrl: vi.fn(),
    clearBaseUrl: vi.fn(),
    baseUrlPlaceholder: 'https://example.openai.azure.com/openai/v1',
    model: '',
    modelInput: '',
    setModelInput: vi.fn(),
    clearModel: vi.fn(),
    activeDeploymentId: null,
    saveDeployment: vi.fn(() => true),
    selectDeployment: vi.fn(),
    removeDeployment: vi.fn(),
    clearDeployments: vi.fn(),
    modelPlaceholder: 'gpt-4.1',
  };

  it('shows the "Bring your own" pill and empty deployments state when not configured', () => {
    const html = renderToStaticMarkup(
      <ExperimentalProviderSection {...baseProps} configured={false} deployments={[]} />,
    );

    expect(html).toContain('Bring your own');
    expect(html).toContain('No saved deployments yet.');
    expect(html).toContain('0/3 saved');
  });

  it('shows saved deployments and marks the active one', () => {
    const html = renderToStaticMarkup(
      <ExperimentalProviderSection
        {...baseProps}
        configured
        hasKey
        deployments={[
          { id: 'd1', model: 'gpt-4.1', createdAt: 1 },
          { id: 'd2', model: 'gpt-4o', createdAt: 2 },
        ]}
        activeDeploymentId="d2"
      />,
    );

    expect(html).toContain('gpt-4.1');
    expect(html).toContain('gpt-4o');
    expect(html).toContain('Connected');
    expect(html).toContain('2/3 saved');
    // Active deployment shows the "Active" badge.
    expect(html).toContain('Active');
  });

  it('warns when the deployment limit is reached', () => {
    const html = renderToStaticMarkup(
      <ExperimentalProviderSection
        {...baseProps}
        configured
        hasKey
        deployments={[
          { id: 'd1', model: 'a', createdAt: 1 },
          { id: 'd2', model: 'b', createdAt: 2 },
          { id: 'd3', model: 'c', createdAt: 3 },
        ]}
        activeDeploymentId="d1"
      />,
    );

    expect(html).toContain('Remove one before adding another');
  });
});
