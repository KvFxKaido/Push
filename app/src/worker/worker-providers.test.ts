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

  it('extracts the upstream error message from a structured 401 body', async () => {
    // Regression for the silent-debug-tax bug: OpenRouter 401s used to surface
    // as "OpenRouter API API error 401: {" because the proxy dumped the raw
    // JSON body via slice(0, 200). The user-facing message must now be the
    // actual upstream reason (e.g. "User not found.") so stale-key situations
    // self-diagnose instead of triggering a multi-hour detective session.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), {
            status: 401,
          }),
      ),
    );
    const response = await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('OpenRouter 401: User not found.');
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

describe('handleOpenRouterChat — Cloudflare AI Gateway', () => {
  // Asserts that the gateway is purely opt-in: when the env vars are unset,
  // every request flows direct to OpenRouter exactly as before. Account/slug
  // together flip routing; the token is independent and only attaches the
  // `cf-aig-authorization` header when actually routing through the gateway.
  function captureFetch(): { current: { url: string; headers: Record<string, string> } | null } {
    const captured: { current: { url: string; headers: Record<string, string> } | null } = {
      current: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured.current = { url, headers: init.headers as Record<string, string> };
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    return captured;
  }

  it('leaves the URL unchanged when gateway env is unset', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(makeChatRequest(), makeEnv({ OPENROUTER_API_KEY: 'sk-or' }));
    expect(captured.current?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured.current?.headers['cf-aig-authorization']).toBeUndefined();
  });

  it('rewrites the URL through the gateway when account + slug are set', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({
        OPENROUTER_API_KEY: 'sk-or',
        CF_AI_GATEWAY_ACCOUNT_ID: 'acc123',
        CF_AI_GATEWAY_SLUG: 'push-prod',
      }),
    );
    expect(captured.current?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/push-prod/openrouter/chat/completions',
    );
    // Provider auth still flows untouched — the gateway forwards it to OpenRouter.
    expect(captured.current?.headers.Authorization).toBe('Bearer sk-or');
  });

  it('attaches cf-aig-authorization when CF_AI_GATEWAY_TOKEN is set', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({
        OPENROUTER_API_KEY: 'sk-or',
        CF_AI_GATEWAY_ACCOUNT_ID: 'acc123',
        CF_AI_GATEWAY_SLUG: 'push-prod',
        CF_AI_GATEWAY_TOKEN: 'aig-secret',
      }),
    );
    expect(captured.current?.headers['cf-aig-authorization']).toBe('Bearer aig-secret');
    // Provider Authorization header still survives alongside the gateway token.
    expect(captured.current?.headers.Authorization).toBe('Bearer sk-or');
  });

  it('omits cf-aig-authorization when the token is unset', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({
        OPENROUTER_API_KEY: 'sk-or',
        CF_AI_GATEWAY_ACCOUNT_ID: 'acc123',
        CF_AI_GATEWAY_SLUG: 'push-prod',
      }),
    );
    expect(captured.current?.headers['cf-aig-authorization']).toBeUndefined();
  });

  it('does not leak cf-aig-authorization to the direct provider when the token is set without account/slug', async () => {
    // Defense-in-depth: if an operator sets the token but forgets the
    // account/slug, the request still flows direct — we must not attach the
    // gateway header to a direct-to-OpenRouter call.
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or', CF_AI_GATEWAY_TOKEN: 'aig-secret' }),
    );
    expect(captured.current?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured.current?.headers['cf-aig-authorization']).toBeUndefined();
  });
});

describe('handleCloudflareChat — Cloudflare AI Gateway', () => {
  it('passes the gateway id to env.AI.run when account + slug are set', async () => {
    const run = vi.fn(async () => new ReadableStream());
    await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({
        AI: { run } as unknown as Env['AI'],
        CF_AI_GATEWAY_ACCOUNT_ID: 'acc123',
        CF_AI_GATEWAY_SLUG: 'push-prod',
      }),
    );
    expect(run).toHaveBeenCalledWith(
      'test-model',
      { messages: [{ role: 'user', content: 'hello' }], stream: true },
      { gateway: { id: 'push-prod' } },
    );
  });

  it('omits the gateway option when env is unset (legacy 2-arg call shape preserved)', async () => {
    const run = vi.fn(async () => new ReadableStream());
    await handleCloudflareChat(makeChatRequest(), makeEnv({ AI: { run } as unknown as Env['AI'] }));
    // Two args, not three — guards against accidentally forcing the gateway
    // path on Workers without the env vars set.
    expect(run.mock.calls[0]).toHaveLength(2);
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

  it('translates both `reasoning` (Kimi K2.6) and `reasoning_content` (K2.5/DeepSeek-R1) delta fields into downstream reasoning_content SSE frames', async () => {
    // K2.6 broke the field name from `reasoning_content` → `reasoning` when
    // it shipped on Workers AI. Pre-fix, the worker silently dropped every
    // reasoning chunk from K2.6, which left the client stream receiving
    // keepalive bytes but no content for 90s+ and tripping the stall
    // detector despite the model working fine. Assert both shapes make it
    // through — mixing them in one stream also guards against a regression
    // where the `??` fallback gets re-reversed.
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            // New (K2.6) shape.
            'data: {"choices":[{"delta":{"reasoning":"thinking A…"}}]}\n' +
              // Old (K2.5 / DeepSeek-R1) shape.
              'data: {"choices":[{"delta":{"reasoning_content":"thinking B…"}}]}\n' +
              'data: {"choices":[{"delta":{"content":"final"}}]}\n' +
              'data: [DONE]\n',
          ),
        );
        c.close();
      },
    });

    const response = await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({ AI: { run: vi.fn(async () => upstream) } as unknown as Env['AI'] }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();

    // Downstream shape the web client reads (orchestrator.ts watches
    // `choice.delta.reasoning_content`). Both upstream reasoning frames
    // must surface through the same downstream field — that's what
    // lets `shouldResetStallOnReasoning` reset the stall clock for
    // either model generation.
    expect(body).toContain('"reasoning_content":"thinking A…"');
    expect(body).toContain('"reasoning_content":"thinking B…"');
    expect(body).toContain('"content":"final"');
    expect(body).toContain('data: [DONE]');
  });

  it('ignores non-string `reasoning` delta values (guards against upstream shape drift)', async () => {
    // If a future model version emits `reasoning` as an object/array (e.g.
    // a structured thought), don't accidentally stringify it through
    // `JSON.stringify`-ish coercion — silently skip and let the downstream
    // text channel carry the visible output. A crash here would error the
    // whole stream over a non-critical field.
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"reasoning":{"type":"structured","parts":[]}}}]}\n' +
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n' +
              'data: [DONE]\n',
          ),
        );
        c.close();
      },
    });

    const response = await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({ AI: { run: vi.fn(async () => upstream) } as unknown as Env['AI'] }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('reasoning_content');
    expect(body).toContain('"content":"ok"');
  });

  it('falls back to reasoning_content when `reasoning` is present but non-string in the same frame', async () => {
    // Mixed-shape frame: `reasoning` is a structured payload (future
    // shape or migration compat), `reasoning_content` is the usable
    // string. A naive `??` fallback would prefer the non-string and
    // drop the frame entirely — the client would then see no progress
    // and trip the 90s stall detector despite having valid reasoning
    // text in-stream. Guard: pick the first valid string field.
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"reasoning":{"type":"structured"},"reasoning_content":"usable text"}}]}\n' +
              'data: {"choices":[{"delta":{"content":"done"}}]}\n' +
              'data: [DONE]\n',
          ),
        );
        c.close();
      },
    });

    const response = await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({ AI: { run: vi.fn(async () => upstream) } as unknown as Env['AI'] }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"reasoning_content":"usable text"');
    expect(body).toContain('"content":"done"');
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
