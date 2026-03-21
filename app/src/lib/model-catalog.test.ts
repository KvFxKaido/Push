import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCuratedBlackboxModelList,
  buildCuratedNvidiaModelList,
  buildCuratedOllamaModelList,
  buildCuratedOpencodeModelList,
  buildCuratedOpenRouterModelList,
  fetchBlackboxModels,
  fetchKilocodeModels,
  fetchNvidiaModels,
  fetchOllamaModels,
  fetchZenModels,
  filterModelByContext,
  MIN_CONTEXT_TOKENS,
  parseOpenRouterCatalog,
} from './model-catalog';

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
        'gemini-3-flash-preview',
        'glm-5',
        'qwen3-coder:480b',
        'qwen3-vl:235b-instruct',
        'nomic-embed-text',
        'flux.1-dev',
      ],
      {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 1_000_000,
        },
        'glm-5': {
          id: 'glm-5',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 128_000,
        },
        'qwen3-coder:480b': {
          id: 'qwen3-coder:480b',
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

    expect(curated[0]).toBe('gemini-3-flash-preview');
    expect(curated).toContain('glm-5');
    expect(curated).toContain('qwen3-coder:480b');
    expect(curated).toContain('qwen3-vl:235b-instruct');
    expect(curated).not.toContain('nomic-embed-text');
    expect(curated).not.toContain('flux.1-dev');
  });

  it('allows non-priority models with missing context metadata via fail-open', () => {
    const curated = buildCuratedOllamaModelList(
      [
        'gemini-3-flash-preview',
        'some-new-model',
        'google/nanobanana-preview',
        'black-forest-labs/flux.1-dev',
      ],
      {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          attachment: true,
          reasoning: false,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 1_000_000,
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

    expect(curated).toContain('gemini-3-flash-preview');
    // contextLimit 0 is treated as "missing" → Ollama's fail-open allows it
    expect(curated).toContain('some-new-model');
    expect(curated).not.toContain('google/nanobanana-preview');
    expect(curated).not.toContain('black-forest-labs/flux.1-dev');
  });
});

describe('buildCuratedBlackboxModelList', () => {
  it('normalizes routed IDs, keeps viable chat models, and excludes image-only or embedding models', () => {
    const curated = buildCuratedBlackboxModelList(
      [
        'blackbox-pro',
        'blackboxai/anthropic/claude-sonnet-4.6',
        'blackboxai/qwen/qwen3-coder-32b-instruct',
        'blackboxai/openai/gpt-image-1',
        'blackboxai/nomic/nomic-embed-text',
      ],
      {
        'anthropic/claude-sonnet-4.6': {
          id: 'anthropic/claude-sonnet-4.6',
          attachment: true,
          reasoning: true,
          toolCall: true,
          structuredOutput: true,
          openWeights: false,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLimit: 200_000,
        },
        'openai/gpt-image-1': {
          id: 'openai/gpt-image-1',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: false,
          inputModalities: ['text'],
          outputModalities: ['image'],
          contextLimit: 128_000,
        },
        'nomic/nomic-embed-text': {
          id: 'nomic/nomic-embed-text',
          attachment: false,
          reasoning: false,
          toolCall: false,
          structuredOutput: false,
          openWeights: true,
          inputModalities: ['text'],
          outputModalities: ['embedding'],
          contextLimit: 8_192,
        },
      },
    );

    expect(curated).toEqual([
      'blackboxai/anthropic/claude-sonnet-4.6',
      'blackbox-pro',
      'blackboxai/qwen/qwen3-coder-32b-instruct',
    ]);
    expect(curated).toContain('blackboxai/anthropic/claude-sonnet-4.6');
    expect(curated).toContain('blackboxai/qwen/qwen3-coder-32b-instruct');
    expect(curated).not.toContain('blackboxai/openai/gpt-image-1');
    expect(curated).not.toContain('blackboxai/nomic/nomic-embed-text');
  });

  it('prefers routed provider aliases over duplicate legacy Blackbox aliases', () => {
    const curated = buildCuratedBlackboxModelList(
      [
        'claude-3-5-haiku-20241022',
        'claude-haiku-4-5-20251001',
        'blackboxai/anthropic/claude-3.5-haiku',
        'blackboxai/anthropic/claude-haiku-4.5',
        'blackbox-pro',
      ],
      {},
    );

    expect(curated).toEqual([
      'blackboxai/anthropic/claude-3.5-haiku',
      'blackboxai/anthropic/claude-haiku-4.5',
      'blackbox-pro',
    ]);
    expect(curated).not.toContain('claude-3-5-haiku-20241022');
    expect(curated).not.toContain('claude-haiku-4-5-20251001');
  });

  it('excludes explicitly tiny Blackbox models even without metadata', () => {
    const curated = buildCuratedBlackboxModelList(
      [
        'blackboxai/meta/llama-3.2-3b-instruct',
        'blackboxai/qwen/qwen2.5-coder-7b-instruct',
        'blackboxai/openai/gpt-5.4-nano',
        'blackboxai/qwen/qwen3-coder-32b-instruct',
      ],
      {},
    );

    expect(curated).toContain('blackboxai/qwen/qwen3-coder-32b-instruct');
    expect(curated).not.toContain('blackboxai/meta/llama-3.2-3b-instruct');
    expect(curated).not.toContain('blackboxai/qwen/qwen2.5-coder-7b-instruct');
    expect(curated).not.toContain('blackboxai/openai/gpt-5.4-nano');
  });

  it('excludes obvious image, video, and edit families from the Blackbox catalog', () => {
    const curated = buildCuratedBlackboxModelList(
      [
        'fast-animatediff',
        'fast-svd',
        'fast-svd-lcm',
        'gemini-flash-edit',
        'hunyuan-video-lora',
        'mochi-v1',
        'blackboxai/qwen/qwen3-coder-32b-instruct',
      ],
      {},
    );

    expect(curated).toEqual(['blackboxai/qwen/qwen3-coder-32b-instruct']);
    expect(curated).not.toContain('fast-animatediff');
    expect(curated).not.toContain('fast-svd');
    expect(curated).not.toContain('fast-svd-lcm');
    expect(curated).not.toContain('gemini-flash-edit');
    expect(curated).not.toContain('hunyuan-video-lora');
    expect(curated).not.toContain('mochi-v1');
  });

  it('does not truncate the Blackbox catalog after sorting', () => {
    const models = Array.from({ length: 60 }, (_, index) => `blackboxai/openai/gpt-5.${index}`);
    const curated = buildCuratedBlackboxModelList(models, {});

    expect(curated).toHaveLength(60);
    expect(curated[0]).toBe('blackboxai/openai/gpt-5.0');
    expect(curated.at(-1)).toBe('blackboxai/openai/gpt-5.59');
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
      providerMatcher: (url: string) => url.includes('/ollama/') || url.includes('/api/ollama/models'),
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
      providerMatcher: (url: string) => url.includes('/opencode/zen/') || url.includes('/api/zen/models'),
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
      providerMatcher: (url: string) => url.includes('/nvidia/') || url.includes('/api/nvidia/models'),
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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('models.dev/api.json')) {
        return jsonResponse(modelsDevPayload);
      }
      if (providerMatcher(url)) {
        return jsonResponse({ data: [{ id: 'tiny-context-model' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

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
    const {
      fetchNvidiaModels: fetchFreshNvidiaModels,
      MIN_CONTEXT_TOKENS: freshMinContextTokens,
    } = await import('./model-catalog');

    await expect(fetchFreshNvidiaModels()).resolves.toEqual([]);

    contextLimit = freshMinContextTokens;
    vi.setSystemTime(Date.now() + thirteenHoursMs);

    await expect(fetchFreshNvidiaModels()).resolves.toEqual(['fresh-context-model']);

    const modelsDevCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes('models.dev/api.json'));
    expect(modelsDevCalls).toHaveLength(2);
  });
});

describe('fetchBlackboxModels', () => {
  it('returns a curated Blackbox chat-model list', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('models.dev/api.json')) {
        return jsonResponse({
          anthropic: {
            models: {
              'anthropic/claude-sonnet-4.6': {
                id: 'anthropic/claude-sonnet-4.6',
                reasoning: true,
                tool_call: true,
                structured_output: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 200_000 },
              },
            },
          },
          openai: {
            models: {
              'openai/gpt-image-1': {
                id: 'openai/gpt-image-1',
                modalities: { input: ['text'], output: ['image'] },
                limit: { context: 128_000 },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: [
          { id: 'claude-3-5-haiku-20241022' },
          { id: 'blackbox-pro' },
          { id: 'blackboxai/anthropic/claude-3.5-haiku' },
          { id: 'blackboxai/anthropic/claude-sonnet-4.6' },
          { id: 'blackboxai/qwen/qwen3-coder-32b-instruct' },
          { id: 'blackboxai/meta/llama-3.2-3b-instruct' },
          { id: 'blackboxai/openai/gpt-image-1' },
          { id: 'fast-animatediff' },
        ],
      });
    }));

    await expect(fetchBlackboxModels()).resolves.toEqual([
      'blackboxai/anthropic/claude-3.5-haiku',
      'blackboxai/anthropic/claude-sonnet-4.6',
      'blackbox-pro',
      'blackboxai/qwen/qwen3-coder-32b-instruct',
    ]);
  });

  it('throws on non-OK response', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })));

    await expect(fetchBlackboxModels()).rejects.toThrow(/Blackbox AI model list failed \(401\)/);
  });

  it('throws on timeout', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      init?.signal?.throwIfAborted();
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    }));

    await expect(fetchBlackboxModels()).rejects.toThrow(/timed out/);
  });

  it('does not fall back to the raw provider list when every model is filtered out', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('models.dev/api.json')) {
        return jsonResponse({
          openai: {
            models: {
              'openai/gpt-image-1': {
                id: 'openai/gpt-image-1',
                modalities: { input: ['text'], output: ['image'] },
                limit: { context: 128_000 },
              },
            },
          },
        });
      }
      if (url.includes('/blackbox/')) {
        return jsonResponse({ data: [{ id: 'blackboxai/openai/gpt-image-1' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await expect(fetchBlackboxModels()).resolves.toEqual([]);
  });
});

describe('fetchKilocodeModels', () => {
  it('keeps only canonical model ids from the OpenAI-style Kilo catalog payload', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: [
        { id: 'google/gemini-3-flash-preview', name: 'Google: Gemini 3 Flash Preview' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6' },
        { name: 'OpenAI: GPT 5.2' },
      ],
    })));

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
