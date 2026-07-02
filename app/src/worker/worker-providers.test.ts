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
import { PROVIDER_DEFINITIONS } from '@push/lib/provider-definition';
import { GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER } from '@push/lib/gemini-thought-signature';
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
  handleGoogleSearch,
  handleOpenRouterChat,
  handleOpenRouterModels,
  handleVertexChat,
  handleZenChat,
  handleZenGoChat,
  parseGeminiGroundingResponse,
  translateVertexOpenApiBody,
  WORKER_PROVIDER_API_ROUTES,
  WORKER_PROVIDER_HANDLERS,
} from './worker-providers';
import type { Env } from './worker-middleware';

// Partial-mock the middleware so the Vertex native path is testable without a
// real Google service account / JWT signing: only `getGoogleAccessToken` is
// stubbed (it would otherwise sign a JWT and hit the OAuth token endpoint).
// Everything else — runPreamble, hasVertexNativeCredentials, getVertexNativeConfig
// — runs for real, so the service-account header decode + region validation are
// exercised end-to-end.
vi.mock('./worker-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-middleware')>();
  return { ...actual, getGoogleAccessToken: vi.fn(async () => 'fake-vertex-token') };
});

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

function makeOpenAIResponsesRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://push.example.test/api/openai/chat', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
      store: false,
      ...body,
    }),
  });
}

function makeOpenRouterResponsesRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://push.example.test/api/openrouter/chat', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-5.4',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
      store: false,
      ...body,
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

describe('WORKER_PROVIDER_API_ROUTES', () => {
  it('derives provider proxy routes from ProviderDefinition paths', () => {
    const expected = PROVIDER_DEFINITIONS.flatMap((def) => [
      { path: def.webProxyPath, method: 'POST' },
      { path: def.modelsProxyPath, method: 'GET' },
    ]);

    expect(WORKER_PROVIDER_API_ROUTES.map(({ path, method }) => ({ path, method }))).toEqual(
      expected,
    );
  });

  it('uses the handler registry for every generated provider route', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      const chatRoute = WORKER_PROVIDER_API_ROUTES.find(
        (route) => route.path === def.webProxyPath && route.method === 'POST',
      );
      const modelsRoute = WORKER_PROVIDER_API_ROUTES.find(
        (route) => route.path === def.modelsProxyPath && route.method === 'GET',
      );

      expect(chatRoute?.handler).toBe(WORKER_PROVIDER_HANDLERS[def.id].chat);
      expect(modelsRoute?.handler).toBe(WORKER_PROVIDER_HANDLERS[def.id].models);
    }
  });

  it('keeps model-dependent Zen Go routes out of the provider-default registry', () => {
    expect(WORKER_PROVIDER_API_ROUTES.some((route) => route.path.startsWith('/api/zen/go/'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// OpenRouter — chat (streaming) + models (JSON)
// ---------------------------------------------------------------------------

describe('handleOpenRouterChat', () => {
  it('posts Responses requests to openrouter.ai/api/v1/responses with OPENROUTER_API_KEY', async () => {
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
    await handleOpenRouterChat(
      makeOpenRouterResponsesRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(captured?.url).toBe('https://openrouter.ai/api/v1/responses');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or');
    expect(JSON.parse(captured?.init.body as string)).toMatchObject({
      model: 'openai/gpt-5.4',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
  });

  it('keeps legacy Chat Completions bodies on the legacy upstream', async () => {
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
    const body = JSON.parse(captured?.init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.input).toBeUndefined();
  });

  it('rejects a Responses body with 400 when the model is not in the Responses allowlist', async () => {
    // Regression for the OpenRouter `/v1/responses` beta: the client serializes
    // every OpenRouter request as a Responses body, but the proxy must not
    // forward to `/v1/responses` for models that don't support it. Without the
    // allowlist gate, every non-OpenAI 5.x / Claude 4.x / Gemini 2.5+/3.x model
    // would 4xx on `/v1/responses` and the user would see a useless upstream
    // error. With the gate, non-allowlisted models fall through to the legacy
    // chat-completions path, which rejects the Responses-shape body with 400
    // (the legacy validator requires a `messages` array). The client should
    // resend a Chat Completions body for these models.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenRouterChat(
      makeOpenRouterResponsesRequest({ model: 'meta-llama/llama-4-maverick' }),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/non-empty "messages" array/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a Responses body with 400 when no model is set', async () => {
    // No model at all is treated like "not in the allowlist" — conservative
    // fallback to a known-good endpoint rather than guessing. The legacy
    // chat-completions validator rejects the request first on the missing
    // model (the `messages` check only runs once a model is present).
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenRouterChat(
      makeOpenRouterResponsesRequest({ model: undefined }),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/missing "model"/i);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    await handleOpenRouterChat(
      makeOpenRouterResponsesRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(captured['HTTP-Referer']).toBe('https://push.example.test');
    expect(captured['X-Title']).toBe('Push');
  });

  it('returns 401 when OPENROUTER_API_KEY is not configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenRouterChat(makeOpenRouterResponsesRequest(), makeEnv());
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
      makeOpenRouterResponsesRequest(),
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
      makeOpenRouterResponsesRequest(),
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
      makeOpenRouterResponsesRequest(),
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
      makeOpenRouterResponsesRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toMatch(/OpenRouter request timed out/i);
  });
});

// ---------------------------------------------------------------------------
// OpenCode Zen — standard + Go tiers share the native providers' 429 tagging
// ---------------------------------------------------------------------------

describe('handleZenChat', () => {
  it('extracts the upstream error message from a structured 401 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }),
      ),
    );
    const response = await handleZenChat(makeChatRequest(), makeEnv({ ZEN_API_KEY: 'zen-key' }));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('OpenCode Zen 401: Invalid key');
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
    const response = await handleZenChat(makeChatRequest(), makeEnv({ ZEN_API_KEY: 'zen-key' }));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('UPSTREAM_QUOTA_OR_RATE_LIMIT');
  });
});

describe('handleZenGoChat', () => {
  function makeZenGoRequest(model: string): Request {
    return new Request('https://push.example.test/api/zen/go/chat', {
      method: 'POST',
      headers: {
        Origin: 'https://push.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
    });
  }

  it('tags a 429 from the Anthropic-transport (minimax) path with UPSTREAM_QUOTA_OR_RATE_LIMIT', async () => {
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
    const response = await handleZenGoChat(
      makeZenGoRequest('minimax-m3'),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('UPSTREAM_QUOTA_OR_RATE_LIMIT');
  });

  it('leaves non-429 errors unclassified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream broke', { status: 500 })),
    );
    const response = await handleZenGoChat(
      makeZenGoRequest('minimax-m3'),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBeUndefined();
  });

  it('re-attaches the model on the legacy Anthropic-transport body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    await handleZenGoChat(makeZenGoRequest('minimax-m3'), makeEnv({ ZEN_API_KEY: 'zen-key' }));
    expect(captured?.url).toBe('https://opencode.ai/zen/go/v1/messages');
    // buildAnthropicMessagesRequest omits `model`; the handler must re-attach it
    // so the shared /v1/messages URL can dispatch to the right model.
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('minimax-m3');
  });

  it('proxies the legacy Anthropic-transport upstream SSE raw (background path)', async () => {
    // The legacy (OpenAI-shape body) caller is the background coder / PR-review
    // job, whose stream adapter now parses Anthropic SSE natively too — so the
    // Worker proxies the upstream raw on this contract kind as well.
    const anthropicFrame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(anthropicFrame, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    );
    const response = await handleZenGoChat(
      makeZenGoRequest('minimax-m3'),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"content_block_delta"');
    expect(text).not.toContain('"choices"');
  });
});

describe('handleZenGoChat — neutral wire (dual-accept)', () => {
  function makeNeutralRequest(payload: Record<string, unknown>): Request {
    return new Request('https://push.example.test/api/zen/go/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'push.stream.v1', ...payload }),
    });
  }

  function captureUpstream() {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    return () => captured;
  }

  it('routes an Anthropic-transport model through toAnthropicMessages WITH the body model', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const captured = get();
    expect(captured?.url).toBe('https://opencode.ai/zen/go/v1/messages');
    const body = JSON.parse(captured!.init.body as string);
    // Zen-Go's /v1/messages is a single fixed URL shared by every
    // Anthropic-transport model, so the model id must ride in the body or
    // upstream can't dispatch it (mirrors the native Anthropic handler).
    expect(body.model).toBe('minimax-m3');
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('translates neutral tools to Anthropic custom-tool shape on the Anthropic transport', async () => {
    const get = captureUpstream();
    const tool = {
      name: 'sandbox_read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    };
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [{ role: 'user', content: 'read it' }],
        tools: [tool],
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    // Flat Anthropic custom-tool shape — the seam that makes native FC work for
    // the minimax/qwen Anthropic-transport Go models.
    expect(body.tools).toEqual([
      {
        name: 'sandbox_read_file',
        description: 'Read a file',
        input_schema: tool.input_schema,
      },
    ]);
  });

  it('turns a neutral responseFormat into the forced structured-output fallback on non-Claude Anthropic transport', async () => {
    const get = captureUpstream();
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [{ role: 'user', content: 'audit' }],
        responseFormat: { name: 'auditor_verdict', schema },
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([
      {
        name: '__push_structured_output__',
        description: expect.any(String),
        input_schema: schema,
        strict: true,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: '__push_structured_output__' });
  });

  it('routes an OpenAI-transport model through toOpenAIChat (model in body, /chat/completions)', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const captured = get();
    expect(captured?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('glm-5.1');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.stream).toBe(true);
    // Usage accounting: the neutral path must still request the trailing usage
    // chunk the legacy validator used to default (parity with pre-flip behavior).
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('forwards neutral tools + responseFormat onto the OpenAI-transport upstream body', async () => {
    const get = captureUpstream();
    const tool = {
      name: 'sandbox_write_file',
      description: 'Write a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    };
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool],
        responseFormat: { name: 'verdict', schema: { type: 'object' } },
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    // toOpenAIChat re-serializes the neutral request: flat tools downcast to the
    // OpenAI-nested wire shape, plus tool_choice + response_format.
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'sandbox_write_file',
          description: 'Write a file',
          parameters: tool.input_schema,
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } },
    });
  });

  // Locks the per-route wiring `geminiThoughtSignatureFallback: isGeminiModelId(model)`
  // at the worker boundary (the serializer logic itself is covered in
  // openai-chat-serializer.test.ts). Zen-Go's live catalog has no Gemini model
  // today, but the gate is uniform across every OpenAI-transport call site, so a
  // gemini id flips it on and backfills the placeholder on a signatureless replay.
  function toolReplayMessages() {
    return [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: '',
        contentBlocks: [
          { type: 'tool_use', id: 'toolu_1', name: 'sandbox_read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: '',
        contentBlocks: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'data' }],
      },
    ];
  }

  function assistantToolCall(body: { messages: Array<Record<string, unknown>> }) {
    const assistant = body.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    ) as { tool_calls: Array<Record<string, unknown>> } | undefined;
    return assistant?.tool_calls[0];
  }

  it('backfills the Gemini thought_signature placeholder for a Gemini OpenAI-transport model', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({ model: 'gemini-3-pro', messages: toolReplayMessages() }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const call = assistantToolCall(JSON.parse(get()!.init.body as string));
    expect(call).toMatchObject({
      function: { name: 'sandbox_read_file' },
      thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
      extra_content: {
        google: { thought_signature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER },
      },
    });
  });

  it('leaves a signatureless tool call bare for a non-Gemini OpenAI-transport model', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({ model: 'glm-5.1', messages: toolReplayMessages() }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const call = assistantToolCall(JSON.parse(get()!.init.body as string));
    expect(call).toMatchObject({ function: { name: 'sandbox_read_file' } });
    expect(call).not.toHaveProperty('thoughtSignature');
    expect(call).not.toHaveProperty('extra_content');
  });

  it('enables the native web_search tool from the neutral anthropicWebSearch flag', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [{ role: 'user', content: 'hi' }],
        anthropicWebSearch: true,
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  it('clamps neutral maxTokens to the route ceiling (12288)', async () => {
    const get = captureUpstream();
    await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 999_999,
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.max_tokens).toBe(12_288);
  });

  it('returns 400 (not 502) when a neutral content part has an unrepresentable image URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleZenGoChat(
      makeNeutralRequest({
        model: 'minimax-m3',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'ftp://nope/x.png' } }],
          },
        ],
      }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('400s an unknown contract value instead of silently downgrading to legacy', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/zen/go/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract: 'push.stream.v2',
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const response = await handleZenGoChat(req, makeEnv({ ZEN_API_KEY: 'zen-key' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('proxies the Anthropic-transport upstream SSE raw (no OpenAI-SSE translation)', async () => {
    // The neutral-wire (foreground zenStream) client now parses Anthropic SSE
    // natively, so the Worker must pass the upstream body through untouched. The
    // retired path would have rewritten this into an OpenAI `choices` chunk.
    const anthropicFrame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(anthropicFrame, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    );
    const response = await handleZenGoChat(
      makeNeutralRequest({ model: 'minimax-m3', messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv({ ZEN_API_KEY: 'zen-key' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"content_block_delta"');
    expect(text).not.toContain('"choices"');
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
    await handleOpenRouterChat(
      makeOpenRouterResponsesRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or' }),
    );
    expect(captured.current?.url).toBe('https://openrouter.ai/api/v1/responses');
    expect(captured.current?.headers['cf-aig-authorization']).toBeUndefined();
  });

  it('rewrites the URL through the gateway when account + slug are set', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeOpenRouterResponsesRequest(),
      makeEnv({
        OPENROUTER_API_KEY: 'sk-or',
        CF_AI_GATEWAY_ACCOUNT_ID: 'acc123',
        CF_AI_GATEWAY_SLUG: 'push-prod',
      }),
    );
    expect(captured.current?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/push-prod/openrouter/responses',
    );
    // Provider auth still flows untouched — the gateway forwards it to OpenRouter.
    expect(captured.current?.headers.Authorization).toBe('Bearer sk-or');
  });

  it('attaches cf-aig-authorization when CF_AI_GATEWAY_TOKEN is set', async () => {
    const captured = captureFetch();
    await handleOpenRouterChat(
      makeOpenRouterResponsesRequest(),
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
      makeOpenRouterResponsesRequest(),
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
      makeOpenRouterResponsesRequest(),
      makeEnv({ OPENROUTER_API_KEY: 'sk-or', CF_AI_GATEWAY_TOKEN: 'aig-secret' }),
    );
    expect(captured.current?.url).toBe('https://openrouter.ai/api/v1/responses');
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

  it('forwards an OpenAI-shaped response_format from the body into env.AI.run input', async () => {
    const run = vi.fn(async () => new ReadableStream());
    const request = new Request('https://push.example.test/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } },
        },
      }),
    });
    await handleCloudflareChat(request, makeEnv({ AI: { run } as unknown as Env['AI'] }));
    const input = (run.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(input.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } },
    });
  });

  it('does not set response_format on env.AI.run input when the body omits it', async () => {
    const run = vi.fn(async () => new ReadableStream());
    await handleCloudflareChat(makeChatRequest(), makeEnv({ AI: { run } as unknown as Env['AI'] }));
    const input = (run.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(input.response_format).toBeUndefined();
  });

  it('forwards a well-formed tools array into env.AI.run input with tool_choice auto', async () => {
    const run = vi.fn(async () => new ReadableStream());
    const tools = [
      {
        type: 'function',
        function: {
          name: 'exec',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
    ];
    const request = new Request('https://push.example.test/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools,
      }),
    });
    await handleCloudflareChat(request, makeEnv({ AI: { run } as unknown as Env['AI'] }));
    const input = (run.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(input.tools).toEqual(tools);
    expect(input.tool_choice).toBe('auto');
  });

  it('forwards a native tool_call from env.AI.run to the client as OpenAI tool_calls', async () => {
    // P1 regression guard: Workers AI emits OpenAI `delta.tool_calls` when the
    // model uses native function calling. The Worker must accumulate + flush
    // them as OpenAI tool_calls so the browser pump can emit native_tool_call —
    // otherwise the native call is dropped inside the Worker and the turn
    // reaches the Coder empty.
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"exec"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"npm test\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      'data: [DONE]',
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(encoder.encode(`${f}\n`));
        c.close();
      },
    });
    const run = vi.fn(async () => upstream);
    const response = await handleCloudflareChat(
      makeChatRequest(),
      makeEnv({ AI: { run } as unknown as Env['AI'] }),
    );
    const body = await new Response(response.body).text();
    // The structured tool call is re-serialized into client `tool_calls` frames.
    expect(body).toContain('exec');
    expect(body).toContain('npm test');
    expect(body).toContain('tool_calls');
    expect(body).not.toContain('```json');
  });

  it('drops a malformed tools payload rather than forwarding it', async () => {
    const run = vi.fn(async () => new ReadableStream());
    const request = new Request('https://push.example.test/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function' }, { nope: true }],
      }),
    });
    await handleCloudflareChat(request, makeEnv({ AI: { run } as unknown as Env['AI'] }));
    const input = (run.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(input.tools).toBeUndefined();
    expect(input.tool_choice).toBeUndefined();
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
  it('returns text-generation models as { id, functionCalling } from the AI binding', async () => {
    // The CF catalog uses `id` as an internal UUID and `name` as the
    // `@cf/...` string env.AI.run() expects. We must surface `name`, not
    // `id`, otherwise clients end up with UUIDs in the model picker — and we
    // project the `function_calling` property into a capability flag so the
    // client gate doesn't have to name-match Kimi/GLM. Non-text-generation
    // models (Whisper) are filtered out.
    const models = vi.fn(async () => [
      {
        id: 'cc80437b-9a8d-4f1a-9c77-9aaf0d226922',
        name: '@cf/qwen/qwen3-30b-a3b-fp8',
        description: '',
        source: 1,
        task: { id: 'text-generation', name: 'Text Generation', description: '' },
        tags: [],
        properties: [{ property_id: 'function_calling', value: 'true' }],
      },
      {
        id: 'e1d2c3b4-0000-4000-8000-000000000000',
        name: '@cf/meta/llama-3.1-8b-instruct',
        description: '',
        source: 1,
        task: { id: 'text-generation', name: 'Text Generation', description: '' },
        tags: [],
        properties: [{ property_id: 'context_window', value: '8192' }],
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
    expect(await response.json()).toEqual([
      { id: '@cf/meta/llama-3.1-8b-instruct', functionCalling: false },
      { id: '@cf/qwen/qwen3-30b-a3b-fp8', functionCalling: true },
    ]);
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
  it('posts to api.openai.com/v1/responses with OPENAI_API_KEY', async () => {
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
    await handleOpenAIChat(makeOpenAIResponsesRequest(), makeEnv({ OPENAI_API_KEY: 'sk-server' }));
    expect(captured?.url).toBe('https://api.openai.com/v1/responses');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-server');
    expect(JSON.parse(captured?.init.body as string)).toMatchObject({
      model: 'test-model',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
  });

  it('returns 401 when OPENAI_API_KEY is not configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenAIChat(makeOpenAIResponsesRequest(), makeEnv());
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
      makeOpenAIResponsesRequest(),
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
      makeOpenAIResponsesRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-server' }),
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('UPSTREAM_QUOTA_OR_RATE_LIMIT');
  });

  it('forces streaming/stateless Responses requests and clamps max_output_tokens', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    await handleOpenAIChat(
      makeOpenAIResponsesRequest({ stream: false, store: true, max_output_tokens: 99_999 }),
      makeEnv({ OPENAI_API_KEY: 'sk-server' }),
    );
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.store).toBe(false);
    expect(capturedBody?.max_output_tokens).toBe(12_288);
  });
});

describe('handleOpenAIModels', () => {
  it('GETs https://api.openai.com/v1/models with the server key and filters to chat-capable ids', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        // A sampling of the categories OpenAI's /v1/models actually returns:
        // chat models (gpt-4o, o3-mini), embeddings, TTS, Whisper, image,
        // moderation, and the legacy davinci-002 completion model. The chat
        // dropdown only wants the first two.
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'gpt-4o' },
              { id: 'o3-mini' },
              { id: 'chatgpt-4o-latest' },
              // Chat-capable search-preview variants. Regression coverage
              // for a false positive Copilot caught: an unanchored
              // /-search-/ pattern would drop these even though they route
              // through /v1/chat/completions like every other chat model.
              { id: 'gpt-4o-search-preview' },
              { id: 'gpt-4o-mini-search-preview' },
              { id: 'text-embedding-3-large' },
              { id: 'text-embedding-ada-002' },
              { id: 'tts-1' },
              { id: 'tts-1-hd' },
              { id: 'whisper-1' },
              { id: 'dall-e-3' },
              { id: 'gpt-image-1' },
              { id: 'omni-moderation-latest' },
              { id: 'text-moderation-stable' },
              { id: 'davinci-002' },
              { id: 'babbage-002' },
              { id: 'text-davinci-003' },
              // Legacy text-search embeddings family — still excluded, but
              // via the new anchored ^text-search- pattern.
              { id: 'text-search-ada-doc-001' },
              { id: 'text-search-curie-query-001' },
              // Legacy completions-only instruct models. Regression
              // coverage for a Codex finding: these would otherwise reach
              // the dropdown, be selected by a user, and then 4xx at chat
              // time because they don't accept /v1/chat/completions.
              { id: 'gpt-3.5-turbo-instruct' },
              { id: 'gpt-3.5-turbo-instruct-0914' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const response = await handleOpenAIModels(
      makeModelsRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-server' }),
    );
    expect(captured?.url).toBe('https://api.openai.com/v1/models');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-server');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<{ id: string; name: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual([
      'gpt-4o',
      'o3-mini',
      'chatgpt-4o-latest',
      'gpt-4o-search-preview',
      'gpt-4o-mini-search-preview',
    ]);
    // Each surviving entry duplicates `id` into `name` — matches the curated
    // handler shape that the dropdown already consumes.
    expect(body.data.every((m) => m.name === m.id)).toBe(true);
  });

  it('falls back to the curated OPENAI_MODELS list when no key is configured (no upstream fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleOpenAIModels(makeModelsRequest(), makeEnv());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
  });

  it('falls back to the curated list on upstream 401 (bad key) instead of bubbling the error', async () => {
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
    const response = await handleOpenAIModels(
      makeModelsRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-bad' }),
    );
    // Curated fallback is a 200 — pins the contract that the dropdown stays
    // populated when the user's saved key has been rotated/revoked.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('falls back to the curated list when filtering empties the upstream result (shape drift defense)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            // Only non-chat entries — would otherwise yield an empty dropdown.
            JSON.stringify({
              object: 'list',
              data: [{ id: 'text-embedding-3-small' }, { id: 'tts-1' }, { id: 'whisper-1' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const response = await handleOpenAIModels(
      makeModelsRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-good' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    // Confirm this IS the curated list, not the filtered (empty) upstream.
    expect(body.data.some((m) => /^gpt-/.test(m.id))).toBe(true);
  });

  it('falls back to the curated list when upstream fetch throws a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const response = await handleOpenAIModels(
      makeModelsRequest(),
      makeEnv({ OPENAI_API_KEY: 'sk-good' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
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
  it('GETs generativelanguage.googleapis.com/v1beta/models with x-goog-api-key, filters by supportedGenerationMethods, strips `models/` prefix', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        // Sample of what /v1beta/models actually returns: chat-capable
        // (generateContent), embeddings (embedContent), and streaming-only
        // entries (streamGenerateContent without generateContent — rare,
        // generally excluded). Each carries a `models/` prefix.
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
              },
              {
                name: 'models/gemini-3-flash-preview',
                supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
              },
              {
                name: 'models/text-embedding-004',
                supportedGenerationMethods: ['embedContent'],
              },
              {
                name: 'models/aqa',
                supportedGenerationMethods: ['generateAnswer'],
              },
              // Missing capability array — drop it as malformed.
              { name: 'models/gemini-malformed' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const response = await handleGoogleModels(
      makeModelsRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza-server' }),
    );
    expect(captured?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    );
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-server');
    // No Authorization header — Gemini uses x-goog-api-key exclusively, and
    // smuggling a Bearer through would confuse the upstream auth path.
    expect(headers.Authorization).toBeUndefined();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<{ id: string; name: string }>;
    };
    expect(body.object).toBe('list');
    // Only the two generateContent-capable entries survive, and the
    // `models/` prefix is stripped from each id.
    expect(body.data.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-3-flash-preview']);
    expect(body.data.every((m) => m.name === m.id)).toBe(true);
    expect(body.data.every((m) => !m.id.startsWith('models/'))).toBe(true);
  });

  it('falls back to the curated GOOGLE_MODELS list when no key is configured (no upstream fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleGoogleModels(makeModelsRequest(), makeEnv());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
  });

  it('falls back to the curated list on upstream 400 (bad key) instead of bubbling the error', async () => {
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
    const response = await handleGoogleModels(
      makeModelsRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza-bad' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('falls back to the curated list when no upstream entry advertises generateContent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: 'models/text-embedding-004',
                  supportedGenerationMethods: ['embedContent'],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const response = await handleGoogleModels(
      makeModelsRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza-good' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.some((m) => /^gemini-/.test(m.id))).toBe(true);
  });

  it('falls back to the curated list when upstream fetch throws a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const response = await handleGoogleModels(
      makeModelsRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza-good' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Google grounded search — one-shot generateContent + googleSearch tool
// ---------------------------------------------------------------------------

function makeGroundedSearchRequest(query = 'gemini 3 release'): Request {
  return new Request('https://push.example.test/api/google/search', {
    method: 'POST',
    headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

describe('translateVertexOpenApiBody', () => {
  it('returns body unchanged when google_search_grounding is not set', () => {
    const bodyText = JSON.stringify({ model: 'gemini-2.5-pro', messages: [] });
    expect(translateVertexOpenApiBody({}, bodyText)).toBe(bodyText);
  });

  it('strips google_search_grounding and injects tools: [{ googleSearch: {} }] when set', () => {
    // Vertex's OpenAI-compat layer doesn't auto-translate the OpenAI
    // `web_search` tool shape, so the bridge has to inject Gemini's
    // native tool shape directly. Verify the upstream body it produces.
    const bodyText = JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'who won euro 2024' }],
      google_search_grounding: true,
    });
    const out = translateVertexOpenApiBody({ google_search_grounding: true }, bodyText);
    const parsed = JSON.parse(out);
    expect(parsed.tools).toEqual([{ googleSearch: {} }]);
    expect(parsed.google_search_grounding).toBeUndefined();
    expect(parsed.model).toBe('gemini-2.5-pro');
  });

  it('drops grounding when function tools are present, and dedupes the googleSearch entry', () => {
    // Function tools + googleSearch is unsupported on Gemini 2.5 — function
    // calling wins, grounding is dropped (no second tool appended).
    const bodyText = JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [],
      tools: [{ type: 'function', function: { name: 'calc' } }],
      google_search_grounding: true,
    });
    const parsed = JSON.parse(
      translateVertexOpenApiBody({ google_search_grounding: true }, bodyText),
    );
    expect(parsed.tools).toEqual([{ type: 'function', function: { name: 'calc' } }]);
    expect(parsed.tools).not.toContainEqual({ googleSearch: {} });

    // If the request already carried googleSearch we don't duplicate it.
    const bodyTextAlreadyHasIt = JSON.stringify({
      tools: [{ googleSearch: {} }],
      google_search_grounding: true,
    });
    const parsed2 = JSON.parse(
      translateVertexOpenApiBody({ google_search_grounding: true }, bodyTextAlreadyHasIt),
    );
    expect(parsed2.tools).toEqual([{ googleSearch: {} }]);
  });

  it('treats non-boolean google_search_grounding as falsy (string "true" does NOT enable)', () => {
    const bodyText = JSON.stringify({ google_search_grounding: 'true' });
    // Strict `=== true` posture mirrors the Anthropic / Gemini bridges so
    // malformed input can't accidentally enable grounding.
    expect(
      translateVertexOpenApiBody(
        { google_search_grounding: 'true' as unknown as boolean },
        bodyText,
      ),
    ).toBe(bodyText);
  });
});

describe('handleVertexChat — neutral wire (dual-accept)', () => {
  // base64 of a minimal valid Google service account. private_key is a dummy
  // string — getGoogleAccessToken is mocked, so JWT signing never runs.
  const SERVICE_ACCOUNT_HEADER = btoa(
    JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'svc@test-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\ndummy\n-----END PRIVATE KEY-----\n',
    }),
  );

  function makeNeutralRequest(payload: Record<string, unknown>, legacy = false): Request {
    return new Request('https://push.example.test/api/vertex/chat', {
      method: 'POST',
      headers: {
        Origin: 'https://push.example.test',
        'Content-Type': 'application/json',
        'X-Push-Vertex-Service-Account': SERVICE_ACCOUNT_HEADER,
        'X-Push-Vertex-Region': 'us-east5',
      },
      body: JSON.stringify(legacy ? payload : { contract: 'push.stream.v1', ...payload }),
    });
  }

  function captureUpstream() {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    return () => captured;
  }

  const readFileTool = {
    name: 'sandbox_read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative path' } },
      required: ['path'],
      additionalProperties: false,
    },
  };

  it('routes a claude model through toAnthropicMessages with NO body model (model in URL)', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
      }),
      makeEnv(),
    );
    const captured = get();
    expect(captured?.url).toContain(
      '/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict',
    );
    const body = JSON.parse(captured!.init.body as string);
    // Vertex carries the model in the URL path — emitModel:false.
    expect(body).not.toHaveProperty('model');
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('proxies the Vertex-Claude upstream SSE raw (no OpenAI-SSE translation)', async () => {
    // vertexStream now parses Anthropic SSE natively, so the Worker must pass the
    // raw upstream through untouched — the retired path rewrote it to OpenAI SSE.
    const anthropicFrame =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(anthropicFrame, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    );
    const response = await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"content_block_delta"');
    expect(text).not.toContain('"choices"');
  });

  it('routes a non-claude model through toOpenAIChat (model in body, openapi endpoint)', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      makeEnv(),
    );
    const captured = get();
    expect(captured?.url).toContain('/endpoints/openapi/chat/completions');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('gemini-2.5-pro');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(true);
  });

  it('forwards neutral tools to the OpenAPI branch with tool_choice auto', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'read it' }],
        tools: [readFileTool],
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    // OpenAPI branch goes through toOpenAIChat → flat canonical downcast to nested.
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'sandbox_read_file',
          description: 'Read a file',
          parameters: readFileTool.input_schema,
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('drops googleSearch when native function tools are present (combo unsupported on Gemini 2.5)', async () => {
    // Gemini rejects function tools + googleSearch together on 2.5 models, so the
    // Vertex OpenAPI branch must not combine them — function calling wins.
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'read and search' }],
        tools: [readFileTool],
        googleSearchGrounding: true,
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    // OpenAPI branch goes through toOpenAIChat → flat canonical downcast to nested.
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'sandbox_read_file',
          description: 'Read a file',
          parameters: readFileTool.input_schema,
        },
      },
    ]);
    expect(body.tools).not.toContainEqual({ googleSearch: {} });
    expect(body.tool_choice).toBe('auto');
  });

  it('injects the googleSearch tool on the openapi branch from neutral googleSearchGrounding', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'who won' }],
        googleSearchGrounding: true,
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it('translates neutral tools to Anthropic custom-tool shape on the Claude branch', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'read it' }],
        tools: [readFileTool],
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([
      {
        name: 'sandbox_read_file',
        description: 'Read a file',
        input_schema: readFileTool.input_schema,
      },
    ]);
  });

  it('enables the native web_search tool on the anthropic branch from anthropicWebSearch', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        anthropicWebSearch: true,
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  it('forwards neutral replayAssistantTurns on the Claude branch (pause-turn resume)', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'search the web' }],
        replayAssistantTurns: [
          [
            { type: 'text', text: 'Searching' },
            { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
          ],
        ],
      }),
      makeEnv(),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'search the web' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching' },
          { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
        ],
      },
    ]);
  });

  it('returns 400 (not 502) when a neutral content part has an unrepresentable image URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleVertexChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'ftp://nope/x.png' } }],
          },
        ],
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('legacy (no contract) claude body still serializes via buildAnthropicMessagesRequest', async () => {
    const get = captureUpstream();
    await handleVertexChat(
      makeNeutralRequest(
        { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
        true,
      ),
      makeEnv(),
    );
    const captured = get();
    expect(captured?.url).toContain('/publishers/anthropic/models/claude-sonnet-4-6');
    const body = JSON.parse(captured!.init.body as string);
    // Legacy parity: model still carried out-of-band, anthropic_version present.
    expect(body).not.toHaveProperty('model');
    expect(body.anthropic_version).toBe('vertex-2023-10-16');
  });
});

describe('parseGeminiGroundingResponse', () => {
  it('pulls answer text + cited web sources out of a Gemini :generateContent payload', () => {
    const { answer, results } = parseGeminiGroundingResponse({
      candidates: [
        {
          content: { parts: [{ text: 'Gemini 3 was announced ' }, { text: 'on May 1, 2026.' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://blog.google/gemini-3', title: 'Google Blog' } },
              { web: { uri: 'https://techcrunch.com/gemini-3', title: 'TechCrunch' } },
              { web: { uri: '' } }, // empty uri — must be filtered
              { somethingElse: {} }, // non-web chunk — must be filtered
            ],
          },
        },
      ],
    });
    expect(answer).toBe('Gemini 3 was announced on May 1, 2026.');
    expect(results).toEqual([
      { title: 'Google Blog', url: 'https://blog.google/gemini-3', content: '' },
      { title: 'TechCrunch', url: 'https://techcrunch.com/gemini-3', content: '' },
    ]);
  });

  it('falls back to the URI as title when the chunk omits a title', () => {
    const { results } = parseGeminiGroundingResponse({
      candidates: [
        {
          content: { parts: [] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }] },
        },
      ],
    });
    expect(results[0].title).toBe('https://example.com');
  });

  it('returns empty answer + results on malformed shapes', () => {
    expect(parseGeminiGroundingResponse(null)).toEqual({ answer: '', results: [] });
    expect(parseGeminiGroundingResponse({})).toEqual({ answer: '', results: [] });
    expect(parseGeminiGroundingResponse({ candidates: [] })).toEqual({ answer: '', results: [] });
  });

  it('skips chunks with non-string title (no throw) and falls back to the URI', () => {
    const { results } = parseGeminiGroundingResponse({
      candidates: [
        {
          content: { parts: [] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com', title: 123 as unknown as string } },
            ],
          },
        },
      ],
    });
    expect(results).toEqual([
      { title: 'https://example.com', url: 'https://example.com', content: '' },
    ]);
  });

  it('rejects non-http(s) URIs (javascript:, data:, ftp:)', () => {
    const { results } = parseGeminiGroundingResponse({
      candidates: [
        {
          content: { parts: [] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'javascript:alert(1)', title: 'XSS' } },
              { web: { uri: 'data:text/html,<script>', title: 'Data' } },
              { web: { uri: 'ftp://example.com', title: 'FTP' } },
              { web: { uri: 'not a url at all', title: 'Bad' } },
              { web: { uri: 'https://safe.example/', title: 'Safe' } },
            ],
          },
        },
      ],
    });
    expect(results).toEqual([{ title: 'Safe', url: 'https://safe.example/', content: '' }]);
  });
});

describe('handleGoogleSearch', () => {
  it('posts a one-shot :generateContent with the googleSearch tool enabled', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'answer' }] },
                groundingMetadata: {
                  groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const response = await handleGoogleSearch(
      makeGroundedSearchRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );

    expect(captured?.url).toMatch(
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash:generateContent$/,
    );
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza');
    const body = JSON.parse(String(captured?.init.body));
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'gemini 3 release' }] }]);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { answer: string; results: Array<{ url: string }> };
    expect(json.answer).toBe('answer');
    expect(json.results).toEqual([{ title: 'Example', url: 'https://example.com', content: '' }]);
  });

  it('honors PUSH_GOOGLE_GROUNDING_MODEL to override the search model', async () => {
    let captured: { url: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        captured = { url };
        return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      }),
    );
    await handleGoogleSearch(
      makeGroundedSearchRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza', PUSH_GOOGLE_GROUNDING_MODEL: 'gemini-3.1-pro-preview' }),
    );
    expect(captured?.url).toMatch(/\/models\/gemini-3\.1-pro-preview:generateContent$/);
  });

  it('returns 400 when the body is missing the query field', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/google/search', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await handleGoogleSearch(req, makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for a whitespace-only query and skips the upstream call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/google/search', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '   \t\n  ' }),
    });
    const response = await handleGoogleSearch(req, makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Empty/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when no key is configured and the client supplies no Authorization', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleGoogleSearch(makeGroundedSearchRequest(), makeEnv());
    expect(response.status).toBe(401);
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
    const response = await handleGoogleSearch(
      makeGroundedSearchRequest(),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/^Google 400/);
  });
});

describe('handleAnthropicChat — neutral wire (dual-accept)', () => {
  function makeNeutralRequest(payload: Record<string, unknown>): Request {
    return new Request('https://push.example.test/api/anthropic/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'push.stream.v1', ...payload }),
    });
  }

  function captureUpstream() {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    return () => captured;
  }

  it('routes a push.stream.v1 body through toAnthropicMessages (system hoist + block content)', async () => {
    const get = captureUpstream();
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const captured = get();
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages');
    expect((captured?.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
    // Translation markers: system hoisted to a top-level field, string content
    // wrapped into Anthropic `[{ type: 'text' }]` blocks.
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('carries multimodal image content on the neutral path', async () => {
    const get = captureUpstream();
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('translates neutral tools to Anthropic custom-tool shape on the direct Anthropic path', async () => {
    const get = captureUpstream();
    const tool = {
      name: 'sandbox_read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    };
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'read it' }],
        tools: [tool],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([
      {
        name: 'sandbox_read_file',
        description: 'Read a file',
        input_schema: tool.input_schema,
      },
    ]);
  });

  it('serializes neutral responseFormat as native output_config on supported Claude models', async () => {
    const get = captureUpstream();
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'audit' }],
        responseFormat: { name: 'auditor_verdict', schema },
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema },
    });
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('clamps neutral maxTokens to the route ceiling (12288)', async () => {
    const get = captureUpstream();
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 999_999,
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.max_tokens).toBe(12_288);
  });

  it('preserves an array-content system prompt (web cacheable shape) onto the upstream system field', async () => {
    // End-to-end regression guard for the client flip: the cacheable web
    // materializer sends the system prompt as a content-part array; the validator
    // lands it on contentParts with content:'' and toAnthropicMessages must read
    // contentParts for system, else the entire system prompt is dropped upstream.
    const get = captureUpstream();
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: 'hi' },
        ],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    // System prompt + its cache_control survive (array `system` shape).
    expect(body.system).toEqual([
      { type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('appends neutral replayAssistantTurns as trailing assistant turns (pause-turn resume)', async () => {
    const get = captureUpstream();
    await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'search the web' }],
        replayAssistantTurns: [
          [
            { type: 'text', text: 'Searching' },
            { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
          ],
        ],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    // The user turn, then the paused assistant content[] verbatim as the trailing
    // assistant turn the upstream resumes from.
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'search the web' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching' },
          { type: 'server_tool_use', id: 'su_01', name: 'web_search', input: {} },
        ],
      },
    ]);
  });

  it('returns 400 (not 502) when a neutral content part has an unrepresentable image URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleAnthropicChat(
      makeNeutralRequest({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'ftp://nope/x.png' } }],
          },
        ],
      }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toMatch(/unsupported or malformed content part/);
  });

  it('returns the validator 400 for a malformed neutral body without calling upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleAnthropicChat(
      makeNeutralRequest({ model: '', messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('400s an unknown contract value instead of silently downgrading to legacy', async () => {
    // A `contract` other than push.stream.v1 (typo, or a future v2) is neutral
    // INTENT — it must hit the wire validator's unrecognized-contract 400, not
    // be routed to the legacy OpenAI-shape path (which would drop neutral fields).
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/anthropic/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract: 'push.stream.v2',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const response = await handleAnthropicChat(req, makeEnv({ ANTHROPIC_API_KEY: 'sk-ant' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toMatch(/unrecognized contract/);
  });
});

describe('handleGoogleChat — neutral wire (dual-accept)', () => {
  function makeNeutralGoogleRequest(payload: Record<string, unknown>): Request {
    return new Request('https://push.example.test/api/google/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'push.stream.v1', ...payload }),
    });
  }

  function captureUpstream() {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    return () => captured;
  }

  it('routes a push.stream.v1 body through toGeminiGenerateContent (model in URL, neutral body)', async () => {
    const get = captureUpstream();
    await handleGoogleChat(
      // The neutral wire carries no systemPromptOverride (materialization is
      // client-side); the system arrives as a materialized system-role message.
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
        ],
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const captured = get();
    expect(captured?.url).toContain('/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    expect((captured?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza');
    const body = JSON.parse(captured!.init.body as string);
    // Gemini wire markers: system hoisted, user/model rename, no OpenAI leak.
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be concise.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello' }] },
    ]);
    expect('model' in body).toBe(false);
    expect('messages' in body).toBe(false);
  });

  it('serializes neutral responseFormat as native generationConfig.responseSchema', async () => {
    const get = captureUpstream();
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.1-pro-preview',
        messages: [{ role: 'user', content: 'audit' }],
        responseFormat: { name: 'verdict', schema },
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    // Converted to Gemini's uppercase OpenAPI subset; no tools, no tool_choice.
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.generationConfig.responseSchema.properties.verdict.type).toBe('STRING');
    expect(body).not.toHaveProperty('tools');
  });

  it('preserves an array-content system prompt onto systemInstruction (defensive)', async () => {
    // google isn't cacheable so its web system message is a plain string today,
    // but if array-content system ever reaches the neutral path the validator
    // lands it on contentParts with content:''. Guard that toGeminiGenerateContent
    // reads contentParts for system, else the prompt is silently dropped.
    const get = captureUpstream();
    await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] },
          { role: 'user', content: 'Hi' },
        ],
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be concise.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  it('enables the googleSearch tool from the neutral googleSearchGrounding flag', async () => {
    const get = captureUpstream();
    await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        googleSearchGrounding: true,
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it('translates neutral tools to Gemini functionDeclarations', async () => {
    const get = captureUpstream();
    await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'read it' }],
        tools: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file',
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string', description: 'Repo-relative path' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'sandbox_read_file',
            description: 'Read a file',
            parameters: {
              type: 'OBJECT',
              properties: {
                path: { type: 'STRING', description: 'Repo-relative path' },
              },
              required: ['path'],
            },
          },
        ],
      },
    ]);
  });

  it('carries multimodal image content as inline_data and clamps maxTokens', async () => {
    const get = captureUpstream();
    await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        maxTokens: 999_999,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    const body = JSON.parse(get()!.init.body as string);
    expect(body.contents[0].parts).toEqual([
      { text: 'see' },
      { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    expect(body.generationConfig.maxOutputTokens).toBe(12_288);
  });

  it('400s a neutral content part with a non-data image URL (loud failure)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await handleGoogleChat(
      makeNeutralGoogleRequest({
        model: 'gemini-3.5-flash',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/c.png' } }] },
        ],
      }),
      makeEnv({ GOOGLE_API_KEY: 'AIza' }),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await response.json()).error).toMatch(/cannot represent image/);
  });

  it('400s an unknown contract without calling upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req = new Request('https://push.example.test/api/google/chat', {
      method: 'POST',
      headers: { Origin: 'https://push.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract: 'push.stream.v2',
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const response = await handleGoogleChat(req, makeEnv({ GOOGLE_API_KEY: 'AIza' }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});