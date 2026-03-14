import { describe, expect, it } from 'vitest';
import {
  buildCuratedNvidiaModelList,
  buildCuratedOllamaModelList,
  buildCuratedOpencodeModelList,
  buildCuratedOpenRouterModelList,
  parseOpenRouterCatalog,
} from './model-catalog';

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
          id: 'anthropic/claude-sonnet-4.6:nitro',
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
          id: 'google/gemini-3.1-pro-preview:nitro',
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

    const curated = buildCuratedOpenRouterModelList(models, {
      'openai/gpt-5.4': {
        id: 'openai/gpt-5.4',
        reasoning: true,
        toolCall: true,
        structuredOutput: true,
        openWeights: false,
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
        contextLimit: 1_050_000,
      },
    });

    expect(curated[0]).toBe('anthropic/claude-sonnet-4.6:nitro');
    expect(curated).toContain('openai/gpt-5.4');
    expect(curated).toContain('google/gemini-3.1-pro-preview:nitro');
    expect(curated).not.toContain('openai/gpt-image-1');
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
});

describe('buildCuratedOpencodeModelList', () => {
  it('prefers priority chat models and excludes image-output or embedding models', () => {
    const curated = buildCuratedOpencodeModelList(
      [
        'gpt-5.3-codex',
        'claude-sonnet-4-6',
        'gemini-3.1-pro',
        'qwen3-coder',
        'text-embedding-3-large',
        'gpt-image-1',
      ],
      {
        'gpt-5.3-codex': {
          id: 'gpt-5.3-codex',
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

    expect(curated[0]).toBe('gpt-5.3-codex');
    expect(curated).toContain('claude-sonnet-4-6');
    expect(curated).toContain('gemini-3.1-pro');
    expect(curated).toContain('qwen3-coder');
    expect(curated).not.toContain('text-embedding-3-large');
    expect(curated).not.toContain('gpt-image-1');
  });
});
