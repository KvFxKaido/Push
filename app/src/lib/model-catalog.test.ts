import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCuratedNvidiaModelList,
  buildCuratedOllamaModelList,
  buildCuratedOpencodeModelList,
  buildCuratedOpenRouterModelList,
  fetchGoogleModels,
  fetchKilocodeModels,
  fetchNvidiaModels,
  fetchOllamaModels,
  fetchOpenAIModels,
  fetchZenModels,
  filterModelByContext,
  MIN_CONTEXT_TOKENS,
  parseOpenRouterCatalog,
  providerModelSupportsNativeToolCalling,
  providerModelSupportsStructuredOutput,
  resolvePushCapabilityProfile,
  getModelCapabilities,
} from './model-catalog';
import { cliProviderModelSupportsNativeToolCalling } from '../../../cli/native-tool-gate';
import {
  ANTHROPIC_MODELS,
  FIREWORKS_MODELS,
  GOOGLE_MODELS,
  KILOCODE_MODELS,
  OPENAI_MODELS,
} from '@push/lib/provider-models';

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

function stubWindow() {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage: createStorageMock(),
    sessionStorage: createStorageMock(),
  });
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseOpenRouterCatalog', () => {
  it('extracts text/image modalities and supported parameters from the OpenRouter payload', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          architecture: {
            modality: 'text+image+file->text',
            input_modalities: ['text', 'image', 'file'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools', 'structured_outputs'],
          top_provider: { context_length: 1_050_000, is_moderated: true },
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
        supportedParameters: ['tools', 'structured_outputs'],
        contextLength: 1_050_000,
        isModerated: true,
      },
    ]);
  });
});

describe('buildCuratedOpenRouterModelList', () => {
  it('prefers priority chat models and excludes image-output-only models', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools', 'structured_outputs'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          architecture: {
            input_modalities: ['text', 'image', 'file'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools', 'structured_outputs', 'reasoning'],
          top_provider: { context_length: 1_050_000, is_moderated: true },
        },
        {
          id: 'google/gemini-3.1-pro-preview',
          name: 'Gemini 3.1 Pro',
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 1_000_000, is_moderated: true },
        },
        {
          id: 'openai/gpt-image-1',
          name: 'GPT Image 1',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['image'],
          },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: true },
        },
      ],
    });

    const curated = buildCuratedOpenRouterModelList(models);

    expect(curated[0]).toBe('anthropic/claude-sonnet-4.6:nitro');
    expect(curated).toContain('openai/gpt-5.4');
    expect(curated).toContain('google/gemini-3.1-pro-preview:nitro');
    expect(curated).not.toContain('openai/gpt-image-1');
  });

  it('includes priority models even when metadata is unavailable', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
        {
          id: 'openai/gpt-5.4',
          name: 'GPT-5.4',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 1_050_000, is_moderated: true },
        },
      ],
    });

    // No metadataById — simulates models.dev being down
    const curated = buildCuratedOpenRouterModelList(models);

    expect(curated).toContain('anthropic/claude-sonnet-4.6:nitro');
    expect(curated).toContain('openai/gpt-5.4');
  });

  it('appends live chat models that are not in the priority list', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
        {
          id: 'openai/gpt-5.5',
          name: 'GPT-5.5',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
        {
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 256_000, is_moderated: false },
        },
      ],
    });

    const curated = buildCuratedOpenRouterModelList(models);

    // Priority model still pinned at the top.
    expect(curated[0]).toBe('anthropic/claude-sonnet-4.6:nitro');
    // New live-only models are appended (sorted) after the priority block.
    expect(curated).toContain('openai/gpt-5.5');
    expect(curated).toContain('deepseek/deepseek-v4-flash');
    expect(curated.indexOf('openai/gpt-5.5')).toBeGreaterThan(
      curated.indexOf('anthropic/claude-sonnet-4.6:nitro'),
    );
  });

  it('does not duplicate a live base model that is already pinned via :nitro', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
      ],
    });

    const curated = buildCuratedOpenRouterModelList(models);

    expect(curated.filter((id) => id.startsWith('anthropic/claude-sonnet-4.6'))).toEqual([
      'anthropic/claude-sonnet-4.6:nitro',
    ]);
  });

  it('excludes embedding, rerank, and image-generation live models from the tail', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'openai/text-embedding-3-large',
          name: 'Embed',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: false },
        },
        {
          id: 'cohere/rerank-v3',
          name: 'Rerank',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: false },
        },
        {
          id: 'black-forest-labs/flux-1.1-pro',
          name: 'Flux',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: false },
        },
      ],
    });

    const curated = buildCuratedOpenRouterModelList(models);

    expect(curated).not.toContain('openai/text-embedding-3-large');
    expect(curated).not.toContain('cohere/rerank-v3');
    expect(curated).not.toContain('black-forest-labs/flux-1.1-pro');
  });

  it('does not resurface a metadata-rejected priority base model in the tail', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
      ],
    });

    // Metadata marks the base model as image-only, so the :nitro priority
    // entry is filtered out. The base id must not sneak back in via the tail.
    const curated = buildCuratedOpenRouterModelList(models, {
      'anthropic/claude-sonnet-4.6': {
        id: 'anthropic/claude-sonnet-4.6',
        attachment: false,
        reasoning: false,
        toolCall: true,
        structuredOutput: true,
        openWeights: false,
        inputModalities: ['text'],
        outputModalities: ['image'],
        contextLimit: 400_000,
      },
    });

    expect(curated).not.toContain('anthropic/claude-sonnet-4.6:nitro');
    expect(curated).not.toContain('anthropic/claude-sonnet-4.6');
  });

  it('excludes nv-rerank and nvolve families from the live tail', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'nvidia/nv-rerank-qa-mistral-4b',
          name: 'NV Rerank',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: false },
        },
        {
          id: 'nvidia/nvolve-v2',
          name: 'Nvolve',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: [],
          top_provider: { context_length: 128_000, is_moderated: false },
        },
      ],
    });

    const curated = buildCuratedOpenRouterModelList(models);

    expect(curated).not.toContain('nvidia/nv-rerank-qa-mistral-4b');
    expect(curated).not.toContain('nvidia/nvolve-v2');
  });

  it('excludes image-only priority models when metadata is available', () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          supported_parameters: ['tools'],
          top_provider: { context_length: 400_000, is_moderated: true },
        },
      ],
    });

    // Metadata keyed by base ID (as models.dev returns)
    const curated = buildCuratedOpenRouterModelList(models, {
      'anthropic/claude-sonnet-4.6': {
        id: 'anthropic/claude-sonnet-4.6',
        reasoning: false,
        toolCall: true,
        structuredOutput: true,
        openWeights: false,
        inputModalities: ['text'],
        outputModalities: ['image'],
        contextLimit: 400_000,
      },
    });

    expect(curated).not.toContain('anthropic/claude-sonnet-4.6:nitro');
  });
});

describe('buildCuratedNvidiaModelList', () => {
  it('prefers priority chat models and excludes image-output or retrieval models', () => {
    const curated = buildCuratedNvidiaModelList(
      [
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'meta/llama-3.3-70b-instruct',
        'qwen/qwen2.5-coder-32b-instruct',
        'nvidia/nv-rerankqa-mistral-4b-v3',
        'black-forest-labs/flux.1-dev',
      ],
      {
        'nvidia/llama-3.1-nemotron-70b-instruct': {
          id: 'nvidia/llama-3.1-nemotron-70b-instruct',
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 131_072,
        },
        'meta/llama-3.3-70b-instruct': {
          id: 'meta/llama-3.3-70b-instruct',
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 131_072,
        },
        'qwen/qwen2.5-coder-32b-instruct': {
          id: 'qwen/qwen2.5-coder-32b-instruct',
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 131_072,
        },
        'nvidia/nv-rerankqa-mistral-4b-v3': {
          id: 'nvidia/nv-rerankqa-mistral-4b-v3',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: false,
          inputModalities: ['text'],
          outputModalities: ['score'],
          contextLimit: 0,
        },
        'black-forest-labs/flux.1-dev': {
          id: 'black-forest-labs/flux.1-dev',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['image'],
          contextLimit: 0,
        },
      },
    );

    expect(curated[0]).toBe('nvidia/llama-3.1-nemotron-70b-instruct');
    expect(curated).toContain('meta/llama-3.3-70b-instruct');
    expect(curated).toContain('qwen/qwen2.5-coder-32b-instruct');
    expect(curated).not.toContain('nvidia/nv-rerankqa-mistral-4b-v3');
    expect(curated).not.toContain('black-forest-labs/flux.1-dev');
  });
});

describe('buildCuratedOllamaModelList', () => {
  it('prefers priority chat models and excludes image-output or embedding models', () => {
    const curated = buildCuratedOllamaModelList(
      [
        'minimax-m3',
        'glm-5.2',
        'qwen3.5:397b',
        'qwen3-vl:235b-instruct',
        'nomic-embed-text',
        'flux.1-dev',
      ],
      {
        'minimax-m3': {
          id: 'minimax-m3',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text', 'image', 'video'],
          outputModalities: ['text'],
          contextLimit: 512_000,
        },
        'glm-5.2': {
          id: 'glm-5.2',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 128_000,
        },
        'qwen3.5:397b': {
          id: 'qwen3.5:397b',
          attachment: false,
          reasoning: true,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 256_000,
        },
        'qwen3-vl:235b-instruct': {
          id: 'qwen3-vl:235b-instruct',
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 128_000,
        },
        'nomic-embed-text': {
          id: 'nomic-embed-text',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['embedding'],
          contextLimit: 8_192,
        },
        'flux.1-dev': {
          id: 'flux.1-dev',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['image'],
          contextLimit: 0,
        },
      },
    );

    expect(curated[0]).toBe('minimax-m3');
    expect(curated).toContain('glm-5.2');
    expect(curated).toContain('qwen3.5:397b');
    expect(curated).toContain('qwen3-vl:235b-instruct');
    expect(curated).not.toContain('nomic-embed-text');
    expect(curated).not.toContain('flux.1-dev');
  });

  it('allows non-priority models with missing context metadata via fail-open', () => {
    const curated = buildCuratedOllamaModelList(
      ['minimax-m3', 'some-new-model', 'google/nanobanana-preview', 'black-forest-labs/flux.1-dev'],
      {
        'minimax-m3': {
          id: 'minimax-m3',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text', 'image', 'video'],
          outputModalities: ['text'],
          contextLimit: 512_000,
        },
        // Metadata record exists but context was missing → coerced to 0
        'some-new-model': {
          id: 'some-new-model',
          attachment: false,
          reasoning: false,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 0,
        },
      },
    );

    expect(curated).toContain('minimax-m3');
    // contextLimit 0 is treated as "missing" → Ollama's fail-open allows it
    expect(curated).toContain('some-new-model');
    expect(curated).not.toContain('google/nanobanana-preview');
    expect(curated).not.toContain('black-forest-labs/flux.1-dev');
  });
});

describe('buildCuratedOpencodeModelList', () => {
  it('prefers priority chat models and excludes image-output or embedding models', () => {
    const curated = buildCuratedOpencodeModelList(
      [
        'openai/gpt-5.3-codex',
        'claude-sonnet-4-6',
        'gemini-3.1-pro',
        'qwen3-coder',
        'text-embedding-3-large',
        'gpt-image-1',
      ],
      {
        'openai/gpt-5.3-codex': {
          id: 'openai/gpt-5.3-codex',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image', 'file'],
          outputModalities: ['text'],
          contextLimit: 400_000,
        },
        'claude-sonnet-4-6': {
          id: 'claude-sonnet-4-6',
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 200_000,
        },
        'gemini-3.1-pro': {
          id: 'gemini-3.1-pro',
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 1_000_000,
        },
        'qwen3-coder': {
          id: 'qwen3-coder',
          attachment: false,
          reasoning: true,
          toolCall: true,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLimit: 256_000,
        },
        'text-embedding-3-large': {
          id: 'text-embedding-3-large',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: false,
          inputModalities: ['text'],
          outputModalities: ['embedding'],
          contextLimit: 8_192,
        },
        'gpt-image-1': {
          id: 'gpt-image-1',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: false,
          inputModalities: ['text'],
          outputModalities: ['image'],
          contextLimit: 0,
        },
      },
    );

    expect(curated[0]).toBe('openai/gpt-5.3-codex');
    expect(curated).toContain('claude-sonnet-4-6');
    expect(curated).toContain('gemini-3.1-pro');
    expect(curated).toContain('qwen3-coder');
    expect(curated).not.toContain('text-embedding-3-large');
    expect(curated).not.toContain('gpt-image-1');
  });
});

describe('provider model fetchers', () => {
  it.each([
    {
      name: 'Ollama',
      fetchModels: fetchOllamaModels,
      providerMatcher: (url: string) =>
        url.includes('/ollama/') || url.includes('/api/ollama/models'),
      modelsDevPayload: {
        'ollama-cloud': {
          models: {
            'tiny-context-model': {
              id: 'tiny-context-model',
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 32_000 },
            },
          },
        },
      },
    },
    {
      name: 'OpenCode Zen',
      fetchModels: fetchZenModels,
      providerMatcher: (url: string) =>
        url.includes('/opencode/zen/') || url.includes('/api/zen/models'),
      modelsDevPayload: {
        opencode: {
          models: {
            'tiny-context-model': {
              id: 'tiny-context-model',
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 32_000 },
            },
          },
        },
      },
    },
    {
      name: 'Nvidia NIM',
      fetchModels: fetchNvidiaModels,
      providerMatcher: (url: string) =>
        url.includes('/nvidia/') || url.includes('/api/nvidia/models'),
      modelsDevPayload: {
        nvidia: {
          models: {
            'tiny-context-model': {
              id: 'tiny-context-model',
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 32_000 },
            },
          },
        },
      },
    },
  ])('does not fall back to the raw provider list for $name when every model is filtered out', async ({
    fetchModels,
    providerMatcher,
    modelsDevPayload,
  }) => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('models.dev/api.json')) {
          return jsonResponse(modelsDevPayload);
        }
        if (providerMatcher(url)) {
          return jsonResponse({ data: [{ id: 'tiny-context-model' }] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await expect(fetchModels()).resolves.toEqual([]);
  });

  it('re-fetches provider metadata after the in-memory cache TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T00:00:00Z'));
    stubWindow();

    const thirteenHoursMs = 13 * 60 * 60 * 1000;
    let contextLimit = 32_000;
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('models.dev/api.json')) {
        return jsonResponse({
          nvidia: {
            models: {
              'fresh-context-model': {
                id: 'fresh-context-model',
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: contextLimit },
              },
            },
          },
        });
      }
      if (url.includes('/nvidia/') || url.includes('/api/nvidia/models')) {
        return jsonResponse({ data: [{ id: 'fresh-context-model' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchSpy);

    vi.resetModules();
    const { fetchNvidiaModels: fetchFreshNvidiaModels, MIN_CONTEXT_TOKENS: freshMinContextTokens } =
      await import('./model-catalog');

    await expect(fetchFreshNvidiaModels()).resolves.toEqual([]);

    contextLimit = freshMinContextTokens;
    vi.setSystemTime(Date.now() + thirteenHoursMs);

    await expect(fetchFreshNvidiaModels()).resolves.toEqual(['fresh-context-model']);

    const modelsDevCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('models.dev/api.json'),
    );
    expect(modelsDevCalls).toHaveLength(2);
  });

  it('re-fetches provider metadata on a forced refresh before the TTL expires', async () => {
    stubWindow();

    let contextLimit = 32_000;
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('models.dev/api.json')) {
        return jsonResponse({
          nvidia: {
            models: {
              'fresh-context-model': {
                id: 'fresh-context-model',
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: contextLimit },
              },
            },
          },
        });
      }
      if (url.includes('/nvidia/') || url.includes('/api/nvidia/models')) {
        return jsonResponse({ data: [{ id: 'fresh-context-model' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    const { fetchNvidiaModels: fetchFreshNvidiaModels } = await import('./model-catalog');

    // First (auto) fetch caches metadata; the model fails the context floor.
    await expect(fetchFreshNvidiaModels()).resolves.toEqual([]);

    // Upstream now reports a usable context, but a non-forced refresh keeps
    // serving the cached (stale) metadata, so the model stays filtered out.
    contextLimit = 200_000;
    await expect(fetchFreshNvidiaModels()).resolves.toEqual([]);

    // A forced refresh busts the metadata cache and re-fetches models.dev,
    // surfacing the now-eligible model without waiting out the 12h TTL.
    await expect(fetchFreshNvidiaModels({ forceMetadataRefresh: true })).resolves.toEqual([
      'fresh-context-model',
    ]);

    const modelsDevCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('models.dev/api.json'),
    );
    // 1 (first auto) + 0 (cached, non-forced) + 1 (forced) = 2.
    expect(modelsDevCalls).toHaveLength(2);
  });
});

describe('fetchGoogleModels', () => {
  it('normalizes the Worker proxy model list payload', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          object: 'list',
          data: [
            { id: 'gemini-pro', name: 'gemini-pro' },
            { id: 'gemini-flash', name: 'gemini-flash' },
          ],
        }),
      ),
    );

    await expect(fetchGoogleModels()).resolves.toEqual(['gemini-flash', 'gemini-pro']);
  });

  it('throws on non-OK response', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'Server error' })),
    );

    await expect(fetchGoogleModels()).rejects.toThrow(/Google Gemini model list failed \(500\)/);
  });
});

describe('fetchOpenAIModels', () => {
  it('normalizes the Worker proxy model list payload', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          object: 'list',
          data: [
            { id: 'gpt-5.2', name: 'gpt-5.2' },
            { id: 'gpt-5.1', name: 'gpt-5.1' },
          ],
        }),
      ),
    );

    await expect(fetchOpenAIModels()).resolves.toEqual(['gpt-5.1', 'gpt-5.2']);
  });

  it('throws on non-OK response', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' })),
    );

    await expect(fetchOpenAIModels()).rejects.toThrow(/OpenAI model list failed \(401\)/);
  });
});

describe('fetchKilocodeModels', () => {
  it('keeps only canonical model ids from the OpenAI-style Kilo catalog payload', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: 'google/gemini-3-flash-preview', name: 'Google: Gemini 3 Flash Preview' },
            { id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6' },
            { name: 'OpenAI: GPT 5.2' },
          ],
        }),
      ),
    );

    await expect(fetchKilocodeModels()).resolves.toEqual([
      'anthropic/claude-sonnet-4.6',
      'google/gemini-3-flash-preview',
    ]);
  });
});

describe('filterModelByContext', () => {
  const prioritySet = new Set(['priority-model-1', 'priority-model-2']);

  it('rejects models with missing contextLimit (fail-closed)', () => {
    const result = filterModelByContext('test-model', undefined, prioritySet);
    expect(result.allowed).toBe(false);

    const nullResult = filterModelByContext('test-model', null, prioritySet);
    expect(nullResult.allowed).toBe(false);

    // 0 is treated as missing — it's a coercion artifact, not real data
    const zeroResult = filterModelByContext('test-model', 0, prioritySet);
    expect(zeroResult.allowed).toBe(false);
  });

  it('rejects models with contextLimit below MIN_CONTEXT_TOKENS threshold', () => {
    const result = filterModelByContext('test-model', MIN_CONTEXT_TOKENS - 1, prioritySet);
    expect(result.allowed).toBe(false);

    // Exactly at threshold - should pass
    const atThreshold = filterModelByContext('test-model', MIN_CONTEXT_TOKENS, prioritySet);
    expect(atThreshold.allowed).toBe(true);

    // Above threshold - should pass
    const above = filterModelByContext('test-model', MIN_CONTEXT_TOKENS + 1000, prioritySet);
    expect(above.allowed).toBe(true);
  });

  it('allows priority models to bypass context checks', () => {
    const result = filterModelByContext('priority-model-1', undefined, prioritySet);
    expect(result.allowed).toBe(true);

    const lowContext = filterModelByContext('priority-model-2', 1000, prioritySet);
    expect(lowContext.allowed).toBe(true);
  });
});

describe('providerModelSupportsStructuredOutput', () => {
  it('uses declared metadata on a cold cache before falling back to name guesses', () => {
    vi.stubGlobal('window', undefined);

    expect(getModelCapabilities('openai', 'gpt-5.4-mini')).toMatchObject({
      reasoning: true,
      toolCall: true,
      structuredOutput: true,
      vision: true,
      contextLimit: 400_000,
    });
    expect(resolvePushCapabilityProfile('zen', 'big-pickle')).toMatchObject({
      toolCalling: 'native',
      structuredOutput: 'strict',
      context: 'large',
    });

    // PDF-only declared models accept file attachments but not image input, so
    // declared metadata must not resolve them as vision-capable on a cold cache.
    expect(getModelCapabilities('openrouter', 'mistralai/codestral-2508')).toMatchObject({
      vision: false,
    });
  });

  it('resolves the Push capability profile for direct neutral providers', () => {
    stubWindow();
    expect(resolvePushCapabilityProfile('anthropic', 'claude-sonnet-4-6')).toMatchObject({
      toolCalling: 'native',
      streamingTools: true,
      structuredOutput: 'strict',
      contentBlocks: true,
      reasoningBlocks: true,
      multimodal: true,
    });
    expect(resolvePushCapabilityProfile('google', 'gemini-3.5-flash')).toMatchObject({
      toolCalling: 'native',
      contentBlocks: true,
      reasoningBlocks: false,
      multimodal: true,
    });
  });

  it('lets transport mode decide content-block emission inside the profile', () => {
    stubWindow();
    expect(
      resolvePushCapabilityProfile('zen', 'kimi-k2.6', { requestWire: 'openai' }),
    ).toMatchObject({
      contentBlocks: false,
      reasoningBlocks: false,
    });
    expect(
      resolvePushCapabilityProfile('zen', 'minimax-m3', { requestWire: 'neutral' }),
    ).toMatchObject({
      contentBlocks: true,
      reasoningBlocks: true,
    });
  });

  it('returns false for providers without a confirmed structured-output wire', () => {
    stubWindow();
    // Gemini native serializers and ollama are unconfirmed or absent (Ollama
    // Cloud does not support structured outputs); demo has no wire. None of
    // these may attach a constraint regardless of catalog metadata.
    for (const provider of ['google', 'ollama', 'demo']) {
      expect(providerModelSupportsStructuredOutput(provider, 'any-model')).toBe(false);
    }
  });

  it('gates Anthropic structured outputs as native when supported and fallback otherwise', () => {
    stubWindow();
    expect(providerModelSupportsStructuredOutput('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(providerModelSupportsStructuredOutput('anthropic', 'claude-opus-4-8')).toBe(true);
    expect(resolvePushCapabilityProfile('anthropic', 'claude-sonnet-4-6')).toMatchObject({
      structuredOutput: 'strict',
    });
    expect(resolvePushCapabilityProfile('anthropic', 'claude-sonnet-4@20250514')).toMatchObject({
      structuredOutput: 'best-effort',
    });
    expect(providerModelSupportsStructuredOutput('anthropic', undefined)).toBe(false);
  });

  it('gates direct Gemini structured outputs (native responseSchema) on the catalog set', () => {
    stubWindow();
    // Gemini constrains generation natively via responseSchema; gated on the same
    // curated set as native tool calling so the two google gates stay consistent.
    expect(providerModelSupportsStructuredOutput('google', 'gemini-3.1-pro-preview')).toBe(true);
    expect(resolvePushCapabilityProfile('google', 'gemini-3.1-pro-preview')).toMatchObject({
      structuredOutput: 'strict',
    });
    // Same set as tool calling → no cross-column drift (the opus-4-8 failure mode).
    expect(resolvePushCapabilityProfile('google', 'gemini-3.1-pro-preview').toolCalling).toBe(
      'native',
    );
    // Off-catalog google id → none (and tool calling agrees).
    expect(providerModelSupportsStructuredOutput('google', 'gemini-not-a-real-model')).toBe(false);
  });

  it('gates Zen-Go Anthropic-transport models on the fallback bridge; OpenAI-transport stays capability-based', () => {
    stubWindow();
    // minimax/qwen route over the Anthropic Messages transport on Go, where the
    // forced-tool bridge applies regardless of models.dev metadata.
    expect(providerModelSupportsStructuredOutput('zen', 'minimax-m3')).toBe(true);
    expect(providerModelSupportsStructuredOutput('zen', 'qwen3.7-max')).toBe(true);
    expect(providerModelSupportsStructuredOutput('zen', 'minimax-m2.7')).toBe(true);
    expect(resolvePushCapabilityProfile('zen', 'minimax-m3')).toMatchObject({
      structuredOutput: 'best-effort',
    });
    // OpenAI-transport zen models fall through to the capability probe. Declared
    // opencode metadata now makes the known structured-output Big Pickle path
    // true, while Kimi K2.6 stays prompt-only.
    expect(providerModelSupportsStructuredOutput('zen', 'kimi-k2.6')).toBe(false);
    expect(providerModelSupportsStructuredOutput('zen', 'big-pickle')).toBe(true);
  });

  it('gates Cloudflare Workers AI by model name on a cold catalog cache (Kimi / GLM only)', () => {
    stubWindow();
    // With no cached binding catalog (fresh window → empty localStorage), the
    // gate falls back to the name heuristic. Kimi K2.x and GLM advertise
    // structured outputs on their model cards; every other Workers AI model
    // stays prompt-only until the catalog loads. Covers the `@cf/...` ids the
    // catalog returns.
    expect(
      providerModelSupportsStructuredOutput('cloudflare', '@cf/moonshotai/kimi-k2.7-code'),
    ).toBe(true);
    expect(providerModelSupportsStructuredOutput('cloudflare', '@cf/zai-org/glm-5.2')).toBe(true);
    expect(
      providerModelSupportsStructuredOutput('cloudflare', '@cf/qwen/qwen2.5-coder-32b-instruct'),
    ).toBe(false);
    expect(
      providerModelSupportsStructuredOutput(
        'cloudflare',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      ),
    ).toBe(false);
  });

  it('returns false when no modelId is given', () => {
    stubWindow();
    expect(providerModelSupportsStructuredOutput('openrouter', undefined)).toBe(false);
  });

  it('gates native tool calling for Cloudflare Kimi/GLM by name on a cold catalog cache', () => {
    stubWindow();
    expect(
      providerModelSupportsNativeToolCalling('cloudflare', '@cf/moonshotai/kimi-k2.7-code'),
    ).toBe(true);
    expect(providerModelSupportsNativeToolCalling('cloudflare', '@cf/zai-org/glm-5.2')).toBe(true);
    expect(
      providerModelSupportsNativeToolCalling('cloudflare', '@cf/qwen/qwen2.5-coder-32b-instruct'),
    ).toBe(false);
    expect(providerModelSupportsNativeToolCalling('cloudflare', undefined)).toBe(false);
  });

  it('drives Cloudflare gating from the cached binding catalog, overriding the name heuristic', async () => {
    // Reset modules so the catalog mem-cache starts cold, then seed it through
    // a real fetchCloudflareModels round-trip (the path the picker takes).
    vi.resetModules();
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          // A non-Kimi/GLM model the name heuristic alone would mark unsupported.
          { id: '@cf/qwen/qwen2.5-coder-32b-instruct', functionCalling: true },
          // A model the catalog explicitly says lacks function calling.
          { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', functionCalling: false },
        ]),
      ),
    );

    const mc = await import('./model-catalog');
    await mc.fetchCloudflareModels();

    // Catalog says qwen supports function calling → both gates flip true even
    // though the Kimi/GLM name heuristic would have returned false.
    expect(
      mc.providerModelSupportsNativeToolCalling(
        'cloudflare',
        '@cf/qwen/qwen2.5-coder-32b-instruct',
      ),
    ).toBe(true);
    expect(
      mc.providerModelSupportsStructuredOutput('cloudflare', '@cf/qwen/qwen2.5-coder-32b-instruct'),
    ).toBe(true);
    // Catalog says llama lacks it → stays text-dispatch / prompt-only.
    expect(
      mc.providerModelSupportsNativeToolCalling(
        'cloudflare',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      ),
    ).toBe(false);
    // A model absent from the (warm) catalog still falls back to the name
    // heuristic rather than defaulting off.
    expect(
      mc.providerModelSupportsNativeToolCalling('cloudflare', '@cf/moonshotai/kimi-k2.7-code'),
    ).toBe(true);
  });

  it('serves the Cloudflare catalog from cache and re-fetches only on force', async () => {
    vi.resetModules();
    stubWindow();
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ id: '@cf/qwen/qwen3-30b-a3b-fp8', functionCalling: true }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const mc = await import('./model-catalog');
    const first = await mc.fetchCloudflareModels();
    expect(first).toEqual(['@cf/qwen/qwen3-30b-a3b-fp8']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within the TTL serves from cache — no new network hit.
    const second = await mc.fetchCloudflareModels();
    expect(second).toEqual(['@cf/qwen/qwen3-30b-a3b-fp8']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The picker's manual refresh forces a revalidation.
    await mc.fetchCloudflareModels({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gates OpenRouter native tool calling on models.dev tool_call capability', async () => {
    // Reset modules so the per-provider metadata mem-cache starts clean (other
    // fetcher tests in this file seed cache keys; a warm cache short-circuits the
    // fetch and masks the newly-seeded metadata). Mirrors the structured-output
    // capability test below.
    vi.resetModules();
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('models.dev/api.json')) {
          return jsonResponse({
            openrouter: {
              models: {
                // Base ids only — models.dev keys by base, OpenRouter routes
                // `:nitro` / `:free` variants onto the same base model.
                'anthropic/claude-sonnet-4.6': {
                  id: 'anthropic/claude-sonnet-4.6',
                  reasoning: true,
                  tool_call: true,
                  structured_output: true,
                  modalities: { input: ['text'], output: ['text'] },
                  limit: { context: 400_000 },
                },
                'cohere/command-a': {
                  id: 'cohere/command-a',
                  reasoning: false,
                  tool_call: false,
                  structured_output: false,
                  modalities: { input: ['text'], output: ['text'] },
                  limit: { context: 256_000 },
                },
              },
            },
          });
        }
        // OpenRouter catalog endpoint — metadata is what we exercise here, so
        // the live catalog can be empty.
        return jsonResponse({ data: [] });
      }),
    );

    const mc = await import('./model-catalog');
    await mc.fetchOpenRouterModels();

    // Capable model passes — and the routing suffix resolves to the base id.
    expect(
      mc.providerModelSupportsNativeToolCalling('openrouter', 'anthropic/claude-sonnet-4.6'),
    ).toBe(true);
    expect(
      mc.providerModelSupportsNativeToolCalling('openrouter', 'anthropic/claude-sonnet-4.6:nitro'),
    ).toBe(true);
    // Model whose metadata reports no tool support stays text-dispatch.
    expect(mc.providerModelSupportsNativeToolCalling('openrouter', 'cohere/command-a')).toBe(false);
    // Unknown model (no cached metadata) resolves to false, not a crash.
    expect(mc.providerModelSupportsNativeToolCalling('openrouter', 'unknown/model:free')).toBe(
      false,
    );
    expect(mc.providerModelSupportsNativeToolCalling('openrouter', undefined)).toBe(false);
  });

  it('gates Zen native tool calling against the curated catalog allowlist', () => {
    stubWindow();
    // Standard-tier ids (including the proprietary big-pickle default that has
    // no models.dev metadata) pass via the name-based allowlist.
    expect(providerModelSupportsNativeToolCalling('zen', 'big-pickle')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('zen', 'claude-sonnet-4.6')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('zen', 'gpt-5.4')).toBe(true);
    // Go-tier-only ids are included too (they share the catalog union).
    expect(providerModelSupportsNativeToolCalling('zen', 'glm-5.2')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('zen', 'kimi-k2.7-code')).toBe(true);
    // Off-catalog / unknown ids stay text-dispatch.
    expect(providerModelSupportsNativeToolCalling('zen', 'made-up-model')).toBe(false);
    expect(providerModelSupportsNativeToolCalling('zen', undefined)).toBe(false);
  });

  it('denies Ollama native tool calling for denylisted ids on both surfaces', () => {
    stubWindow();
    // minimax-m3's declared metadata reports tool support, but the shared
    // denylist (ollama/ollama#16389 — stalls after the first tool result)
    // forces text-dispatch on the web gate…
    expect(providerModelSupportsNativeToolCalling('ollama', 'minimax-m3')).toBe(false);
    expect(providerModelSupportsNativeToolCalling('ollama', 'minimax-m3:cloud')).toBe(false);
    // …and keeps it off the CLI curated allowlist built from OLLAMA_MODELS.
    expect(cliProviderModelSupportsNativeToolCalling('ollama', 'minimax-m3')).toBe(false);
    // The retired id is also off the CLI allowlist (rides text-dispatch).
    expect(cliProviderModelSupportsNativeToolCalling('ollama', 'gemini-3-flash-preview')).toBe(
      false,
    );
  });

  it('gates Fireworks native tool calling against the curated catalog allowlist', () => {
    stubWindow();
    // Curated FIREWORKS_MODELS ids pass (the default + a couple of families).
    expect(
      providerModelSupportsNativeToolCalling(
        'fireworks',
        'accounts/fireworks/models/deepseek-v4-pro',
      ),
    ).toBe(true);
    expect(
      providerModelSupportsNativeToolCalling(
        'fireworks',
        'accounts/fireworks/models/kimi-k2p7-code',
      ),
    ).toBe(true);
    // Off-catalog Fireworks ids (e.g. a live-fetch model not in the curated list)
    // stay text-dispatch.
    expect(
      providerModelSupportsNativeToolCalling('fireworks', 'accounts/fireworks/models/not-curated'),
    ).toBe(false);
    expect(providerModelSupportsNativeToolCalling('fireworks', undefined)).toBe(false);
  });

  it('gates Google native tool calling against the curated Gemini catalog allowlist', () => {
    stubWindow();
    expect(providerModelSupportsNativeToolCalling('google', 'gemini-3.5-flash')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('google', 'gemini-3.1-pro-preview')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('google', 'not-a-gemini-model')).toBe(false);
    expect(providerModelSupportsNativeToolCalling('google', undefined)).toBe(false);
  });

  it('gates validated OpenAI-compatible adapters by catalog or OpenAI-family id', () => {
    stubWindow();
    expect(providerModelSupportsNativeToolCalling('openai', 'gpt-5.4')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('openai', 'gpt-4o')).toBe(true);

    expect(providerModelSupportsNativeToolCalling('kilocode', 'anthropic/claude-sonnet-4.6')).toBe(
      true,
    );
    expect(providerModelSupportsNativeToolCalling('kilocode', 'unknown/model')).toBe(false);
  });

  it('gates direct Anthropic native tool calling against the curated catalog allowlist', () => {
    stubWindow();
    expect(providerModelSupportsNativeToolCalling('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('anthropic', 'claude-opus-4-7')).toBe(true);
    expect(providerModelSupportsNativeToolCalling('anthropic', 'claude-custom-free-text')).toBe(
      false,
    );
    expect(providerModelSupportsNativeToolCalling('anthropic', undefined)).toBe(false);
  });

  it('web and CLI native-tool gates agree on every name-based provider (drift guard)', () => {
    stubWindow();
    // Name-based providers must decide identically across surfaces (single source
    // of truth via `lib/native-tool-gate` + `lib/provider-models`). Capability-based
    // providers (openrouter / ollama / nvidia) are intentionally
    // surface-specific — models.dev on web, curated fallback on CLI — and excluded.
    const nameBasedCases: Array<[string, string[]]> = [
      ['anthropic', ANTHROPIC_MODELS],
      ['fireworks', FIREWORKS_MODELS],
      ['google', GOOGLE_MODELS],
      ['kilocode', KILOCODE_MODELS],
      ['openai', [...OPENAI_MODELS, 'gpt-5-mini', 'gpt-4o', 'not-a-model']],
    ];
    const disagreements: string[] = [];
    for (const [provider, models] of nameBasedCases) {
      for (const model of models) {
        const web = providerModelSupportsNativeToolCalling(provider, model);
        const cli = cliProviderModelSupportsNativeToolCalling(provider, model);
        if (web !== cli) disagreements.push(`${provider}/${model}: web=${web} cli=${cli}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('returns false for an allowlisted provider when the catalog reports no support', () => {
    stubWindow();
    // `openai` is OpenAI-shaped (allowlisted) but has no models.dev structured-
    // output metadata cached here, so the catalog gate keeps it prompt-only.
    expect(providerModelSupportsStructuredOutput('openai', 'gpt-x')).toBe(false);
  });

  it('returns true for an allowlisted provider once the catalog advertises support', async () => {
    // Reset modules so the per-provider metadata mem-cache starts clean — earlier
    // nvidia fetcher tests in this file seed the same cache key, and the fetch
    // short-circuits on a warm cache, masking the newly-seeded metadata.
    vi.resetModules();
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('models.dev/api.json')) {
          return jsonResponse({
            nvidia: {
              models: {
                'meta/llama-3.3-70b-instruct': {
                  id: 'meta/llama-3.3-70b-instruct',
                  reasoning: false,
                  tool_call: true,
                  structured_output: true,
                  modalities: { input: ['text'], output: ['text'] },
                  limit: { context: 131_072 },
                },
              },
            },
          });
        }
        if (url.includes('/nvidia/') || url.includes('/api/nvidia/models')) {
          return jsonResponse({ data: [{ id: 'meta/llama-3.3-70b-instruct' }] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const mc = await import('./model-catalog');
    await mc.fetchNvidiaModels();
    expect(mc.providerModelSupportsStructuredOutput('nvidia', 'meta/llama-3.3-70b-instruct')).toBe(
      true,
    );
    expect(mc.providerModelSupportsNativeToolCalling('nvidia', 'meta/llama-3.3-70b-instruct')).toBe(
      true,
    );
  });

  it('does not treat a models.dev attachment flag as image vision', async () => {
    // models.dev sets `attachment: true` for models that accept file attachments
    // of any kind (often PDF/file, never image). Vision must key on the `image`
    // input modality, not the attachment flag — else a PDF-only model is wrongly
    // advertised as image-capable.
    vi.resetModules();
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('models.dev/api.json')) {
          return jsonResponse({
            nvidia: {
              models: {
                'mistral/pdf-only-model': {
                  id: 'mistral/pdf-only-model',
                  attachment: true,
                  reasoning: false,
                  tool_call: true,
                  structured_output: true,
                  modalities: { input: ['text', 'pdf'], output: ['text'] },
                  limit: { context: 131_072 },
                },
              },
            },
          });
        }
        if (url.includes('/nvidia/') || url.includes('/api/nvidia/models')) {
          return jsonResponse({ data: [{ id: 'mistral/pdf-only-model' }] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const mc = await import('./model-catalog');
    await mc.fetchNvidiaModels();
    expect(mc.getModelCapabilities('nvidia', 'mistral/pdf-only-model').vision).toBe(false);
  });
});
