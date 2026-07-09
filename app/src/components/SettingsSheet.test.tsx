import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsBuiltInProvider,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from './SettingsSheet';
import { ProviderKeySection, SettingsSheet } from './SettingsSheet';
import { SettingsSectionContent } from './SettingsSectionContent';
import {
  BUILT_IN_SETTINGS_PROVIDER_ORDER,
  type BuiltInSettingsProviderId,
} from './settings-shared';

function emptyAuth(): SettingsAuthProps {
  return {
    isConnected: false,
    isAppAuth: false,
    installationId: '',
    token: '',
    tokenKind: 'none',
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
    builtInProviders: Object.fromEntries(
      BUILT_IN_SETTINGS_PROVIDER_ORDER.map((providerId) => [
        providerId,
        {
          hasKey: false,
          model: '',
          setModel: vi.fn(),
          modelOptions: [],
          modelsLoading: false,
          modelsError: null,
          modelsUpdatedAt: null,
          isModelLocked: false,
          refreshModels: vi.fn(),
          keyInput: '',
          setKeyInput: vi.fn(),
          setKey: vi.fn(),
          clearKey: vi.fn(),
        } satisfies SettingsBuiltInProvider,
      ]),
    ) as unknown as Record<BuiltInSettingsProviderId, SettingsBuiltInProvider>,
    cloudflareProvider: {
      configured: false,
      statusLoading: false,
      statusError: null,
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      setModel: vi.fn(),
      modelOptions: ['@cf/qwen/qwen3-30b-a3b-fp8'],
      modelsLoading: false,
      modelsError: null,
      modelsUpdatedAt: null,
      isModelLocked: false,
      refreshModels: vi.fn(),
    },
    tavilyProvider: {} as never,
  };
}

function emptyWorkspace(): SettingsWorkspaceProps {
  return {
    approvalMode: 'supervised',
    updateApprovalMode: vi.fn(),
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
    providerFailover: false,
    setProviderFailover: vi.fn(),
    runTokenBudget: null,
    setRunTokenBudget: vi.fn(),
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

describe('SettingsSectionContent', () => {
  it('renders env-backed GitHub credentials as build-time tokens', () => {
    const html = renderToStaticMarkup(
      <SettingsSectionContent
        settingsTab="you"
        auth={{
          ...emptyAuth(),
          isConnected: true,
          token: 'ghp_env',
          tokenKind: 'env',
          patToken: 'ghp_env',
          validatedUser: { login: 'ishaw' },
        }}
        profile={emptyProfile()}
        ai={emptyAI()}
        workspace={emptyWorkspace()}
        data={emptyData()}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain('Build-time token');
    expect(html).toContain('VITE_GITHUB_TOKEN');
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
    // Picker trigger includes the formatted display name of the current value and its accessible label.
    expect(html).toContain('Anthropic / claude-sonnet');
    expect(html).toContain('Select OpenRouter model');
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
