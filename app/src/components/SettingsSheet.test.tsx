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
  PROVIDER_LABELS,
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
    activeProviderLabel: 'zen',
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

  it('renders the AI provider accordion with only the default item expanded', () => {
    // Two connected providers: the accordion seeds open on the first one in
    // order; the second stays collapsed (content unmounted, not just hidden).
    const [first, second] = BUILT_IN_SETTINGS_PROVIDER_ORDER;
    const ai = emptyAI();
    ai.builtInProviders[first] = { ...ai.builtInProviders[first], hasKey: true };
    ai.builtInProviders[second] = { ...ai.builtInProviders[second], hasKey: true };
    ai.tavilyProvider = {
      hasKey: false,
      keyInput: '',
      setKeyInput: vi.fn(),
      setKey: vi.fn(),
      clearKey: vi.fn(),
    };

    const html = renderToStaticMarkup(
      <SettingsSectionContent
        settingsTab="ai"
        auth={emptyAuth()}
        profile={emptyProfile()}
        ai={ai}
        workspace={emptyWorkspace()}
        data={emptyData()}
        onDismiss={() => {}}
      />,
    );

    // Both triggers render their header rows...
    expect(html).toContain(PROVIDER_LABELS[first]);
    expect(html).toContain(PROVIDER_LABELS[second]);
    // ...but only the default-open item mounts its body (the model picker).
    expect(html).toContain(`Select ${PROVIDER_LABELS[first]} model`);
    expect(html).not.toContain(`Select ${PROVIDER_LABELS[second]} model`);
    // Cloudflare folds into the same accordion: header visible, body collapsed.
    expect(html).toContain('Not configured on Worker');
    expect(html).not.toContain('Worker-bound model');
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

  it('renders connected with NO key input when the key lives in the gateway (BYOK)', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection {...baseProps} hasKey={false} credentialSource="gateway-byok" />,
    );

    expect(html).toContain('Key in gateway');
    expect(html).toContain('stored in the AI Gateway');
    // No password input, no save button, no remove button: there is no
    // browser-held key to enter or delete.
    expect(html).not.toContain('sk-or-...');
    expect(html).not.toContain('Save key');
    expect(html).not.toContain('Remove');
  });

  it('marks a lingering local key as unused under BYOK and keeps the remove affordance', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection {...baseProps} hasKey credentialSource="gateway-byok" />,
    );

    expect(html).toContain('Key in gateway');
    expect(html).toContain('Your local key is unused.');
    expect(html).toContain('Remove unused local OpenRouter key');
  });

  it('renders connected for a Worker-secret credential without an input', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection {...baseProps} hasKey={false} credentialSource="worker-secret" />,
    );

    expect(html).toContain('Server key');
    expect(html).toContain('set on the Worker');
    expect(html).not.toContain('Save key');
  });

  it('renders connected with a remove affordance for an account-held key with no local copy', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection {...baseProps} hasKey={false} credentialSource="user-key" />,
    );

    // Selectable via the server-mirrored key (Codex P2): no empty password
    // form pretending nothing is configured, and the trash removes the
    // account copy via clearKey's server-store mirror.
    expect(html).toContain('Connected');
    expect(html).toContain('saved to your account');
    expect(html).toContain('Remove OpenRouter key');
    expect(html).not.toContain('sk-or-...');
    expect(html).not.toContain('Save key');
  });

  it('keeps the plain key input for a provider with no credential anywhere', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection {...baseProps} hasKey={false} credentialSource={null} />,
    );

    expect(html).toContain('sk-or-...');
    expect(html).toContain('Save key');
  });

  // Partial gateway coverage (zen: the separate Go subscription service has
  // MiniMax/Qwen models needing x-api-key, which gateway injection cannot
  // set). The gateway key covers most models, but the local key stays
  // load-bearing — the section must keep offering it.
  const PARTIAL_NOTE =
    'Go — OpenCode’s separate subscription service — includes MiniMax and Qwen models that authenticate with x-api-key, which the gateway cannot inject. The server covers them when deployed with the Secrets Store binding; a key saved here takes precedence.';

  it('partial BYOK keeps the key input alongside the gateway-connected state', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection
        {...baseProps}
        hasKey={false}
        credentialSource="gateway-byok"
        byokPartialNote={PARTIAL_NOTE}
      />,
    );

    expect(html).toContain('Key in gateway');
    expect(html).toContain('for most models');
    expect(html).toContain('separate subscription service');
    expect(html).toContain('a key saved here takes precedence');
    // Unlike full BYOK, the input + save stay available.
    expect(html).toContain('sk-or-...');
    expect(html).toContain('Save key');
    expect(html).not.toContain('No local key needed');
  });

  it('partial BYOK never labels a saved local key as unused', () => {
    const html = renderToStaticMarkup(
      <ProviderKeySection
        {...baseProps}
        hasKey
        credentialSource="gateway-byok"
        byokPartialNote={PARTIAL_NOTE}
      />,
    );

    expect(html).toContain('Key in gateway');
    expect(html).toContain('Your saved key covers them.');
    expect(html).not.toContain('unused');
    expect(html).toContain('Remove OpenRouter key');
    // Key already saved — no second input form.
    expect(html).not.toContain('sk-or-...');
  });
});
