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
  buildVertexAnthropicEndpoint,
  buildVertexOpenApiBaseUrl,
  getVertexModelTransport,
  VERTEX_MODEL_OPTIONS,
} from './worker-middleware';
import { REQUEST_ID_HEADER } from '../lib/request-id';
import { validateAndNormalizeChatRequest } from '../lib/chat-request-guardrails';
import {
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from '../lib/openai-anthropic-bridge';
import { getZenGoTransport, ZEN_GO_MODELS } from '../lib/zen-go';
import {
  buildVertexAnthropicEndpoint as buildVertexAnthropicEndpointLib,
  buildVertexOpenApiBaseUrl as buildVertexOpenApiBaseUrlLib,
  getVertexModelTransport as getVertexModelTransportLib,
  VERTEX_MODEL_OPTIONS as VERTEX_MODEL_OPTIONS_LIB,
} from '../lib/vertex-provider';
import {
  formatExperimentalProviderHttpError,
  formatVertexProviderHttpError,
} from '../lib/provider-error-utils';
import type { ExperimentalProviderType } from '../lib/experimental-providers';

// Gateway Abstraction imports
import {
  createProviderStreamAdapter,
  type LlmMessage,
  type PushStream,
  type PushStreamRequest,
  type PushStreamEvent,
} from '../../lib/provider-contract';
// --- Cloudflare Workers AI ---

const CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR =
  'Cloudflare Workers AI is not configured on this Worker. Add an `ai` binding in `wrangler.jsonc` and redeploy.';

function isCloudflareTextGenerationModel(model: AiModelsSearchObject): boolean {
  const taskId = model.task?.id?.toLowerCase() ?? '';
  const taskName = model.task?.name?.toLowerCase() ?? '';
  return taskId.includes('text-generation') || taskName.includes('text generation');
}

function buildCloudflareAiInput(parsedRequest: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    messages: parsedRequest.messages,
    stream: true,
  };

  if (Array.isArray(parsedRequest.tools)) input.tools = parsedRequest.tools;
  if (Array.isArray(parsedRequest.functions)) input.functions = parsedRequest.functions;
  if (
    parsedRequest.response_format &&
    typeof parsedRequest.response_format === 'object' &&
    !Array.isArray(parsedRequest.response_format)
  ) {
    input.response_format = parsedRequest.response_format;
  }

  for (const key of [
    'raw',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'seed',
    'repetition_penalty',
    'frequency_penalty',
    'presence_penalty',
  ] as const) {
    if (key in parsedRequest) input[key] = parsedRequest[key];
  }
  return input;
}

// Cloudflare Workers AI PushStream implementation
async function* cloudflareStream(req: PushStreamRequest, env: Env): AsyncIterable<PushStreamEvent> {
  // Build the input for env.AI.run
  const input: Record<string, unknown> = {
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };

  // Map PushStreamRequest params to Cloudflare AI params
  if (req.maxTokens !== undefined) input.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) input.temperature = req.temperature;
  if (req.topP !== undefined) input.top_p = req.topP;

  try {
    // Run the AI model
    const stream = (await (env.AI as any).run(req.model, input)) as
      | ReadableStream<Uint8Array>
      | unknown;

    if (!(stream instanceof ReadableStream)) {
      throw new Error('Cloudflare AI did not return a stream');
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (
              parsed.choices &&
              parsed.choices[0] &&
              parsed.choices[0].delta &&
              parsed.choices[0].delta.content
            ) {
              yield { type: 'text_delta', text: parsed.choices[0].delta.content };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }

    // If we exit the loop without [DONE], process remaining buffer then yield done
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                yield { type: 'text_delta', text: parsed.choices[0].delta.content };
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    }
    yield { type: 'done', finishReason: 'stop' };
  } catch (error) {
    // For errors, we could yield an error event, but since PushStreamEvent doesn't have error type,
    // throw the error to be handled by the adapter
    throw error;
  }
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
    maxOutputTokens: 12_288,
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
    // Convert raw messages to LlmMessage shape for the PushStream contract.
    const llmMessages: LlmMessage[] = (
      parsedRequest.messages as { role: string; content: string }[]
    ).map((m, i) => ({
      id: `msg-${i}`,
      role: m.role as 'user' | 'assistant' | 'system',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      timestamp: Date.now(),
    }));

    const req: PushStreamRequest = {
      provider: 'cloudflare',
      model,
      messages: llmMessages,
      maxTokens: parsedRequest.max_tokens as number | undefined,
      temperature: parsedRequest.temperature as number | undefined,
      topP: parsedRequest.top_p as number | undefined,
    };

    // Build a cloudflareStream that is curried over env.
    const cloudflareFn: PushStream = (r) => cloudflareStream(r, env);
    const adaptedStream = createProviderStreamAdapter(cloudflareFn, 'cloudflare', {
      defaultModel: model,
    });

    // Collect chunks into a SSE stream for the HTTP response.
    let pending = '';

    // Wire an AbortSignal so cancellation propagates through the adapter.
    const controller = new AbortController();

    const body = new ReadableStream({
      start(c) {
        adaptedStream(
          llmMessages,
          (token) => {
            pending += `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
            c.enqueue(new TextEncoder().encode(pending));
            pending = '';
          },
          () => {
            pending += `data: [DONE]\n\n`;
            c.enqueue(new TextEncoder().encode(pending));
            pending = '';
            c.close();
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            c.error(new Error(msg));
          },
          undefined, // onThinkingToken
          undefined, // workspaceContext
          undefined, // hasSandbox
          undefined, // modelOverride (defaultModel is set above)
          undefined, // systemPromptOverride
          undefined, // scratchpadContent
          controller.signal, // signal — abort here propagates to the adapter
        );
      },
      cancel() {
        controller.abort();
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

// --- Mistral ---

// --- OpenRouter ---

export const handleOpenRouterChat = createStreamProxyHandler({
  name: 'OpenRouter API',
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
});

export const handleOpenRouterModels = createJsonProxyHandler({
  name: 'OpenRouter API',
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
