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
    blackboxModel: 'blackbox-ai',
    blackboxModelOptions: ['blackbox-ai'],
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
});
