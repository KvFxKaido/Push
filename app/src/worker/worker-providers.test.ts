/**
 * Smoke tests for concrete provider adapters.
 *
 * The streaming/JSON proxy factories are exercised in detail in
 * worker-middleware.test.ts. These tests verify that a handful of
 * representative adapters are *wired* correctly: that they hit the right
 * upstream URL, attach the expected provider-specific headers, and map
 * the correct `env` key to `Authorization`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCloudflareChat,
  handleCloudflareModels,
  handleOllamaChat,
  handleOllamaModels,
  handleOpenRouterChat,
  handleOpenRouterModels,
} from './worker-providers';
import type { Env } from './worker-middleware';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ...overrides,
  };
}

function makeChatRequest(): Request {
  return new Request('https://push.example.test/api/chat', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
}

function makeModelsRequest(): Request {
  return new Request('https://push.example.test/api/models', {
    method: 'GET',
    headers: { Origin: 'https://push.example.test' },
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// OpenRouter — chat (streaming) + models (JSON)
// ---------------------------------------------------------------------------

describe('handleOpenRouterChat', () => {
  it('posts to openrouter.ai/api/v1/chat/completions with OPENROUTER_API_KEY', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    await handleOpenRouterChat(makeChatRequest(), makeEnv({ OPENROUTER_API_KEY: 'sk-or' }));
    expect(captured?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or');
  });

  it('attaches OpenRouter-specific HTTP-Referer and X-Title headers', async () => {
    let captured: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init.headers as Record<string, string>;
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    await handleOpenRouterChat(makeChatRequest(), makeEnv({ OPENROUTER_API_KEY: 'sk-or' }));
    expect(captured['HTTP-Referer']).toBe('https://push.example.test');
    expect(captured['X-Title']).toBe('Push');
  });

  it('returns 401 when OPENROUTER_API_KEY is not configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenRouterChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/OpenRouter API key not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates an upstream 500 as a JSON error with the same status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream broke', { status: 500 })),
    );
    const response = await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(/OpenRouter.*500/);
    expect(body.error).toContain('upstream broke');
  });

  it('returns 504 with the provider timeout message when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const response = await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toMatch(/OpenRouter request timed out/i);
  });
});

describe('handleOpenRouterModels', () => {
  it('GETs openrouter.ai/api/v1/models with no body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('{"data":[]}', { status: 200 });
      }),
    );
    await handleOpenRouterModels(makeModelsRequest(), makeEnv({ OPENROUTER_API_KEY: 'sk' }));
    expect(captured?.url).toBe('https://openrouter.ai/api/v1/models');
    expect(captured?.init.method).toBe('GET');
    expect(captured?.init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Workers AI — chat (native binding) + models
// ---------------------------------------------------------------------------

describe('handleCloudflareChat', () => {
  it('runs the requested model through the AI binding with scoped messages', async () => {
    const run = vi.fn(async () => new ReadableStream());
    const response = await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({
        AI: {
          run,
        } as unknown as Env['AI'],
      }),
    );

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith('test-model', {
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('returns 401 when the Worker has no AI binding configured', async () => {
    const response = await handleCloudflareChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Cloudflare Workers AI is not configured/i);
  });
});

describe('handleCloudflareModels', () => {
  it('returns only text-generation model names (the env.AI.run-compatible id) from the AI binding', async () => {
    // The CF catalog uses `id` as an internal UUID and `name` as the
    // `@cf/...` string env.AI.run() expects. We must surface `name`, not
    // `id`, otherwise clients end up with UUIDs in the model picker.
    const models = vi.fn(async () => [
      {
        id: 'cc80437b-9a8d-4f1a-9c77-9aaf0d226922',
        name: '@cf/qwen/qwen3-30b-a3b-fp8',
        description: '',
        source: 1,
        task: { id: 'text-generation', name: 'Text Generation', description: '' },
        tags: [],
        properties: [],
      },
      {
        id: 'ad01ab83-baf8-4e7b-8fed-a0a219d4eb45',
        name: '@cf/openai/whisper',
        description: '',
        source: 1,
        task: {
          id: 'automatic-speech-recognition',
          name: 'Automatic Speech Recognition',
          description: '',
        },
        tags: [],
        properties: [],
      },
    ]);
    const response = await handleCloudflareModels(
      makeModelsRequest(),
      makeEnv({
        AI: {
          models,
        } as unknown as Env['AI'],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(['@cf/qwen/qwen3-30b-a3b-fp8']);
  });

  it('returns 401 when the Worker has no AI binding configured', async () => {
    const response = await handleCloudflareModels(makeModelsRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Cloudflare Workers AI is not configured/i);
  });
});

// ---------------------------------------------------------------------------
// Ollama Cloud — chat (streaming) + models (JSON)
// ---------------------------------------------------------------------------

describe('handleOllamaChat', () => {
  it('posts to ollama.com/v1/chat/completions with OLLAMA_API_KEY', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    await handleOllamaChat(makeChatRequest(), makeEnv({ OLLAMA_API_KEY: 'sk-ol' }));
    expect(captured?.url).toBe('https://ollama.com/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-ol');
    // Ollama does not inject any provider-specific extra headers.
    expect(headers['HTTP-Referer']).toBeUndefined();
  });

  it('surfaces the Ollama-specific key-missing message', async () => {
    const response = await handleOllamaChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Ollama Cloud API key not configured/i);
  });

  it('surfaces the Ollama-specific timeout message on abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const response = await handleOllamaChat(
      makeChatRequest(),
      makeEnv({ OLLAMA_API_KEY: 'sk-ol' }),
    );
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toMatch(/Ollama Cloud request timed out/i);
  });
});

describe('handleOllamaModels', () => {
  it('GETs ollama.com/v1/models with the OLLAMA_API_KEY bearer', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('{"data":[]}', { status: 200 });
      }),
    );
    await handleOllamaModels(makeModelsRequest(), makeEnv({ OLLAMA_API_KEY: 'sk-ol' }));
    expect(captured?.url).toBe('https://ollama.com/v1/models');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-ol');
  });
});
