import type { Env } from './worker-middleware';
import type { AiModelsSearchObject } from '@cloudflare/workers-types';
import {
  createStreamProxyHandler,
  createJsonProxyHandler,
  standardAuth,
  passthroughAuth,
  buildVertexPreambleAuth,
  runPreamble,
  wlog,
  hasVertexNativeCredentials,
  getVertexNativeConfig,
  getExperimentalUpstreamUrl,
  getGoogleAccessToken,
} from './worker-middleware';
import { REQUEST_ID_HEADER } from '../lib/request-id';
import { validateAndNormalizeChatRequest } from '../lib/chat-request-guardrails';
import {
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from '@push/lib/openai-anthropic-bridge';
import { getZenGoTransport, ZEN_GO_MODELS } from '../lib/zen-go';
import { ANTHROPIC_MODELS, GOOGLE_MODELS, OPENAI_MODELS } from '@push/lib/provider-models';
import {
  buildGeminiGenerateContentRequest,
  createGeminiTranslatedStream,
} from '@push/lib/openai-gemini-bridge';
import {
  buildVertexAnthropicEndpoint,
  buildVertexOpenApiBaseUrl,
  getVertexModelTransport,
  VERTEX_MODEL_OPTIONS,
} from '../lib/vertex-provider';
import {
  extractProviderHttpErrorDetail,
  formatExperimentalProviderHttpError,
  formatVertexProviderHttpError,
} from '../lib/provider-error-utils';
import type { ExperimentalProviderType } from '../lib/experimental-providers';

// Gateway Abstraction imports
import type { LlmMessage, PushStreamRequest, PushStreamEvent } from '@push/lib/provider-contract';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
// --- Cloudflare Workers AI ---

const CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR =
  'Cloudflare Workers AI is not configured on this Worker. Add an `ai` binding in `wrangler.jsonc` and redeploy.';

function isCloudflareTextGenerationModel(model: AiModelsSearchObject): boolean {
  const taskId = model.task?.id?.toLowerCase() ?? '';
  const taskName = model.task?.name?.toLowerCase() ?? '';
  return taskId.includes('text-generation') || taskName.includes('text generation');
}

// Cloudflare Workers AI PushStream implementation.
// NOTE: SSE parsing here is deliberately minimal to match the chunk shape that
// env.AI.run emits (single-line `data: {json}` frames terminated by `\n`). If
// more providers need SSE parsing, extract a shared pump rather than copying
// this one.
async function* cloudflareStream(req: PushStreamRequest, env: Env): AsyncIterable<PushStreamEvent> {
  const input: Record<string, unknown> = {
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };

  if (req.maxTokens !== undefined) input.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) input.temperature = req.temperature;
  if (req.topP !== undefined) input.top_p = req.topP;

  // Workers AI binding routes through AI Gateway natively when given a
  // `gateway.id`. The binding handles auth via account context — no
  // cf-aig-authorization header required for the binding path. We omit the
  // third argument entirely when the gateway is unconfigured so callers/tests
  // observing `run`'s call shape see the legacy 2-arg form.
  const account = env.CF_AI_GATEWAY_ACCOUNT_ID?.trim();
  const slug = env.CF_AI_GATEWAY_SLUG?.trim();
  const runner = env.AI as unknown as {
    run: (
      model: string,
      input: Record<string, unknown>,
      options?: { gateway?: { id: string } },
    ) => Promise<ReadableStream<Uint8Array> | unknown>;
  };
  const stream = (
    account && slug
      ? await runner.run(req.model, input, { gateway: { id: slug } })
      : await runner.run(req.model, input)
  ) as ReadableStream<Uint8Array> | unknown;

  if (!(stream instanceof ReadableStream)) {
    throw new Error('Cloudflare AI did not return a stream');
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Propagate abort to the upstream reader so a client disconnect stops
  // Workers AI from pulling further inference.
  const onAbort = () => {
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  req.signal?.addEventListener('abort', onAbort, { once: true });

  function* flushLine(line: string): Generator<PushStreamEvent> {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      // Reasoning-model field layout varies by model/version:
      //   - DeepSeek-R1 and Kimi K2.5: native `reasoning_content` on delta.
      //   - Kimi K2.6: renamed to plain `reasoning` (breaking change
      //     introduced when K2.6 shipped on Workers AI).
      //   - Qwen QwQ: no native channel; emits `<think>…</think>` tags
      //     inline in `content`, split downstream by `normalizeReasoning`.
      // Accept either native field so a model-version bump doesn't
      // silently drop reasoning tokens — without this the client-side
      // stall detector sees "data arriving but no content" and trips the
      // 90s timer despite the model working fine (K2.6 can spend multiple
      // minutes thinking before its first visible token).
      // Select the first *valid non-empty string* — not `??`, which
      // would prefer a non-string `reasoning` (e.g. a future structured
      // payload) over a sibling string `reasoning_content` in the same
      // frame and drop the usable one. `normalizeReasoning` downstream
      // latches on the first native reasoning_delta and stops parsing
      // `<think>` tags for the rest of the stream, so a hybrid model
      // that emits both won't double-report.
      const reasoning =
        typeof delta?.reasoning === 'string' && delta.reasoning.length > 0
          ? delta.reasoning
          : typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
            ? delta.reasoning_content
            : undefined;
      if (reasoning) {
        yield { type: 'reasoning_delta', text: reasoning };
      }
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }
    } catch {
      /* skip malformed JSON */
    }
  }

  try {
    while (true) {
      if (req.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && trimmed.slice(6).trim() === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        yield* flushLine(line);
      }
    }

    // Flush any remaining buffered lines (stream ended without a [DONE] frame).
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        yield* flushLine(line);
      }
    }
    yield { type: 'done', finishReason: 'stop' };
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}

// Normalize incoming chat roles to the LlmMessage envelope. `developer` is
// OpenAI's recent rename of `system`, so collapse it. `tool` messages don't
// have a direct LlmMessage analogue (Push uses text-embedded tool calls, not
// native), so surface them as `user` content so the model still sees them.
function normalizeLlmRole(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'assistant' || role === 'system') return role;
  if (role === 'developer') return 'system';
  return 'user';
}

export async function handleCloudflareChat(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: (runtimeEnv) => (runtimeEnv.AI ? 'WorkersAIBinding' : null),
    keyMissingError: CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR,
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { bodyText, requestId, spanCtx } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'Cloudflare Workers AI',
    // Push-side ceiling — Cloudflare/upstream enforce their own per-model caps
    // on top. 64K gives Kimi K2.6 room for full-file rewrites and long reviews
    // without Push being the bottleneck on a 262K-context model.
    maxOutputTokens: 65_536,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/cloudflare/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }

  const parsedRequest = normalizedRequest.value.parsed as Record<string, unknown>;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';
  const messages = parsedRequest.messages;
  if (!model) {
    return Response.json({ error: 'Cloudflare Workers AI model is required.' }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: 'Cloudflare Workers AI messages are required.' },
      { status: 400 },
    );
  }

  wlog('info', 'request', {
    requestId,
    route: 'api/cloudflare/chat',
    bytes: normalizedRequest.value.bodyText.length,
    model,
  });

  try {
    // Build LlmMessage envelopes with role normalization.
    const llmMessages: LlmMessage[] = (
      parsedRequest.messages as { role: string; content: unknown }[]
    ).map((m, i) => ({
      id: `msg-${i}`,
      role: normalizeLlmRole(m.role),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      timestamp: Date.now(),
    }));

    // Forward request tuning params into the PushStreamRequest. The adapter
    // layer doesn't propagate these today, so this handler iterates the
    // PushStream directly — adapter round-tripping only buys us the legacy
    // callback shape, which this handler doesn't need.
    const pushReq: PushStreamRequest = {
      provider: 'cloudflare',
      model,
      messages: llmMessages,
      maxTokens:
        typeof parsedRequest.max_tokens === 'number' ? parsedRequest.max_tokens : undefined,
      temperature:
        typeof parsedRequest.temperature === 'number' ? parsedRequest.temperature : undefined,
      topP: typeof parsedRequest.top_p === 'number' ? parsedRequest.top_p : undefined,
    };

    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        try {
          // Wrap the provider stream with normalizeReasoning so inline
          // <think>...</think> tags in content are split into reasoning_delta
          // events. Native reasoning_delta events from Workers AI's reasoning
          // models (DeepSeek-R1, QwQ) pass through unchanged.
          const rawStream = cloudflareStream({ ...pushReq, signal: abortController.signal }, env);
          const stream = normalizeReasoning(rawStream);
          for await (const event of stream) {
            if (abortController.signal.aborted) break;
            if (event.type === 'text_delta') {
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: event.text } }] })}\n\n`,
                ),
              );
            } else if (event.type === 'reasoning_delta') {
              // OpenAI-extended delta shape consumed by the web client
              // (see app/src/lib/orchestrator.ts — `choice.delta.reasoning_content`).
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: event.text } }] })}\n\n`,
                ),
              );
            } else if (event.type === 'done') {
              c.enqueue(encoder.encode('data: [DONE]\n\n'));
              c.close();
              return;
            }
            // reasoning_end is a structural signal for the transducer; the
            // web client closes its thinking panel on content transition, so
            // we don't emit a dedicated SSE frame for it.
          }
          // Stream ended without a trailing done event — still close cleanly.
          c.enqueue(encoder.encode('data: [DONE]\n\n'));
          c.close();
        } catch (err) {
          try {
            c.error(err instanceof Error ? err : new Error(String(err)));
          } catch {
            // Controller already errored/closed — ignore.
          }
        }
      },
      cancel() {
        abortController.abort();
      },
    });

    wlog('info', 'upstream_ok', {
      requestId,
      route: 'api/cloudflare/chat',
      status: 200,
      trace_id: spanCtx.traceId,
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
        'X-Push-Trace-Id': spanCtx.traceId,
        'X-Push-Span-Id': spanCtx.spanId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/cloudflare/chat',
      message,
      timeout: false,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleCloudflareModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: (runtimeEnv) => (runtimeEnv.AI ? 'WorkersAIBinding' : null),
    keyMissingError: CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR,
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  const { requestId, spanCtx } = preamble;

  wlog('info', 'request', {
    requestId,
    route: 'api/cloudflare/models',
    trace_id: spanCtx.traceId,
  });

  try {
    const models = await env.AI!.models({ hide_experimental: true });
    // The AI binding's catalog uses `id` as an internal UUID and `name` as
    // the `@cf/...` string that env.AI.run() expects as the model argument.
    // We surface the run-compatible name — not the UUID — as the selectable
    // model id for the client.
    const textModels = models
      .filter(isCloudflareTextGenerationModel)
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .sort((left, right) => left.localeCompare(right));

    return Response.json(textModels, {
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        'X-Push-Trace-Id': spanCtx.traceId,
        'X-Push-Span-Id': spanCtx.spanId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/cloudflare/models',
      message,
      timeout: false,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}

// --- Ollama Cloud ---

export const handleOllamaModels = createJsonProxyHandler({
  name: 'Ollama Cloud API',
  logTag: 'api/ollama/models',
  upstreamUrl: 'https://ollama.com/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError:
    'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama Cloud model list timed out after 30 seconds',
});
export const handleOllamaChat = createStreamProxyHandler({
  name: 'Ollama Cloud API',
  logTag: 'api/ollama/chat',
  upstreamUrl: 'https://ollama.com/v1/chat/completions',
  timeoutMs: 180_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError:
    'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama Cloud request timed out after 180 seconds',
});

// --- OpenRouter ---

export const handleOpenRouterChat = createStreamProxyHandler({
  name: 'OpenRouter',
  logTag: 'api/openrouter/chat',
  upstreamUrl: 'https://openrouter.ai/api/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError:
    'OpenRouter API key not configured. Add it in Settings or set OPENROUTER_API_KEY on the Worker.',
  timeoutError: 'OpenRouter request timed out after 120 seconds',
  extraFetchHeaders: (request) => ({
    'HTTP-Referer': new URL(request.url).origin,
    'X-Title': 'Push',
  }),
  // OpenRouter returns structured errors like
  // `{"error":{"message":"User not found.","code":401}}`. The default proxy
  // formatter just dumps the JSON body via `slice(0, 200)`, which surfaces as
  // an opaque truncated payload to users. Route through the shared extractor
  // so the upstream's actual reason becomes the user-facing detail. The
  // helper also preserves the default proxy path's HTML guard so AI Gateway
  // / Cloudflare 5xx HTML challenge pages don't leak markup downstream.
  formatUpstreamError: (status, bodyText) => ({
    error: `OpenRouter ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
  // Per Cloudflare AI Gateway docs the rewritten URL is
  // `/v1/{account}/{gateway}/openrouter/chat/completions` — the provider slug
  // already absorbs OpenRouter's `/api/v1` prefix, so the suffix is just the
  // OpenAI-compat endpoint name.
  gateway: { provider: 'openrouter', pathSuffix: '/chat/completions' },
});

export const handleOpenRouterModels = createJsonProxyHandler({
  name: 'OpenRouter',
  logTag: 'api/openrouter/models',
  upstreamUrl: 'https://openrouter.ai/api/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError:
    'OpenRouter API key not configured. Add it in Settings or set OPENROUTER_API_KEY on the Worker.',
  timeoutError: 'OpenRouter model list timed out after 30 seconds',
});

// --- OpenCode Zen (OpenAI-compatible endpoint) ---

export const handleZenChat = createStreamProxyHandler({
  name: 'OpenCode Zen API',
  logTag: 'api/zen/chat',
  upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
  buildAuth: standardAuth('ZEN_API_KEY'),
  keyMissingError:
    'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
  timeoutError: 'OpenCode Zen request timed out after 120 seconds',
});

export const handleZenModels = createJsonProxyHandler({
  name: 'OpenCode Zen API',
  logTag: 'api/zen/models',
  upstreamUrl: 'https://opencode.ai/zen/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('ZEN_API_KEY'),
  keyMissingError:
    'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
  timeoutError: 'OpenCode Zen model list timed out after 30 seconds',
});

// --- Kilo Code (OpenAI-compatible gateway) ---

export const handleKiloCodeChat = createStreamProxyHandler({
  name: 'Kilo Code API',
  logTag: 'api/kilocode/chat',
  upstreamUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('KILOCODE_API_KEY'),
  keyMissingError:
    'Kilo Code API key not configured. Add it in Settings or set KILOCODE_API_KEY on the Worker.',
  timeoutError: 'Kilo Code request timed out after 120 seconds',
});

export const handleKiloCodeModels = createJsonProxyHandler({
  name: 'Kilo Code API',
  logTag: 'api/kilocode/models',
  upstreamUrl: 'https://api.kilo.ai/api/gateway/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('KILOCODE_API_KEY'),
  keyMissingError:
    'Kilo Code API key not configured. Add it in Settings or set KILOCODE_API_KEY on the Worker.',
  timeoutError: 'Kilo Code model list timed out after 30 seconds',
});

export const handleOpenAdapterChat = createStreamProxyHandler({
  name: 'OpenAdapter API',
  logTag: 'api/openadapter/chat',
  upstreamUrl: 'https://api.openadapter.in/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('OPENADAPTER_API_KEY'),
  keyMissingError:
    'OpenAdapter API key not configured. Add it in Settings or set OPENADAPTER_API_KEY on the Worker.',
  timeoutError: 'OpenAdapter request timed out after 120 seconds',
});

export const handleOpenAdapterModels = createJsonProxyHandler({
  name: 'OpenAdapter API',
  logTag: 'api/openadapter/models',
  upstreamUrl: 'https://api.openadapter.in/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OPENADAPTER_API_KEY'),
  keyMissingError:
    'OpenAdapter API key not configured. Add it in Settings or set OPENADAPTER_API_KEY on the Worker.',
  timeoutError: 'OpenAdapter model list timed out after 30 seconds',
});

// --- OpenCode Zen Go tier (mixed OpenAI + Anthropic transports) ---

export function getZenGoAuthHeaders(
  authHeader: string,
  requestId: string,
  transport: 'openai' | 'anthropic',
): Record<string, string> {
  if (transport === 'anthropic') {
    const bearerPrefix = 'Bearer ';
    const bearerToken = authHeader.startsWith(bearerPrefix)
      ? authHeader.slice(bearerPrefix.length).trim()
      : '';
    return {
      'Content-Type': 'application/json',
      Authorization: authHeader,
      'anthropic-version': '2023-06-01',
      ...(bearerToken ? { 'x-api-key': bearerToken } : {}),
      [REQUEST_ID_HEADER]: requestId,
    };
  }

  return {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    [REQUEST_ID_HEADER]: requestId,
  };
}

export async function handleZenGoChat(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth('ZEN_API_KEY'),
    keyMissingError:
      'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'OpenCode Zen Go',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/zen/go/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }

  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';
  const transport = getZenGoTransport(model);
  const upstreamUrl =
    transport === 'anthropic'
      ? 'https://opencode.ai/zen/go/v1/messages'
      : 'https://opencode.ai/zen/go/v1/chat/completions';
  const upstreamBody =
    transport === 'anthropic'
      ? JSON.stringify(buildAnthropicMessagesRequest(parsedRequest))
      : normalizedRequest.value.bodyText;

  wlog('info', 'request', {
    requestId,
    route: 'api/zen/go/chat',
    transport,
    model,
    bytes: upstreamBody.length,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: getZenGoAuthHeaders(authHeader, requestId, transport),
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    wlog('info', 'upstream_ok', {
      requestId,
      route: 'api/zen/go/chat',
      transport,
      status: upstream.status,
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/zen/go/chat',
        transport,
        status: upstream.status,
        body: errBody.slice(0, 500),
      });

      const isHtml = /<\s*html[\s>]/i.test(errBody) || /<\s*!doctype/i.test(errBody);
      const errDetail = isHtml
        ? `HTTP ${upstream.status} (the server returned an HTML error page instead of JSON)`
        : errBody.slice(0, 200);
      return Response.json(
        { error: `OpenCode Zen Go API error ${upstream.status}: ${errDetail}` },
        { status: upstream.status },
      );
    }

    if (transport === 'anthropic') {
      return new Response(createAnthropicTranslatedStream(upstream, model), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          [REQUEST_ID_HEADER]: requestId,
        },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/zen/go/chat',
      transport,
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'OpenCode Zen Go request timed out after 120 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export async function handleZenGoModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth('ZEN_API_KEY'),
    keyMissingError:
      'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;

  return Response.json({
    object: 'list',
    data: ZEN_GO_MODELS.map((id) => ({
      id,
      object: 'model',
      transport: getZenGoTransport(id),
    })),
  });
}

// --- Nvidia NIM (OpenAI-compatible endpoint) ---

export const handleNvidiaChat = createStreamProxyHandler({
  name: 'Nvidia NIM API',
  logTag: 'api/nvidia/chat',
  upstreamUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('NVIDIA_API_KEY'),
  keyMissingError:
    'Nvidia NIM API key not configured. Add it in Settings or set NVIDIA_API_KEY on the Worker.',
  timeoutError: 'Nvidia NIM request timed out after 120 seconds',
});

export const handleNvidiaModels = createJsonProxyHandler({
  name: 'Nvidia NIM API',
  logTag: 'api/nvidia/models',
  upstreamUrl: 'https://integrate.api.nvidia.com/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('NVIDIA_API_KEY'),
  keyMissingError:
    'Nvidia NIM API key not configured. Add it in Settings or set NVIDIA_API_KEY on the Worker.',
  timeoutError: 'Nvidia NIM model list timed out after 30 seconds',
});

// --- Blackbox AI ---

export const handleBlackboxChat = createStreamProxyHandler({
  name: 'Blackbox AI API',
  logTag: 'api/blackbox/chat',
  upstreamUrl: 'https://api.blackbox.ai/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('BLACKBOX_API_KEY'),
  keyMissingError:
    'Blackbox AI API key not configured. Add it in Settings or set BLACKBOX_API_KEY on the Worker.',
  timeoutError: 'Blackbox AI request timed out after 120 seconds',
});

export const handleBlackboxModels = createJsonProxyHandler({
  name: 'Blackbox AI API',
  logTag: 'api/blackbox/models',
  upstreamUrl: 'https://api.blackbox.ai/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('BLACKBOX_API_KEY'),
  keyMissingError:
    'Blackbox AI API key not configured. Add it in Settings or set BLACKBOX_API_KEY on the Worker.',
  timeoutError: 'Blackbox AI model list timed out after 30 seconds',
});

// --- Experimental private connectors (OpenAI-compatible upstreams) ---

export function createExperimentalStreamProxyHandler(
  provider: ExperimentalProviderType,
  name: string,
  logTag: string,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const upstream = getExperimentalUpstreamUrl(request, provider, '/chat/completions');
    if ('response' in upstream) return upstream.response;

    return createStreamProxyHandler({
      name,
      logTag,
      upstreamUrl: upstream.url,
      timeoutMs: 180_000,
      maxOutputTokens: 12_288,
      buildAuth: passthroughAuth,
      keyMissingError: `${name} API key not configured. Add it in Advanced AI settings.`,
      timeoutError: `${name} request timed out after 180 seconds`,
      formatUpstreamError: (status, bodyText) => ({
        error: formatExperimentalProviderHttpError(name, status, bodyText),
        code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
      }),
    })(request, env);
  };
}

export function createExperimentalModelsHandler(
  provider: ExperimentalProviderType,
  name: string,
  logTag: string,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const upstream = getExperimentalUpstreamUrl(request, provider, '/models');
    if ('response' in upstream) return upstream.response;

    return createJsonProxyHandler({
      name,
      logTag,
      upstreamUrl: upstream.url,
      method: 'GET',
      timeoutMs: 30_000,
      buildAuth: passthroughAuth,
      keyMissingError: `${name} API key not configured. Add it in Advanced AI settings.`,
      timeoutError: `${name} model list timed out after 30 seconds`,
      needsBody: false,
      formatUpstreamError: (status, bodyText) => ({
        error: formatExperimentalProviderHttpError(name, status, bodyText),
        code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
      }),
    })(request, env);
  };
}

export const handleAzureChat = createExperimentalStreamProxyHandler(
  'azure',
  'Azure OpenAI',
  'api/azure/chat',
);
export const handleAzureModels = createExperimentalModelsHandler(
  'azure',
  'Azure OpenAI',
  'api/azure/models',
);
export const handleBedrockChat = createExperimentalStreamProxyHandler(
  'bedrock',
  'AWS Bedrock',
  'api/bedrock/chat',
);
export const handleBedrockModels = createExperimentalModelsHandler(
  'bedrock',
  'AWS Bedrock',
  'api/bedrock/models',
);
export const handleLegacyVertexChat = createExperimentalStreamProxyHandler(
  'vertex',
  'Google Vertex',
  'api/vertex/chat',
);
export const handleLegacyVertexModels = createExperimentalModelsHandler(
  'vertex',
  'Google Vertex',
  'api/vertex/models',
);

export async function handleVertexChat(request: Request, env: Env): Promise<Response> {
  if (!hasVertexNativeCredentials(request)) {
    return handleLegacyVertexChat(request, env);
  }

  const preamble = await runPreamble(request, env, {
    buildAuth: buildVertexPreambleAuth,
    keyMissingError:
      'Google Vertex service account not configured. Add it in Advanced AI settings.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'Google Vertex',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/vertex/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }
  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';

  const nativeConfig = getVertexNativeConfig(request);
  if (!nativeConfig.ok) return nativeConfig.response;

  const transport = getVertexModelTransport(model);
  const upstreamUrl =
    transport === 'anthropic'
      ? buildVertexAnthropicEndpoint(
          nativeConfig.config.serviceAccount.projectId,
          nativeConfig.config.region,
          model,
        )
      : `${buildVertexOpenApiBaseUrl(nativeConfig.config.serviceAccount.projectId, nativeConfig.config.region)}/chat/completions`;
  const upstreamBody =
    transport === 'anthropic'
      ? JSON.stringify(
          buildAnthropicMessagesRequest(parsedRequest, { anthropicVersion: 'vertex-2023-10-16' }),
        )
      : normalizedRequest.value.bodyText;

  wlog('info', 'request', {
    requestId,
    route: 'api/vertex/chat',
    mode: 'native',
    transport,
    model,
    region: nativeConfig.config.region,
  });

  try {
    const accessToken = await getGoogleAccessToken(nativeConfig.config.serviceAccount);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
        },
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/vertex/chat',
        mode: 'native',
        transport,
        status: upstream.status,
        body: errBody.slice(0, 500),
      });
      return Response.json(
        {
          error: formatVertexProviderHttpError(upstream.status, errBody, transport),
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
    }

    if (transport === 'anthropic') {
      return new Response(createAnthropicTranslatedStream(upstream, model), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          [REQUEST_ID_HEADER]: requestId,
        },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/vertex/chat',
      mode: 'native',
      transport,
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'Google Vertex request timed out after 180 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export async function handleVertexModels(request: Request, env: Env): Promise<Response> {
  if (!hasVertexNativeCredentials(request)) {
    return handleLegacyVertexModels(request, env);
  }

  const preamble = await runPreamble(request, env, {
    buildAuth: buildVertexPreambleAuth,
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;

  return Response.json({
    object: 'list',
    data: VERTEX_MODEL_OPTIONS.map((model) => ({
      id: model.id,
      name: model.label,
      transport: model.transport,
      family: model.family,
    })),
  });
}

// --- OpenAI (direct /v1/chat/completions) ---
//
// OpenAI is OpenAI-compatible (obviously), so the standard
// createStreamProxyHandler factory handles everything — no bridge, no body
// translation, no response rewriting. Bearer auth, vanilla shape.

export const handleOpenAIChat = createStreamProxyHandler({
  name: 'OpenAI',
  logTag: 'api/openai/chat',
  upstreamUrl: 'https://api.openai.com/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
  buildAuth: standardAuth('OPENAI_API_KEY'),
  keyMissingError:
    'OpenAI API key not configured. Add it in Settings or set OPENAI_API_KEY on the Worker.',
  timeoutError: 'OpenAI request timed out after 120 seconds',
  formatUpstreamError: (status, bodyText) => ({
    error: `OpenAI ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
});

// OpenAI's /v1/models returns embeddings, TTS, Whisper, image, moderation, and
// legacy text-completion models alongside chat models — none of which the chat
// dropdown should surface. There's no public capability flag in the response,
// so we deny-list by id prefix. New chat families (gpt-N, oN, chatgpt-*) flow
// through automatically; new non-chat categories would need a list update.
const OPENAI_NON_CHAT_ID_PATTERNS: RegExp[] = [
  /^text-embedding-/,
  /^tts-/,
  /^whisper-/,
  /^dall-e-/,
  /^gpt-image-/,
  /-moderation-/,
  /^babbage-/,
  /^davinci-/,
  /^text-davinci-/,
  /^text-curie-/,
  /^text-babbage-/,
  /^text-ada-/,
  /^code-/,
  /-search-/,
];

function isOpenAIChatModel(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false;
  return !OPENAI_NON_CHAT_ID_PATTERNS.some((re) => re.test(id));
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const OPENAI_MODELS_TIMEOUT_MS = 30_000;

export async function handleOpenAIModels(request: Request, env: Env): Promise<Response> {
  // Preamble runs origin check + rate-limit even when we end up serving the
  // curated fallback — keeps this route in the same bucket as the chat route
  // and the other /models proxies. `buildAuth` returns a placeholder so the
  // preamble doesn't 401 when the key is missing; the real key check happens
  // below so a missing key falls back to the curated list instead.
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'OpenAIChatModelsList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  const { requestId } = preamble;

  const apiKey = resolveDirectProviderKey(env.OPENAI_API_KEY, request);
  if (!apiKey) {
    return curatedOpenAIModelsResponse(requestId);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(OPENAI_MODELS_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          [REQUEST_ID_HEADER]: requestId,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      wlog('warn', 'upstream_error_fallback', {
        requestId,
        route: 'api/openai/models',
        status: upstream.status,
        body: body.slice(0, 300),
      });
      return curatedOpenAIModelsResponse(requestId);
    }

    const json = (await upstream.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
    const upstreamData = Array.isArray(json?.data) ? json!.data : [];
    const filtered = upstreamData
      .map((entry) => (entry && typeof entry === 'object' ? entry.id : null))
      .filter(isOpenAIChatModel)
      .map((id) => ({ id, name: id }));

    // Empty result after filtering is suspicious (upstream shape drift, or
    // the deny-list matched every id) — prefer the curated list over an
    // empty dropdown.
    if (filtered.length === 0) {
      wlog('warn', 'empty_after_filter_fallback', {
        requestId,
        route: 'api/openai/models',
        upstreamCount: upstreamData.length,
      });
      return curatedOpenAIModelsResponse(requestId);
    }

    return Response.json(
      { object: 'list', data: filtered },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('warn', isTimeout ? 'upstream_timeout_fallback' : 'unhandled_fallback', {
      requestId,
      route: 'api/openai/models',
      message: err instanceof Error ? err.message : String(err),
      timeout: isTimeout,
    });
    return curatedOpenAIModelsResponse(requestId);
  }
}

function curatedOpenAIModelsResponse(requestId: string): Response {
  return Response.json(
    { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, name: id })) },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/** Resolve a direct-provider API key from the server env first, else the
 *  client's Authorization: Bearer header. Mirrors `standardAuth` in
 *  worker-middleware.ts but used inline here so the handler can decide to
 *  fall back to curated instead of 401-ing when no key resolves. */
function resolveDirectProviderKey(serverKey: string | undefined, request: Request): string | null {
  if (serverKey && serverKey.trim()) return serverKey.trim();
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() || null : auth.trim() || null;
}

// --- Anthropic Claude (direct /v1/messages) ---
//
// Models: serve the curated `ANTHROPIC_MODELS` list. Anthropic does have a
// live `/v1/models` endpoint, but its full list closely matches what's
// curated anyway and proxying it adds another auth path + rate-limit class
// without changing the dropdown content materially. Unlike OpenAI/Gemini
// (which return embeddings/TTS/etc the chat dropdown has to filter out),
// the Anthropic catalog is small enough that the curated list stays in sync
// without continuous upstream polling. Leave curated until / unless the
// dropdown needs surface parity with new Claude releases the moment they
// ship — at which point mirror handleOpenAIModels.
//
// Modeled on handleVertexChat's native-Anthropic transport path. Difference:
// auth is a flat `x-api-key` header instead of OAuth, no project/region path
// segments, and no `anthropic_version` in the body — the version goes in the
// header. Reuses `buildAnthropicMessagesRequest` and `createAnthropicTranslatedStream`
// from the bridge so the response surfaces to the client as OpenAI-shaped SSE.

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function buildAnthropicAuth(env: Env, request: Request): string | null {
  const serverKey = env.ANTHROPIC_API_KEY;
  if (serverKey) return serverKey;
  // Accept a client-side `Authorization: Bearer <key>` for dev / unconfigured
  // Worker paths, matching the standardAuth fallback shape used by the
  // OpenAI-compat providers.
  const clientAuth = request.headers.get('Authorization');
  if (clientAuth?.startsWith('Bearer ')) return clientAuth.slice(7);
  return clientAuth;
}

export async function handleAnthropicChat(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: buildAnthropicAuth,
    keyMissingError:
      'Anthropic API key not configured. Add it in Settings or set ANTHROPIC_API_KEY on the Worker.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'Anthropic',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/anthropic/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }
  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';
  if (!model) {
    return Response.json({ error: 'Anthropic request is missing a model id' }, { status: 400 });
  }

  // Anthropic API requires the version header. We deliberately do NOT pass
  // `anthropicVersion` into the body — that field is for Vertex's
  // `vertex-2023-10-16` shape; the direct Anthropic API ignores any
  // `anthropic_version` field and reads it from the header instead.
  //
  // `buildAnthropicMessagesRequest` does not include `model` in the body
  // because Vertex carries the model in the URL path. Direct `/v1/messages`
  // requires `model` in the JSON, so re-attach it here.
  const upstreamBody = JSON.stringify({
    ...buildAnthropicMessagesRequest(parsedRequest),
    model,
  });

  wlog('info', 'request', {
    requestId,
    route: 'api/anthropic/chat',
    model,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
        },
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/anthropic/chat',
        status: upstream.status,
        body: errBody.slice(0, 500),
      });
      return Response.json(
        {
          error: `Anthropic ${upstream.status}: ${extractProviderHttpErrorDetail(upstream.status, errBody)}`,
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
    }

    return new Response(createAnthropicTranslatedStream(upstream, model), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/anthropic/chat',
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'Anthropic request timed out after 180 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export async function handleAnthropicModels(request: Request, env: Env): Promise<Response> {
  // Run preamble for origin check + rate limit even though we serve a static
  // curated list — keeps the route shape consistent with the other /models
  // proxies and pins the call within the same rate-limit bucket.
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'AnthropicCuratedList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  return Response.json({
    object: 'list',
    data: ANTHROPIC_MODELS.map((id) => ({ id, name: id })),
  });
}

// --- Google Gemini (direct /v1beta/models/{model}:streamGenerateContent) ---
//
// Modeled on handleAnthropicChat: the Worker accepts OpenAI-shaped JSON,
// translates the body via `buildGeminiGenerateContentRequest`, sends to
// Google's Generative Language API with `x-goog-api-key`, then pipes the
// upstream SSE through `createGeminiTranslatedStream` so the client sees the
// familiar OpenAI SSE shape.
//
// Gemini's API is distinct from Vertex's Gemini OpenAPI endpoint: this is the
// public `generativelanguage.googleapis.com` host that takes a plain API key
// (no service-account OAuth, no project/region path segments).
//
// Models: live proxy against `/v1beta/models`, filtered to chat-capable
// entries via the upstream's `supportedGenerationMethods` array (the
// canonical capability flag). Falls back to the curated `GOOGLE_MODELS`
// list when the key is missing or upstream is unhealthy so the dropdown
// stays populated for offline / unconfigured dev paths.

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function buildGoogleAuth(env: Env, request: Request): string | null {
  const serverKey = env.GOOGLE_API_KEY;
  if (serverKey) return serverKey;
  // Accept a client-side `Authorization: Bearer <key>` for dev / unconfigured
  // Worker paths, matching the standardAuth fallback shape used by the other
  // direct providers.
  const clientAuth = request.headers.get('Authorization');
  if (clientAuth?.startsWith('Bearer ')) return clientAuth.slice(7);
  return clientAuth;
}

export async function handleGoogleChat(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: buildGoogleAuth,
    keyMissingError:
      'Google Gemini API key not configured. Add it in Settings or set GOOGLE_API_KEY on the Worker.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'Google Gemini',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/google/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }

  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';
  if (!model) {
    return Response.json({ error: 'Google request is missing a model id' }, { status: 400 });
  }

  // Gemini puts the model in the URL path and selects SSE framing via
  // `?alt=sse`. The body is the OpenAI→Gemini translation; auth is the API
  // key in the `x-goog-api-key` header (preferred over the legacy `?key=`
  // query-param so the secret stays out of access logs).
  const upstreamUrl = `${GOOGLE_API_BASE}/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse`;
  const upstreamBody = JSON.stringify(buildGeminiGenerateContentRequest(parsedRequest));

  wlog('info', 'request', {
    requestId,
    route: 'api/google/chat',
    model,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
        },
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/google/chat',
        status: upstream.status,
        body: errBody.slice(0, 500),
      });
      return Response.json(
        {
          error: `Google ${upstream.status}: ${extractProviderHttpErrorDetail(upstream.status, errBody)}`,
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
    }

    return new Response(createGeminiTranslatedStream(upstream, model), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/google/chat',
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'Google request timed out after 180 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

const GOOGLE_MODELS_TIMEOUT_MS = 30_000;

export async function handleGoogleModels(request: Request, env: Env): Promise<Response> {
  // Same preamble trick as handleOpenAIModels: placeholder auth so the
  // preamble doesn't 401 on missing key — we check the real key below and
  // fall back to the curated list instead of returning an error.
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'GoogleChatModelsList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  const { requestId } = preamble;

  const apiKey = resolveDirectProviderKey(env.GOOGLE_API_KEY, request);
  if (!apiKey) {
    return curatedGoogleModelsResponse(requestId);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOOGLE_MODELS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(`${GOOGLE_API_BASE}/models?pageSize=200`, {
        method: 'GET',
        headers: {
          'x-goog-api-key': apiKey,
          [REQUEST_ID_HEADER]: requestId,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      wlog('warn', 'upstream_error_fallback', {
        requestId,
        route: 'api/google/models',
        status: upstream.status,
        body: body.slice(0, 300),
      });
      return curatedGoogleModelsResponse(requestId);
    }

    // Gemini's models endpoint returns objects of shape:
    //   { name: "models/gemini-2.5-flash", supportedGenerationMethods: [...] }
    // The `name` carries a `models/` prefix that the chat URL builder doesn't
    // expect, and `supportedGenerationMethods` is the canonical capability
    // flag — `generateContent` (and its streaming sibling) marks chat-capable
    // entries. Embeddings models advertise `embedContent` instead and are
    // filtered out here.
    const json = (await upstream.json().catch(() => null)) as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
    } | null;
    const upstreamModels = Array.isArray(json?.models) ? json!.models : [];
    const filtered = upstreamModels
      .filter((entry): entry is { name: string; supportedGenerationMethods: string[] } => {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.name !== 'string' || entry.name.length === 0) return false;
        const methods = entry.supportedGenerationMethods;
        if (!Array.isArray(methods)) return false;
        return methods.includes('generateContent');
      })
      .map((entry) => {
        const id = entry.name.startsWith('models/')
          ? entry.name.slice('models/'.length)
          : entry.name;
        return { id, name: id };
      });

    if (filtered.length === 0) {
      wlog('warn', 'empty_after_filter_fallback', {
        requestId,
        route: 'api/google/models',
        upstreamCount: upstreamModels.length,
      });
      return curatedGoogleModelsResponse(requestId);
    }

    return Response.json(
      { object: 'list', data: filtered },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('warn', isTimeout ? 'upstream_timeout_fallback' : 'unhandled_fallback', {
      requestId,
      route: 'api/google/models',
      message: err instanceof Error ? err.message : String(err),
      timeout: isTimeout,
    });
    return curatedGoogleModelsResponse(requestId);
  }
}

function curatedGoogleModelsResponse(requestId: string): Response {
  return Response.json(
    { object: 'list', data: GOOGLE_MODELS.map((id) => ({ id, name: id })) },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

// --- Ollama Web Search proxy ---

export const handleOllamaSearch = createJsonProxyHandler({
  name: 'Ollama search',
  logTag: 'api/ollama/search',
  upstreamUrl: 'https://ollama.com/api/web_search',
  method: 'POST',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError:
    'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama search timed out after 30 seconds',
});

// --- Tavily web search proxy (optional premium upgrade) ---

export async function handleTavilySearch(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: (_env, req) => {
      const auth = req.headers.get('Authorization');
      return auth; // Tavily key comes from client only
    },
    keyMissingError: 'Missing Tavily API key in Authorization header',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText } = preamble;

  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!apiKey) {
    return Response.json(
      { error: 'Missing Tavily API key in Authorization header' },
      { status: 401 },
    );
  }

  let query: string;
  try {
    const parsed = JSON.parse(bodyText) as { query?: string };
    if (!parsed.query || typeof parsed.query !== 'string') {
      return Response.json({ error: 'Missing "query" field' }, { status: 400 });
    }
    query = parsed.query.trim();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  wlog('info', 'search', { provider: 'tavily', query });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    let upstream: Response;

    try {
      upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        route: 'api/search/tavily',
        status: upstream.status,
        body: errBody.slice(0, 200),
      });
      return Response.json(
        { error: `Tavily returned ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status },
      );
    }

    // Tavily returns { results: [{ title, url, content, score, ... }] }
    // Normalize to our WebSearchResult shape: { title, url, content }
    const data = (await upstream.json()) as {
      results?: { title: string; url: string; content: string; score?: number }[];
    };
    const results = (data.results || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));

    wlog('info', 'search_results', { provider: 'tavily', query, count: results.length });
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Tavily search timed out after 30 seconds' : message;
    wlog('error', 'search_error', { provider: 'tavily', message, timeout: isTimeout });
    return Response.json({ error }, { status });
  }
}

// --- Free web search (DuckDuckGo HTML scraping) ---

/**
 * Parse DuckDuckGo HTML lite search results into structured JSON.
 * The lite page (html.duckduckgo.com/html/) has a simple, stable structure
 * designed for low-bandwidth clients. We extract titles, URLs, and snippets.
 */
export function parseDuckDuckGoHTML(
  html: string,
): { title: string; url: string; content: string }[] {
  const results: { title: string; url: string; content: string }[] = [];

  // Match result blocks: <a class="result__a" href="URL">TITLE</a>
  // followed by <a class="result__snippet" ...>SNIPPET</a>
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  // Collect all result links
  const links: { url: string; title: string }[] = [];
  let match;
  while ((match = resultBlockRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const rawTitle = match[2].replace(/<[^>]*>/g, '').trim();
    if (rawUrl && rawTitle && rawUrl.startsWith('http')) {
      let safeUrl = rawUrl;
      try {
        safeUrl = decodeURIComponent(rawUrl);
      } catch {
        // If decoding fails, fall back to the raw URL to avoid failing the whole parse.
      }
      links.push({ url: safeUrl, title: rawTitle });
    }
  }

  // Collect all snippets
  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
  }

  // Pair them up
  for (let i = 0; i < links.length && i < 5; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      content: snippets[i] || '',
    });
  }

  return results;
}

export async function handleFreeSearch(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: () => null, // No auth needed for DuckDuckGo
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { bodyText } = preamble;

  let query: string;
  try {
    const parsed = JSON.parse(bodyText) as { query?: string };
    if (!parsed.query || typeof parsed.query !== 'string') {
      return Response.json({ error: 'Missing "query" field' }, { status: 400 });
    }
    query = parsed.query.trim();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  wlog('info', 'search', { provider: 'ddg', query });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    let upstream: Response;

    try {
      upstream = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: { 'User-Agent': 'Push/1.0 (AI Coding Assistant)' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      return Response.json(
        { error: `DuckDuckGo returned ${upstream.status}` },
        { status: upstream.status },
      );
    }

    const html = await upstream.text();
    const results = parseDuckDuckGoHTML(html);

    wlog('info', 'search_results', { provider: 'ddg', query, count: results.length });
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Search timed out after 15 seconds' : message;
    wlog('error', 'search_error', { provider: 'ddg', message, timeout: isTimeout });
    return Response.json({ error }, { status });
  }
}
