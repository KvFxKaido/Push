import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatInput } from './ChatInput';

function buildProps(
  overrides: Partial<ComponentProps<typeof ChatInput>> = {},
): ComponentProps<typeof ChatInput> {
  const providerControls: NonNullable<ComponentProps<typeof ChatInput>['providerControls']> = {
    selectedProvider: 'kilocode',
    availableProviders: [['kilocode', 'Kilo Code', true] as const],
    isProviderLocked: false,
    lockedProvider: null,
    lockedModel: null,
    onSelectBackend: vi.fn(),
    ollamaModel: 'gemini-3-flash-preview',
    ollamaModelOptions: ['gemini-3-flash-preview'],
    ollamaModelsLoading: false,
    ollamaModelsError: null,
    ollamaModelsUpdatedAt: null,
    isOllamaModelLocked: false,
    refreshOllamaModels: vi.fn(),
    onSelectOllamaModel: vi.fn(),
    openRouterModel: 'anthropic/claude-sonnet-4.6:nitro',
    openRouterModelOptions: ['anthropic/claude-sonnet-4.6:nitro'],
    isOpenRouterModelLocked: false,
    onSelectOpenRouterModel: vi.fn(),
    cloudflareModel: '@cf/qwen/qwen3-30b-a3b-fp8',
    cloudflareModelOptions: ['@cf/qwen/qwen3-30b-a3b-fp8'],
    cloudflareModelsLoading: false,
    cloudflareModelsError: null,
    cloudflareModelsUpdatedAt: null,
    isCloudflareModelLocked: false,
    refreshCloudflareModels: vi.fn(),
    onSelectCloudflareModel: vi.fn(),
    zenModel: 'big-pickle',
    zenModelOptions: ['big-pickle'],
    zenModelsLoading: false,
    zenModelsError: null,
    zenModelsUpdatedAt: null,
    isZenModelLocked: false,
    refreshZenModels: vi.fn(),
    onSelectZenModel: vi.fn(),
    nvidiaModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    nvidiaModelOptions: ['nvidia/llama-3.1-nemotron-70b-instruct'],
    nvidiaModelsLoading: false,
    nvidiaModelsError: null,
    nvidiaModelsUpdatedAt: null,
    isNvidiaModelLocked: false,
    refreshNvidiaModels: vi.fn(),
    onSelectNvidiaModel: vi.fn(),
    blackboxModel: 'blackboxai/anthropic/claude-haiku-4.5',
    blackboxModelOptions: ['blackboxai/anthropic/claude-haiku-4.5'],
    blackboxModelsLoading: false,
    blackboxModelsError: null,
    blackboxModelsUpdatedAt: null,
    isBlackboxModelLocked: false,
    refreshBlackboxModels: vi.fn(),
    onSelectBlackboxModel: vi.fn(),
    kilocodeModel: 'google/gemini-3-flash-preview',
    kilocodeModelOptions: ['google/gemini-3-flash-preview', 'openai/gpt-5.2'],
    kilocodeModelsLoading: false,
    kilocodeModelsError: null,
    kilocodeModelsUpdatedAt: null,
    isKilocodeModelLocked: false,
    refreshKilocodeModels: vi.fn(),
    onSelectKilocodeModel: vi.fn(),
    fireworksModel: 'accounts/fireworks/models/deepseek-v4-pro',
    fireworksModelOptions: ['accounts/fireworks/models/deepseek-v4-pro'],
    fireworksModelsLoading: false,
    fireworksModelsError: null,
    fireworksModelsUpdatedAt: null,
    isFireworksModelLocked: false,
    refreshFireworksModels: vi.fn(),
    onSelectFireworksModel: vi.fn(),
    openadapterModel: 'moonshotai/kimi-k2-instruct',
    openadapterModelOptions: ['moonshotai/kimi-k2-instruct'],
    openadapterModelsLoading: false,
    openadapterModelsError: null,
    openadapterModelsUpdatedAt: null,
    isOpenAdapterModelLocked: false,
    refreshOpenAdapterModels: vi.fn(),
    onSelectOpenAdapterModel: vi.fn(),
    azureModel: 'gpt-4.1',
    azureDeployments: [],
    azureActiveDeploymentId: null,
    isAzureModelLocked: false,
    onSelectAzureModel: vi.fn(),
    onSelectAzureDeployment: vi.fn(),
    bedrockModel: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    bedrockDeployments: [],
    bedrockActiveDeploymentId: null,
    isBedrockModelLocked: false,
    onSelectBedrockModel: vi.fn(),
    onSelectBedrockDeployment: vi.fn(),
    vertexModel: 'gemini-2.5-pro',
    vertexModelOptions: ['gemini-2.5-pro'],
    isVertexModelLocked: false,
    onSelectVertexModel: vi.fn(),
    anthropicModel: 'claude-sonnet-4-6',
    anthropicModelOptions: ['claude-sonnet-4-6'],
    isAnthropicModelLocked: false,
    onSelectAnthropicModel: vi.fn(),
    openaiModel: 'gpt-5.4',
    openaiModelOptions: ['gpt-5.4'],
    isOpenAIModelLocked: false,
    onSelectOpenAIModel: vi.fn(),
    googleModel: 'gemini-3.1-pro-preview',
    googleModelOptions: ['gemini-3.1-pro-preview'],
    isGoogleModelLocked: false,
    onSelectGoogleModel: vi.fn(),
  };

  return {
    onSend: vi.fn(),
    providerControls,
    ...overrides,
  };
}

describe('ChatInput', () => {
  it('shows the selected Kilo Code model instead of falling back to demo', () => {
    const html = renderToStaticMarkup(<ChatInput {...buildProps()} />);

    expect(html).toContain('gemini-3-flash-preview');
    expect(html).not.toContain('>demo<');
  });

  it('shows queued follow-up status while streaming', () => {
    const html = renderToStaticMarkup(
      <ChatInput {...buildProps({ isStreaming: true, queuedFollowUpCount: 2 })} />,
    );

    expect(html).toContain('2 follow-ups queued');
  });

  it('shows pending steering status while streaming', () => {
    const html = renderToStaticMarkup(
      <ChatInput {...buildProps({ isStreaming: true, pendingSteerCount: 1 })} />,
    );

    expect(html).toContain('Steering update captured. It will apply after the current step.');
  });

  it('renders the linked-libraries chip strip when libraryEnabled + linkedLibraryIds is non-empty', () => {
    const html = renderToStaticMarkup(
      <ChatInput
        {...buildProps({
          libraryEnabled: true,
          linkedLibraryIds: ['lib-abc12345-6789-4def-90ab-cdef01234567'],
          onSetLinkedLibraries: vi.fn(),
        })}
      />,
    );
    // The "Linked" header appears in the chip strip.
    expect(html).toContain('Linked');
    // The short-id fallback (truncated UUID) shows until names resolve
    // — `useChatLibrary` returns an empty collection list in this
    // server-rendered context. First 8 chars + ellipsis.
    expect(html).toContain('lib-abc1');
    // The unlink button is rendered for each chip.
    expect(html).toContain('aria-label="Unlink');
  });

  it('does not render the chip strip when linkedLibraryIds is empty or undefined', () => {
    const empty = renderToStaticMarkup(
      <ChatInput {...buildProps({ libraryEnabled: true, linkedLibraryIds: [] })} />,
    );
    expect(empty).not.toMatch(/<span[^>]*>Linked</);

    const undef = renderToStaticMarkup(<ChatInput {...buildProps({ libraryEnabled: true })} />);
    expect(undef).not.toMatch(/<span[^>]*>Linked</);
  });
});
