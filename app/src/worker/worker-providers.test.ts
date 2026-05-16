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
  handleAnthropicChat,
  handleAnthropicModels,
  handleCloudflareChat,
  handleCloudflareModels,
  handleOllamaChat,
  handleOllamaModels,
  handleOpenAIChat,
  handleOpenAIModels,
  handleGoogleChat,
  handleGoogleModels,
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

  it('does not leak HTML when upstream returns a CF/AI-Gateway 5xx page', async () => {
    // Regression for the gap Codex flagged on the structured-error fix:
    // `formatUpstreamError` short-circuits the proxy's default HTML guard,
    // so without the helper an AI Gateway / Cloudflare 503 challenge page
    // would surface as `OpenRouter 503: <!doctype html>...`.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html><body>503 Service Unavailable</body></html>', {
            status: 503,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    const response = await handleOpenRouterChat(
      makeChatRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/^OpenRouter 503: HTTP 503 \(/);
    expect(body.error).not.toMatch(/<\s*html/i);
    expect(body.error).not.toMatch(/<!doctype/i);
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

// ---------------------------------------------------------------------------
// Anthropic direct — bridge body translation + x-api-key auth
// ---------------------------------------------------------------------------

describe('handleAnthropicChat', () => {
  it('posts to api.anthropic.com/v1/messages with x-api-key + anthropic-version', async () => {
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
    await handleAnthropicChat(makeChatRequest(), makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }));
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured?.init.headers as Record<string, string>;
    // Direct Anthropic uses x-api-key, NOT Authorization: Bearer.
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('strips a client-side Bearer prefix when ANTHROPIC_API_KEY is not set on the Worker', async () => {
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
    const req = new Request('https://push.example.test/api/anthropic/chat', {
      method: 'POST',
      headers: {
        Origin: 'https://push.example.test',
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-ant-client',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    await handleAnthropicChat(req, makeEnv());
    expect(captured['x-api-key']).toBe('sk-ant-client');
  });

  it('includes the model field in the upstream JSON body', async () => {
    // buildAnthropicMessagesRequest omits `model` (Vertex carries it in the
    // URL), so handleAnthropicChat must re-attach it. This test pins that
    // contract so a future refactor of the bridge can't silently regress it.
    let captured: { init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { init };
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    await handleAnthropicChat(makeChatRequest(), makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }));
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('test-model');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('returns 401 when no Anthropic key is available from any source', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleAnthropicChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Anthropic API key not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body has no model id', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/anthropic/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const response = await handleAnthropicChat(req, makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats upstream errors with an Anthropic ${status} prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const response = await handleAnthropicChat(
      makeChatRequest(),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/^Anthropic 401:/);
  });
});

describe('handleAnthropicModels', () => {
  it('returns the curated ANTHROPIC_MODELS list (no upstream fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleAnthropicModels(makeModelsRequest(), makeEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => typeof m.id === 'string')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// OpenAI direct — chat (streaming) + models (JSON)
// ---------------------------------------------------------------------------

describe('handleOpenAIChat', () => {
  it('posts to api.openai.com/v1/chat/completions with OPENAI_API_KEY', async () => {
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
    await handleOpenAIChat(makeChatRequest(), makeEnv({ OPENAI_API_KEY: 'sk-server' }));
    expect(captured?.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-server');
  });

  it('returns 401 when OPENAI_API_KEY is not configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenAIChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/OpenAI API key not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats upstream errors with an OpenAI ${status} prefix and extracts the upstream reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const response = await handleOpenAIChat(
      makeChatRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-server' }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('OpenAI 401: Invalid API key');
  });

  it('tags rate-limit responses with UPSTREAM_QUOTA_OR_RATE_LIMIT for the client to detect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const response = await handleOpenAIChat(
      makeChatRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-server' }),
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('UPSTREAM_QUOTA_OR_RATE_LIMIT');
  });
});

describe('handleOpenAIModels', () => {
  it('proxies GET https://api.openai.com/v1/models with the server key', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    await handleOpenAIModels(makeModelsRequest(), makeEnv({ OPENAI_API_KEY: 'sk-server' }));
    expect(captured?.url).toBe('https://api.openai.com/v1/models');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-server');
  });
});

// ---------------------------------------------------------------------------
// Google Gemini direct — chat (streaming) + models (curated list)
// ---------------------------------------------------------------------------

describe('handleGoogleChat', () => {
  it('posts to generativelanguage.googleapis.com :streamGenerateContent with x-goog-api-key', async () => {
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
    await handleGoogleChat(makeChatRequest(), makeEnv({ GOOGLE_API_KEY: 'AIza-server' }));
    // Gemini puts the model in the URL path and selects SSE framing via
    // `?alt=sse` — both must round-trip exactly.
    expect(captured?.url).toMatch(
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/test-model:streamGenerateContent\?alt=sse$/,
    );
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-server');
    // The OpenAI bridge format that arrives in `body` must be translated into
    // Gemini's `contents[]` + `systemInstruction` shape upstream.
    const body = JSON.parse(String(captured?.init.body));
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(body).not.toHaveProperty('messages');
  });

  it('returns 401 when GOOGLE_API_KEY is not configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleGoogleChat(makeChatRequest(), makeEnv());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/Google Gemini API key not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when the request omits a model id', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/google/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      // No `model` field — guardrails should pass the body through, then the
      // handler enforces a non-empty model id before constructing the URL.
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = await handleGoogleChat(req, makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats upstream errors with a Google ${status} prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const response = await handleGoogleChat(makeChatRequest(), makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Google 400: API key not valid');
  });

  it('tags rate-limit responses with UPSTREAM_QUOTA_OR_RATE_LIMIT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const response = await handleGoogleChat(makeChatRequest(), makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('UPSTREAM_QUOTA_OR_RATE_LIMIT');
  });
});

describe('handleGoogleModels', () => {
  it('returns the curated GOOGLE_MODELS list (no upstream fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleGoogleModels(makeModelsRequest(), makeEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => typeof m.id === 'string')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
