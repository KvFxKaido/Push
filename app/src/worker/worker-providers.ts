import type { AiGatewayBinding, Env } from './worker-middleware';
import type { AiModelsSearchObject } from '@cloudflare/workers-types';
import { asRecord } from '../lib/utils';
import {
  createStreamProxyHandler,
  createJsonProxyHandler,
  standardAuth,
  buildAiGatewayUrl,
  getAiGatewayAuthHeader,
  isGatewayByokProvider,
  runPreamble,
  wlog,
} from './worker-middleware';
import { REQUEST_ID_HEADER } from '../lib/request-id';
import {
  parseDualAcceptRequest,
  validateAndNormalizeChatRequest,
} from '../lib/chat-request-guardrails';
import { buildAnthropicMessagesRequest, toAnthropicMessages } from '@push/lib/anthropic-bridge';
import {
  flatToolToOpenAITool,
  toOpenAIChat,
  toOpenAIResponseFormat,
} from '@push/lib/openai-chat-serializer';
import { getZenGoTransport, ZEN_GO_MODELS } from '../lib/zen-go';
import {
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  OPENAI_MODELS,
  XAI_MODELS,
  ZAI_MODELS,
  KIMI_MODELS,
} from '@push/lib/provider-models';
import {
  buildGeminiGenerateContentRequest,
  toGeminiGenerateContent,
} from '@push/lib/gemini-bridge';
import { isGeminiModelId } from '@push/lib/gemini-thought-signature';
import { kimiSamplingRule } from '@push/lib/kimi-sampling';
import { extractProviderHttpErrorDetail } from '../lib/provider-error-utils';
import { buildTraceparent, createChildContext } from './worker-tracing';

// Gateway Abstraction imports
import type {
  LlmMessage,
  PushStreamRequest,
  PushStreamEvent,
  ResponseFormatSpec,
  ToolFunctionSchema,
} from '@push/lib/provider-contract';
import { PROVIDER_DEFINITIONS, type RealProviderId } from '@push/lib/provider-definition';
import { parseNativeToolCallArgs } from '@push/lib/openai-sse-pump';
import { normalizeReasoning } from '@push/lib/reasoning-tokens';
import { KNOWN_TOOL_NAMES } from '@push/lib/tool-call-diagnosis';
// --- Cloudflare Workers AI ---

const CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR =
  'Cloudflare Workers AI is not configured on this Worker. Add an `ai` binding in `wrangler.jsonc` and redeploy.';

function isCloudflareTextGenerationModel(model: AiModelsSearchObject): boolean {
  const taskId = model.task?.id?.toLowerCase() ?? '';
  const taskName = model.task?.name?.toLowerCase() ?? '';
  return taskId.includes('text-generation') || taskName.includes('text generation');
}

/**
 * One entry of the Cloudflare model catalog surfaced to clients. The catalog
 * is the binding's own `env.AI.models()` output (an `AiModelsSearchObject`);
 * we project it down to the run-compatible id plus the capability flags the
 * client's native-tool / structured-output gates consume. Only `functionCalling`
 * is carried today — Workers AI's catalog exposes JSON-mode support implicitly
 * through the same `function_calling` property (the two ship together), and
 * `parseStructured` backstops the structured-output path.
 */
export interface CloudflareCatalogModel {
  /** The `@cf/...` string env.AI.run() expects (the binding's `name`). */
  id: string;
  /** Whether the model card advertises the `function_calling` property. */
  functionCalling: boolean;
}

/** Read a single `property_id`'s value from a model's `properties` array. */
function readCloudflareModelProperty(
  model: AiModelsSearchObject,
  propertyId: string,
): string | undefined {
  const props = (model as { properties?: Array<{ property_id?: string; value?: string }> })
    .properties;
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    if (prop?.property_id === propertyId) return prop.value;
  }
  return undefined;
}

/**
 * Whether the catalog flags the model with the `function_calling` property.
 * Workers AI reports the value as a string (`"true"`); accept the common
 * truthy spellings defensively rather than pinning one serialization.
 */
function cloudflareModelHasFunctionCalling(model: AiModelsSearchObject): boolean {
  const raw = readCloudflareModelProperty(model, 'function_calling')?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// Cloudflare Workers AI PushStream implementation.
// NOTE: SSE parsing here is deliberately minimal to match the chunk shape that
// env.AI.run emits (single-line `data: {json}` frames terminated by `\n`). If
// more providers need SSE parsing, extract a shared pump rather than copying
// this one.
/**
 * Reconstruct a neutral `ResponseFormatSpec` from the OpenAI-shaped
 * `response_format` field the client serializes into the request body
 * (`toOpenAIResponseFormat`). Returns `undefined` for any shape that isn't a
 * complete `json_schema` block so a malformed field is dropped rather than
 * forwarded to `env.AI.run` and rejected upstream.
 *
 * `json_schema` is intentionally the only `type` accepted — it's the sole
 * structured-output shape Push emits (`ResponseFormatSpec`). A future
 * format type (e.g. plain `json_object`) would extend `ResponseFormatSpec`
 * first, then this parser; until then anything else is correctly dropped.
 */
function parseResponseFormatSpec(raw: unknown): ResponseFormatSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rf = raw as Record<string, unknown>;
  if (rf.type !== 'json_schema') return undefined;
  const js = rf.json_schema;
  if (!js || typeof js !== 'object') return undefined;
  const block = js as Record<string, unknown>;
  const name = typeof block.name === 'string' ? block.name : undefined;
  const schema =
    block.schema && typeof block.schema === 'object'
      ? (block.schema as Record<string, unknown>)
      : undefined;
  if (!name || !schema) return undefined;
  return {
    name,
    schema,
    ...(typeof block.strict === 'boolean' ? { strict: block.strict } : {}),
  };
}

/**
 * Validate the OpenAI-shaped `tools` array the client serializes into the body
 * and lift it back into Push's canonical flat schema shape. The client builds
 * these from the registry (`tool-function-schemas.ts`), so this is a shape
 * guard, not a re-derivation: keep only well-formed function entries and drop
 * the field entirely if none survive.
 */
function parseToolSchemas(raw: unknown): ToolFunctionSchema[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: ToolFunctionSchema[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'function') continue;
    const fn = e.function as Record<string, unknown> | undefined;
    if (!fn || typeof fn !== 'object') continue;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const parameters = asRecord(fn.parameters);
    const properties = parameters ? asRecord(parameters.properties) : null;
    const required = parameters?.required;
    if (
      parameters?.type !== 'object' ||
      !properties ||
      !Array.isArray(required) ||
      !required.every((field) => typeof field === 'string') ||
      parameters?.additionalProperties !== false
    ) {
      continue;
    }
    valid.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      input_schema: {
        type: 'object',
        properties: properties as ToolFunctionSchema['input_schema']['properties'],
        required: required as string[],
        additionalProperties: false,
      },
    });
  }
  return valid.length > 0 ? valid : undefined;
}

async function* cloudflareStream(req: PushStreamRequest, env: Env): AsyncIterable<PushStreamEvent> {
  const input: Record<string, unknown> = {
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };

  if (req.maxTokens !== undefined) input.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) input.temperature = req.temperature;
  if (req.topP !== undefined) input.top_p = req.topP;
  // Native JSON-schema structured outputs for models that support it (Kimi
  // K2.x, GLM). Workers AI's binding accepts the OpenAI `response_format`
  // shape; gated upstream by `providerModelSupportsStructuredOutput` so it's
  // only set for supporting models.
  if (req.responseFormat) input.response_format = toOpenAIResponseFormat(req.responseFormat);
  // Native function calling — the binding accepts the OpenAI `tools` shape, so
  // downcast from Push's canonical flat schema at this provider boundary.
  // Gated upstream (only models that support it get a `tools` array), so its
  // presence here is the signal to forward it.
  if (req.tools && req.tools.length > 0) {
    input.tools = req.tools.map(flatToolToOpenAITool);
    input.tool_choice = req.toolChoice ?? 'auto';
  }

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

  // Native function calling: Kimi/GLM answer with OpenAI `delta.tool_calls`
  // (name + args split across frames). Accumulate by index and flush as
  // structured native_tool_call events. The outer Worker response serializer
  // converts those back to OpenAI `delta.tool_calls` frames so the browser pump
  // can dispatch them without fenced assistant text. Filtered by
  // KNOWN_TOOL_NAMES so a hallucinated function name doesn't reach dispatch.
  const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
  function* flushToolCalls(): Generator<PushStreamEvent> {
    if (pendingToolCalls.size === 0) return;
    for (const [, tc] of pendingToolCalls) {
      const known = Boolean(tc.name && KNOWN_TOOL_NAMES.has(tc.name));
      const parsedArgs = parseNativeToolCallArgs(tc.args);
      let parsedOk = true;
      try {
        if (tc.args) JSON.parse(tc.args);
      } catch {
        parsedOk = false;
      }
      // Observability for the native-function-calling path (#955). Lets us see
      // what Kimi/GLM actually emit — empty/unparseable args (phantom calls) and
      // unknown names — so we can root-cause validation_failed churn from real
      // data rather than inference. One line per flushed native call.
      wlog(known && parsedOk ? 'info' : 'warn', 'cloudflare_native_tool_call_flushed', {
        tool: tc.name || null,
        known,
        parsedOk,
        argBytes: tc.args.length,
      });
      if (!known) continue;
      yield {
        type: 'native_tool_call',
        call: {
          ...(tc.id ? { id: tc.id } : {}),
          name: tc.name,
          args: parsedArgs,
        },
      };
    }
    pendingToolCalls.clear();
  }

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
      // Accumulate native tool-call fragments (name/args split across frames).
      const toolCalls = delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls as Array<{
          index?: unknown;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>) {
          const idx = typeof tc?.index === 'number' ? tc.index : 0;
          const fnCall = tc?.function;
          if (!fnCall) continue;
          const entry = pendingToolCalls.get(idx) ?? { id: '', name: '', args: '' };
          if (typeof tc?.id === 'string') entry.id = tc.id;
          if (typeof fnCall.name === 'string') entry.name = fnCall.name;
          if (typeof fnCall.arguments === 'string') entry.args += fnCall.arguments;
          pendingToolCalls.set(idx, entry);
        }
      }
      // Flush structured native tool calls when the model signals completion.
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (typeof finishReason === 'string' && finishReason) {
        yield* flushToolCalls();
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
          // Flush any tool calls not already flushed on a finish_reason frame.
          yield* flushToolCalls();
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
    yield* flushToolCalls();
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

    // A present-but-malformed response_format is dropped (not forwarded to
    // env.AI.run, which would reject it). Log the drop so a client/serializer
    // drift doesn't silently fall back to prompt-only generation — the client
    // serializes via `toOpenAIResponseFormat`, so this branch should never fire
    // in practice.
    const responseFormat = parseResponseFormatSpec(parsedRequest.response_format);
    if (parsedRequest.response_format != null && responseFormat === undefined) {
      wlog('warn', 'cloudflare_response_format_dropped', {
        requestId,
        route: 'api/cloudflare/chat',
        model,
      });
    }

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
      responseFormat,
      tools: parseToolSchemas(parsedRequest.tools),
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
          let nativeToolCallIndex = 0;
          for await (const event of stream) {
            if (abortController.signal.aborted) break;
            if (event.type === 'text_delta') {
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: event.text } }] })}\n\n`,
                ),
              );
            } else if (event.type === 'native_tool_call') {
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: nativeToolCallIndex++,
                              ...(event.call.id ? { id: event.call.id } : {}),
                              type: 'function',
                              function: {
                                name: event.call.name,
                                arguments: JSON.stringify(event.call.args ?? {}),
                              },
                            },
                          ],
                        },
                      },
                    ],
                  })}\n\n`,
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
    // model id, paired with the capability flags the client's gates read so
    // the picker doesn't have to name-match Kimi/GLM to infer tool support.
    const catalog: CloudflareCatalogModel[] = models
      .filter(isCloudflareTextGenerationModel)
      .filter(
        (model): model is AiModelsSearchObject & { name: string } =>
          typeof model.name === 'string' && model.name.trim().length > 0,
      )
      .map((model) => ({
        id: model.name.trim(),
        functionCalling: cloudflareModelHasFunctionCalling(model),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    return Response.json(catalog, {
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
  // `ollama.com/v1/models` is a PUBLIC catalog (keyless → full list). Routing it
  // through `custom-ollama` truncates it — the CF gateway's custom-provider
  // proxy returns an observed-model subset, not the upstream catalog (the "only
  // one model in Settings" bug). Fetch it direct and keyless via publicList; the
  // key (when there is one) lives in the gateway BYOK store, which only the chat
  // handler below needs. Chat stays gateway-routed.
  publicList: true,
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
  // Bucket C spike (AIG v2 doc, Path 1.5): Ollama Cloud is not a first-party AI
  // Gateway provider, so it rides the *custom provider* proxy —
  // `custom-ollama/{path}` where the registered provider's base_url is the domain
  // (`https://ollama.com`) and this pathSuffix supplies the rest, yielding the
  // same upstream as the direct call. Dormant until `ollama` is registered +
  // enabled as a gateway custom provider AND listed in CF_AI_GATEWAY_CUSTOM_SLUGS
  // (see isCustomGatewaySlugEnabled) — otherwise custom-ollama would 404.
  gateway: { provider: 'custom-ollama', pathSuffix: '/v1/chat/completions' },
});

// --- OpenRouter ---

const OPENROUTER_KEY_MISSING_ERROR =
  'OpenRouter API key not configured. Add it in Settings or set OPENROUTER_API_KEY on the Worker.';

const openRouterExtraFetchHeaders = (request: Request): Record<string, string> => ({
  'HTTP-Referer': new URL(request.url).origin,
  'X-Title': 'Push',
});

const handleOpenRouterChatLegacy = createStreamProxyHandler({
  name: 'OpenRouter',
  logTag: 'api/openrouter/chat',
  upstreamUrl: 'https://openrouter.ai/api/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError: OPENROUTER_KEY_MISSING_ERROR,
  timeoutError: 'OpenRouter request timed out after 120 seconds',
  extraFetchHeaders: openRouterExtraFetchHeaders,
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

/**
 * Route by BODY SHAPE alone: a Responses body (`input`) goes to
 * `/v1/responses`, anything else to the legacy Chat Completions proxy. The
 * per-model "may this model use /responses?" decision lives where bodies are
 * BUILT (web `openrouter-stream.ts`, background `coder-job-stream-adapter.ts`,
 * CLI `provider.ts`) from `PushCapabilityProfile.openaiWire` — so shape and
 * endpoint always agree here. Do NOT re-add a model capability check at this
 * layer: it can't rescue a Responses body (the chat validator 400s on a
 * missing `messages`), and it breaks the documented force-responses override
 * (`VITE_OPENROUTER_TRANSPORT=responses`) used to trial a model before its
 * capability is known — the deployed web path posts through this Worker (Codex P2 on
 * #1305). An unsupported model on /responses gets OpenRouter's own error,
 * which is the accurate one.
 */
async function openRouterRequestUsesResponses(request: Request): Promise<boolean> {
  const bodyText = await request
    .clone()
    .text()
    .catch(() => '');
  try {
    const parsed = JSON.parse(bodyText);
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, 'input')
    );
  } catch {
    return false;
  }
}

export async function handleOpenRouterChat(request: Request, env: Env): Promise<Response> {
  if (await openRouterRequestUsesResponses(request)) {
    return handleOpenRouterResponses(request, env);
  }
  return handleOpenRouterChatLegacy(request, env);
}

export const handleOpenRouterModels = createJsonProxyHandler({
  name: 'OpenRouter',
  logTag: 'api/openrouter/models',
  upstreamUrl: 'https://openrouter.ai/api/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError: OPENROUTER_KEY_MISSING_ERROR,
  timeoutError: 'OpenRouter model list timed out after 30 seconds',
  // The openrouter slug absorbs the `/api/v1` prefix (same as the chat
  // binding), so the suffix is just `/models`. Keeps BYOK model refresh live.
  gateway: { provider: 'openrouter', pathSuffix: '/models' },
});

// --- Z.ai (OpenAI-compatible Chat Completions endpoint) ---

export const handleZaiChat = createStreamProxyHandler({
  name: 'Z.ai API',
  logTag: 'api/zai/chat',
  upstreamUrl: 'https://api.z.ai/api/paas/v4/chat/completions',
  timeoutMs: 180_000,
  maxOutputTokens: 65_536,
  buildAuth: standardAuth('ZAI_API_KEY'),
  keyMissingError:
    'Z.ai API key not configured. Add it in Settings or set ZAI_API_KEY on the Worker.',
  timeoutError: 'Z.ai request timed out after 180 seconds',
  // Bucket C custom provider (AIG v2 Path 1.5): base_url https://api.z.ai;
  // dormant until `zai` is registered + listed in CF_AI_GATEWAY_CUSTOM_SLUGS.
  gateway: { provider: 'custom-zai', pathSuffix: '/api/paas/v4/chat/completions' },
  formatUpstreamError: (status, bodyText) => ({
    error: `Z.ai ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
});

export async function handleZaiModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'ZaiCuratedModelsList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  return Response.json(
    { object: 'list', data: ZAI_MODELS.map((id) => ({ id, name: id })) },
    { headers: { [REQUEST_ID_HEADER]: preamble.requestId } },
  );
}

// --- Kimi (OpenAI-compatible Chat Completions endpoint) ---

const handleKimiChatProxy = createStreamProxyHandler({
  name: 'Kimi API',
  logTag: 'api/kimi/chat',
  upstreamUrl: 'https://api.moonshot.ai/v1/chat/completions',
  timeoutMs: 180_000,
  maxOutputTokens: 65_536,
  buildAuth: standardAuth('MOONSHOT_API_KEY', 'KIMI_API_KEY'),
  keyMissingError:
    'Kimi API key not configured. Add it in Settings or set MOONSHOT_API_KEY (or KIMI_API_KEY) on the Worker.',
  timeoutError: 'Kimi request timed out after 180 seconds',
  // Custom gateway provider with base_url https://api.moonshot.ai.
  // dormant until `kimi` is registered + listed in CF_AI_GATEWAY_CUSTOM_SLUGS.
  gateway: { provider: 'custom-moonshot', pathSuffix: '/v1/chat/completions' },
  formatUpstreamError: (status, bodyText) => ({
    error: `Kimi ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
});

export async function handleKimiChat(request: Request, env: Env): Promise<Response> {
  const parsed = (await request
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const model = typeof parsed?.model === 'string' ? parsed.model : '';
  const samplingRule = kimiSamplingRule(model);
  if (samplingRule && parsed) {
    if (samplingRule.mode === 'pinned') {
      parsed.temperature = samplingRule.temperature;
      parsed.top_p = samplingRule.topP;
    } else {
      // K3: sampling is fixed server-side; the docs say omit the fields.
      delete parsed.temperature;
      delete parsed.top_p;
    }
    request = new Request(request, { body: JSON.stringify(parsed) });
  }
  return handleKimiChatProxy(request, env);
}

export async function handleKimiModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'KimiCuratedModelsList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  return Response.json(
    { object: 'list', data: KIMI_MODELS.map((id) => ({ id, name: id })) },
    { headers: { [REQUEST_ID_HEADER]: preamble.requestId } },
  );
}

// --- Hugging Face Inference Providers router (OpenAI-compatible endpoint) ---

export const handleHuggingFaceChat = createStreamProxyHandler({
  name: 'Hugging Face API',
  logTag: 'api/huggingface/chat',
  upstreamUrl: 'https://router.huggingface.co/v1/chat/completions',
  timeoutMs: 180_000,
  maxOutputTokens: 65_536,
  buildAuth: standardAuth('HF_TOKEN', 'HUGGINGFACE_API_KEY'),
  keyMissingError:
    'Hugging Face token not configured. Add it in Settings or set HF_TOKEN (or HUGGINGFACE_API_KEY) on the Worker.',
  timeoutError: 'Hugging Face request timed out after 180 seconds',
  // Custom gateway provider with base_url https://router.huggingface.co —
  // AIG's FIRST-PARTY `huggingface` slug fronts the retired legacy Inference
  // API (api-inference.huggingface.co, dead origin; probed 2026-07-10), so the
  // router must go through a custom binding like Kimi/zai. Dormant until
  // `huggingface` is registered + listed in CF_AI_GATEWAY_CUSTOM_SLUGS.
  gateway: { provider: 'custom-huggingface', pathSuffix: '/v1/chat/completions' },
  formatUpstreamError: (status, bodyText) => ({
    error: `Hugging Face ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
});

export const handleHuggingFaceModels = createJsonProxyHandler({
  name: 'Hugging Face API',
  logTag: 'api/huggingface/models',
  upstreamUrl: 'https://router.huggingface.co/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('HF_TOKEN', 'HUGGINGFACE_API_KEY'),
  keyMissingError:
    'Hugging Face token not configured. Add it in Settings or set HF_TOKEN (or HUGGINGFACE_API_KEY) on the Worker.',
  timeoutError: 'Hugging Face model list timed out after 30 seconds',
  // Public catalog (keyless → full list). Routed direct rather than through
  // `custom-huggingface`, whose proxy truncates `/v1/models`. Chat keeps its
  // gateway binding. See handleOllamaModels for the rationale.
  publicList: true,
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
  // Bucket C custom provider (AIG v2 Path 1.5): base_url https://opencode.ai (the
  // /zen/... prefix lives in the path here); dormant until `zen` is registered +
  // listed in CF_AI_GATEWAY_CUSTOM_SLUGS.
  gateway: { provider: 'custom-zen', pathSuffix: '/zen/v1/chat/completions' },
  // Mirror the OpenRouter handler: route the upstream body through the shared
  // extractor (preserves the HTML 5xx guard) and tag 429s with the same
  // structured code the other native providers emit, so a Zen quota / rate
  // limit is classified the same way everywhere instead of falling through to
  // the default "API error <status>" passthrough (the PR #656 pattern).
  formatUpstreamError: (status, bodyText) => ({
    error: `OpenCode Zen ${status}: ${extractProviderHttpErrorDetail(status, bodyText)}`,
    code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
  }),
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
  // Public catalog (keyless → full list). Routed direct rather than through
  // `custom-zen`, whose proxy truncates `/v1/models`. Chat keeps its gateway
  // binding. See handleOllamaModels for the rationale.
  publicList: true,
});

// --- Fireworks AI (OpenAI Responses-native gateway) ---
//
// Fireworks exposes an OpenAI-compatible `/v1/responses` endpoint, so its chat
// route is Responses-native like direct OpenAI and Sakana — `handleFireworksChat`
// lives in the Responses section below and shares `handleResponsesProxy`. The
// model list stays on the plain `/v1/models` JSON listing here.

export const handleFireworksModels = createJsonProxyHandler({
  name: 'Fireworks AI API',
  logTag: 'api/fireworks/models',
  upstreamUrl: 'https://api.fireworks.ai/inference/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('FIREWORKS_API_KEY'),
  keyMissingError:
    'Fireworks AI API key not configured. Add it in Settings or set FIREWORKS_API_KEY on the Worker.',
  timeoutError: 'Fireworks AI model list timed out after 30 seconds',
  // Same binding as chat (base_url https://api.fireworks.ai; /inference prefix
  // in the path).
  gateway: { provider: 'custom-fireworks', pathSuffix: '/inference/v1/models' },
});

// --- DeepSeek (Anthropic Messages transport) ---
//
// DeepSeek exposes an Anthropic-compatible Messages endpoint at
// `api.deepseek.com/anthropic` (same `x-api-key` / `anthropic-version` headers
// as Anthropic). We route DeepSeek through the Anthropic transport rather than
// its OpenAI Chat Completions endpoint so thinking returns as signed reasoning
// blocks that round-trip across turns — the OpenAI endpoint's `reasoning_content`
// can't be replayed (DeepSeek 400s if you echo it back). Verified against the
// live endpoint: automatic prompt caching still applies here
// (`cache_read_input_tokens` populates on a repeat prefix) and `deepseek-v4-pro`
// emits signed `thinking` blocks by default that replay cleanly; only the
// explicit Anthropic `cache_control` directive is ignored, which we don't send.
const DEEPSEEK_ANTHROPIC_URL = 'https://api.deepseek.com/anthropic/v1/messages';

function buildDeepSeekAuth(env: Env, request: Request): string | null {
  const serverKey = env.DEEPSEEK_API_KEY;
  if (serverKey) return serverKey;
  // Dev / unconfigured-Worker fallback: accept a client-side Bearer key, same
  // shape as `buildAnthropicAuth`.
  const clientAuth = request.headers.get('Authorization');
  if (clientAuth?.startsWith('Bearer ')) return clientAuth.slice(7);
  return clientAuth;
}

export async function handleDeepSeekChat(request: Request, env: Env): Promise<Response> {
  const byok = gatewayByokActive(env, 'deepseek');
  const preamble = await runPreamble(request, env, {
    buildAuth: buildDeepSeekAuth,
    keyMissingError:
      'DeepSeek API key not configured. Add it in Settings or set DEEPSEEK_API_KEY on the Worker.',
    needsBody: true,
    allowMissingKey: byok,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

  // Dual-accept (push.stream.v1): the web client sends the neutral wire; the
  // background coder-job adapter sends the legacy OpenAI shape. Both converge on
  // an Anthropic Messages body.
  const dual = parseDualAcceptRequest(bodyText, {
    routeLabel: 'DeepSeek',
    maxOutputTokens: 8_192,
    provider: 'deepseek',
  });
  if (!dual.ok) return Response.json({ error: dual.error }, { status: dual.status });
  if (dual.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/deepseek/chat',
      adjustments: dual.adjustments,
    });
  }

  let upstreamBody: string;
  let model: string;
  if (dual.contractKind === 'neutral') {
    model = dual.request.model;
    try {
      upstreamBody = JSON.stringify(
        toAnthropicMessages(dual.request, {
          modelOverride: model,
          // DeepSeek's Anthropic endpoint has no server-side web_search tool, so
          // never enable it — no `pause_turn` continuation arises on this route.
          enableWebSearch: false,
        }),
      );
    } catch (err) {
      return Response.json(
        { error: `DeepSeek request: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  } else {
    model = typeof dual.parsed.model === 'string' ? dual.parsed.model.trim() : '';
    if (!model) {
      return Response.json({ error: 'DeepSeek request is missing a model id' }, { status: 400 });
    }
    upstreamBody = JSON.stringify({ ...buildAnthropicMessagesRequest(dual.parsed), model });
  }

  wlog('info', 'request', {
    requestId,
    route: 'api/deepseek/chat',
    model,
    contract: dual.contractKind,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;
    try {
      // AIG Bucket B: deepseek is a first-party gateway provider whose
      // provider-native proxy passes Push's non-standard `/anthropic` variant
      // (verified 2026-07-09 — gateway 200 byte-identical to direct). Derive the
      // pathSuffix from DEEPSEEK_ANTHROPIC_URL so the two can't drift. No-op
      // unless CF_AI_GATEWAY_* is set; `x-api-key` still flows to deepseek.
      const deepseekDirect = new URL(DEEPSEEK_ANTHROPIC_URL);
      const { upstreamUrl: deepseekUpstream, gatewayHeaders } = resolveAiGatewayFetchTarget(
        env,
        DEEPSEEK_ANTHROPIC_URL,
        { provider: 'deepseek', pathSuffix: `${deepseekDirect.pathname}${deepseekDirect.search}` },
      );
      upstream = await fetch(deepseekUpstream, {
        method: 'POST',
        headers: {
          // BYOK omits x-api-key so the gateway injects the stored deepseek key.
          ...(byok ? {} : { 'x-api-key': apiKey }),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
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
        route: 'api/deepseek/chat',
        status: upstream.status,
        body: errBody.slice(0, 500),
      });
      return Response.json(
        {
          error: `DeepSeek ${upstream.status}: ${extractProviderHttpErrorDetail(upstream.status, errBody)}`,
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
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
      route: 'api/deepseek/chat',
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'DeepSeek request timed out after 180 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export const handleDeepSeekModels = createJsonProxyHandler({
  name: 'DeepSeek API',
  logTag: 'api/deepseek/models',
  upstreamUrl: 'https://api.deepseek.com/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('DEEPSEEK_API_KEY'),
  keyMissingError:
    'DeepSeek API key not configured. Add it in Settings or set DEEPSEEK_API_KEY on the Worker.',
  timeoutError: 'DeepSeek model list timed out after 30 seconds',
  // First-party deepseek slug maps to api.deepseek.com's root (the chat
  // binding's /anthropic/v1/messages passthrough proved it), so the suffix
  // mirrors the direct path.
  gateway: { provider: 'deepseek', pathSuffix: '/models' },
});

// --- Sakana AI (Fugu orchestration) ---
//
// Sakana Fugu speaks the OpenAI Responses API, so `handleSakanaChat` lives in
// the shared Responses section below (next to direct OpenAI). Only the model
// list proxy stays here.

export const handleSakanaModels = createJsonProxyHandler({
  name: 'Sakana AI API',
  logTag: 'api/sakana/models',
  upstreamUrl: 'https://api.sakana.ai/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('SAKANA_API_KEY'),
  keyMissingError:
    'Sakana AI API key not configured. Add it in Settings or set SAKANA_API_KEY on the Worker.',
  timeoutError: 'Sakana AI model list timed out after 30 seconds',
  // Same binding as chat (base_url https://api.sakana.ai).
  gateway: { provider: 'custom-sakana', pathSuffix: '/v1/models' },
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
  // Gateway targets per transport (custom-zen binding: base_url
  // https://opencode.ai, full path in the suffix). BYOK keyless routing
  // applies to the OPENAI transport only: the gateway's stored-key injection
  // sets `Authorization`, which `/zen/go/v1/chat/completions` accepts but
  // `/zen/go/v1/messages` does not (Anthropic convention — it wants
  // `x-api-key`; probed 2026-07-09: keyless via gateway → 200 on
  // chat/completions, 401 "Missing API key" on messages). Anthropic-transport
  // models therefore still require a caller/Worker key, which flows through
  // the gateway as passthrough when the slug is enabled.
  const openaiTarget = resolveAiGatewayFetchTarget(
    env,
    'https://opencode.ai/zen/go/v1/chat/completions',
    { provider: 'custom-zen', pathSuffix: '/zen/go/v1/chat/completions' },
  );
  const anthropicTarget = resolveAiGatewayFetchTarget(
    env,
    'https://opencode.ai/zen/go/v1/messages',
    { provider: 'custom-zen', pathSuffix: '/zen/go/v1/messages' },
  );
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth('ZEN_API_KEY'),
    keyMissingError:
      'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
    needsBody: true,
    // Keyless is viable on the openai-transport path (gateway injects) and on
    // the anthropic-transport path when the ZEN_KEY_STORE binding can resolve
    // the key; the transport is known only after the body parses, so a truly
    // unservable keyless request is rejected below instead of here.
    allowMissingKey: openaiTarget.byok || Boolean(env.ZEN_KEY_STORE),
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText, requestId } = preamble;

  // Dual-accept (push.stream.v1): a body carrying a `contract` field is the
  // neutral wire shape serialized straight from PushStreamRequest; anything else
  // is the legacy OpenAI Chat Completions shape. Zen-Go is the one client NOT
  // yet flipped — `zenStream` (`app/src/lib/zen-stream.ts`) still builds the
  // OpenAI body for the Go endpoint, so the neutral branch here stays dormant
  // until that flip. See
  // docs/runbooks/Anthropic Worker Contract Migration.md.
  const dual = parseDualAcceptRequest(bodyText, {
    routeLabel: 'OpenCode Zen Go',
    maxOutputTokens: 12_288,
    provider: 'zen',
  });
  if (!dual.ok) {
    return Response.json({ error: dual.error }, { status: dual.status });
  }
  if (dual.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/zen/go/chat',
      adjustments: dual.adjustments,
    });
  }

  // Both contract kinds converge on `{ model, transport, upstreamBody }`. Zen-Go's
  // `/v1/messages` is a single fixed URL shared by every Anthropic-transport
  // model (the MiniMax + Qwen families), so — unlike Vertex, which carries the
  // model in the URL path — it can only learn the model from the body. We
  // therefore emit `model` in the body on both branches, mirroring the native
  // Anthropic handler below. The OpenAI-compat transport serializes the neutral
  // request via `toOpenAIChat`; the legacy path forwards the validated raw body
  // verbatim (which already carries `model`).
  const model =
    dual.contractKind === 'neutral'
      ? dual.request.model.trim()
      : typeof dual.parsed.model === 'string'
        ? dual.parsed.model.trim()
        : '';
  const transport = getZenGoTransport(model);
  const target = transport === 'anthropic' ? anthropicTarget : openaiTarget;
  // BYOK precedence matches the shared handlers: when the gateway holds the
  // key and the route is gatewayed, dispatch keyless and let the gateway
  // inject — a lingering ZEN_API_KEY secret does not outrank the gateway key.
  const byok = transport !== 'anthropic' && openaiTarget.byok;
  // Anthropic transport can't use gateway injection (x-api-key, not
  // Authorization) — but the SAME Secrets Store entry the gateway injects
  // from is bound to the Worker (ZEN_KEY_STORE), so resolve it here and send
  // proper headers ourselves. One custody point; the request still transits
  // the gateway as passthrough for observability. Caller/Worker keys keep
  // precedence: the binding only fills a keyless request.
  let effectiveAuthHeader = authHeader;
  if (transport === 'anthropic' && !effectiveAuthHeader && env.ZEN_KEY_STORE) {
    try {
      const storeKey = (await env.ZEN_KEY_STORE.get())?.trim();
      if (storeKey) {
        effectiveAuthHeader = `Bearer ${storeKey}`;
        wlog('info', 'zen_go_store_key_used', { requestId, route: 'api/zen/go/chat' });
      } else {
        wlog('warn', 'zen_go_store_key_empty', { requestId, route: 'api/zen/go/chat' });
      }
    } catch (err) {
      // Fall through to the 401 below — loudly, so an unreadable binding is
      // distinguishable from "no binding configured".
      wlog('warn', 'zen_go_store_key_failed', {
        requestId,
        route: 'api/zen/go/chat',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (transport === 'anthropic' && !effectiveAuthHeader) {
    // Keyless request admitted by allowMissingKey, but this model's transport
    // can't use the gateway-stored key (x-api-key, not Authorization) and no
    // other key source resolved.
    return Response.json(
      {
        error:
          'OpenCode Zen API key not configured. Anthropic-transport Zen Go models (MiniMax/Qwen families) cannot use the gateway-injected key — add a Zen key in Settings, set ZEN_API_KEY, or bind ZEN_KEY_STORE.',
      },
      { status: 401 },
    );
  }
  const upstreamUrl = target.upstreamUrl;

  let upstreamBody: string;
  if (dual.contractKind === 'neutral') {
    try {
      // toAnthropicMessages / toOpenAIChat throw loudly on a content part they
      // can't represent. Map that to a 400 rather than the 502 upstream catch.
      upstreamBody =
        transport === 'anthropic'
          ? JSON.stringify(
              toAnthropicMessages(dual.request, {
                enableWebSearch: dual.request.anthropicWebSearch === true,
              }),
            )
          : // `includeUsage` restores the `stream_options: { include_usage: true }`
            // the legacy guardrail validator defaulted before forwarding — without
            // it the neutral flip drops the trailing usage chunk (token/cache
            // accounting) for OpenAI-transport Zen-Go streams. The fallback gate
            // backfills a placeholder thought_signature for a Gemini-fronted model
            // (Zen-Go also routes non-Gemini openai-transport models → gated).
            JSON.stringify(
              toOpenAIChat(dual.request, {
                includeUsage: true,
                geminiThoughtSignatureFallback: isGeminiModelId(model),
              }),
            );
    } catch (err) {
      return Response.json(
        { error: `OpenCode Zen Go request: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  } else {
    upstreamBody =
      transport === 'anthropic'
        ? JSON.stringify({ ...buildAnthropicMessagesRequest(dual.parsed), model })
        : dual.bodyText;
  }

  wlog('info', 'request', {
    requestId,
    route: 'api/zen/go/chat',
    transport,
    model,
    contract: dual.contractKind,
    bytes: upstreamBody.length,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        // BYOK: omit the provider auth entirely (the gateway injects the
        // stored key); gatewayHeaders carries cf-aig-authorization whenever
        // the URL actually routes through the gateway (passthrough included).
        headers: {
          ...(byok
            ? { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId }
            : getZenGoAuthHeaders(effectiveAuthHeader, requestId, transport)),
          ...target.gatewayHeaders,
        },
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
        {
          error: `OpenCode Zen Go API error ${upstream.status}: ${errDetail}`,
          // Tag 429s like the native providers so a Go-tier quota / rate limit
          // is classified the same way everywhere (see handleZenChat above).
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
    }

    // Both transports proxy the raw upstream SSE straight through. The
    // Anthropic-transport models (MiniMax / Qwen on `/v1/messages`) emit standard
    // Anthropic Messages SSE; every Zen-Go client now parses it natively — the
    // foreground `zenStream` via `anthropicEventStream`, the background coder /
    // PR-review job via the stream adapter's native branch — so there's no
    // OpenAI-SSE translator left on this route (parity with the direct Anthropic
    // route).
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

// --- OpenRouter + OpenAI + xAI + Sakana + Fireworks (/v1/responses) ---
//
// These providers are Responses-native adapters sharing one proxy
// (`handleResponsesProxy`), parameterized only by upstream URL, env secret, and
// error labels. Do not route any through the generic Chat proxy: that factory
// validates and normalizes Chat Completions fields (`messages`,
// `response_format`, `max_completion_tokens`), while this path must preserve
// Responses fields (`input`, `text.format`, `max_output_tokens`) for the
// provider-native contract.

const OPENAI_RESPONSES_UPSTREAM_URL = 'https://api.openai.com/v1/responses';
const OPENROUTER_RESPONSES_UPSTREAM_URL = 'https://openrouter.ai/api/v1/responses';
const XAI_RESPONSES_UPSTREAM_URL = 'https://api.x.ai/v1/responses';
const SAKANA_RESPONSES_UPSTREAM_URL = 'https://api.sakana.ai/v1/responses';
const FIREWORKS_RESPONSES_UPSTREAM_URL = 'https://api.fireworks.ai/inference/v1/responses';
const RESPONSES_TIMEOUT_MS = 120_000;
const RESPONSES_MAX_OUTPUT_TOKENS = 12_288;

function validateAndNormalizeResponsesRequest(
  bodyText: string,
  providerLabel: string,
):
  | { ok: true; bodyText: string; model: string; adjustments: string[] }
  | {
      ok: false;
      status: number;
      error: string;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, error: `${providerLabel} request body must be valid JSON.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      error: `${providerLabel} request body must be a JSON object.`,
    };
  }
  const body = { ...(parsed as Record<string, unknown>) };
  const model = typeof body.model === 'string' && body.model.trim() ? body.model : 'unknown';
  if (!Array.isArray(body.input) && typeof body.input !== 'string') {
    return {
      ok: false,
      status: 400,
      error: `${providerLabel} Responses request field "input" must be a string or item array.`,
    };
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return {
      ok: false,
      status: 400,
      error: `${providerLabel} request field "stream" must be a boolean.`,
    };
  }
  const adjustments: string[] = [];
  if (body.stream !== true) {
    body.stream = true;
    adjustments.push('forced_stream');
  }
  if (body.store !== false) {
    body.store = false;
    adjustments.push('forced_store_false');
  }
  if (body.max_output_tokens !== undefined) {
    if (
      typeof body.max_output_tokens !== 'number' ||
      !Number.isInteger(body.max_output_tokens) ||
      body.max_output_tokens < 1
    ) {
      return {
        ok: false,
        status: 400,
        error: `${providerLabel} request field "max_output_tokens" must be a positive integer.`,
      };
    }
    if (body.max_output_tokens > RESPONSES_MAX_OUTPUT_TOKENS) {
      body.max_output_tokens = RESPONSES_MAX_OUTPUT_TOKENS;
      adjustments.push('max_output_tokens_clamped');
    }
  }
  for (const field of ['temperature', 'top_p'] as const) {
    if (
      body[field] !== undefined &&
      (typeof body[field] !== 'number' || !Number.isFinite(body[field]))
    ) {
      return {
        ok: false,
        status: 400,
        error: `${providerLabel} request field "${field}" must be a number.`,
      };
    }
  }
  return { ok: true, bodyText: JSON.stringify(body), model, adjustments };
}

interface ResponsesProxyOptions {
  providerLabel: string;
  authSecret:
    | 'OPENAI_API_KEY'
    | 'OPENROUTER_API_KEY'
    | 'XAI_API_KEY'
    | 'SAKANA_API_KEY'
    | 'FIREWORKS_API_KEY';
  keyMissingError: string;
  upstreamUrl: string;
  route: string;
  timeoutError: string;
  extraFetchHeaders?: Record<string, string> | ((request: Request) => Record<string, string>);
  gateway?: AiGatewayBinding;
}

function resolveAiGatewayFetchTarget(
  env: Env,
  directUrl: string,
  gateway?: AiGatewayBinding,
): { upstreamUrl: string; gatewayHeaders: Record<string, string>; byok: boolean } {
  const gatewayUrl = gateway ? buildAiGatewayUrl(env, gateway) : null;
  const aigAuth = gatewayUrl ? getAiGatewayAuthHeader(env) : null;
  return {
    upstreamUrl: gatewayUrl ?? directUrl,
    gatewayHeaders: aigAuth ? { 'cf-aig-authorization': aigAuth } : {},
    // BYOK is only real when the request actually routes through the gateway:
    // a BYOK-listed custom binding whose slug isn't enabled falls back to the
    // direct URL above, where a keyless call 401s at the upstream — callers
    // must keep sending the key (and keep the key-missing gate) in that case.
    byok: gatewayUrl !== null && gateway ? isGatewayByokProvider(env, gateway.provider) : false,
  };
}

/**
 * BYOK is only safe to act on (omit the provider auth header, skip the
 * key-missing fallback) when a keyless call would ACTUALLY route through the
 * gateway — `buildAiGatewayUrl` resolving (account + slug set; and for a custom
 * binding, its slug enabled) — AND the provider is BYOK-listed. Otherwise the
 * request falls back to the direct provider, where a keyless call 401s, so the
 * caller must keep sending the key. Mirrors the `resolveAiGatewayFetchTarget`
 * gate for handlers that need the decision before the fetch (allowMissingKey).
 * `gatewaySlug` is the CF gateway binding string, which differs from the
 * canonical BYOK id for google (`google-ai-studio` vs `google`).
 */
export function gatewayByokActive(env: Env, byokId: string, gatewaySlug: string = byokId): boolean {
  return (
    buildAiGatewayUrl(env, { provider: gatewaySlug, pathSuffix: '' }) !== null &&
    isGatewayByokProvider(env, byokId)
  );
}

/**
 * Shared `/v1/responses` reverse proxy for the Responses-native providers
 * (OpenRouter, direct OpenAI, Sakana Fugu, Fireworks AI). Runs the standard
 * preamble (origin check + rate-limit + auth), normalizes the Responses body
 * (forces `stream:true` / `store:false`, clamps `max_output_tokens`,
 * type-checks numerics), then pipes the typed Responses SSE stream back
 * unchanged.
 */
async function handleResponsesProxy(
  request: Request,
  env: Env,
  opts: ResponsesProxyOptions,
): Promise<Response> {
  // BYOK: when this provider's key is stored in the gateway, route keyless and
  // let the gateway inject it (omit Authorization below, skip the key gate).
  // The resolver ties byok to the gateway URL actually resolving — for a
  // custom binding (sakana/fireworks here) whose slug isn't enabled, the fetch
  // goes DIRECT, so the key must keep flowing and the key gate must stay on.
  const { upstreamUrl, gatewayHeaders, byok } = resolveAiGatewayFetchTarget(
    env,
    opts.upstreamUrl,
    opts.gateway,
  );
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth(opts.authSecret),
    keyMissingError: opts.keyMissingError,
    needsBody: true,
    allowMissingKey: byok,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText, requestId, spanCtx } = preamble;
  const normalized = validateAndNormalizeResponsesRequest(bodyText, opts.providerLabel);
  if (!normalized.ok) {
    return Response.json({ error: normalized.error }, { status: normalized.status });
  }
  if (normalized.adjustments.length > 0) {
    wlog('warn', 'responses_request_adjusted', {
      requestId,
      route: opts.route,
      adjustments: normalized.adjustments,
    });
  }

  wlog('info', 'request', {
    requestId,
    route: opts.route,
    bytes: normalized.bodyText.length,
    model: normalized.model,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESPONSES_TIMEOUT_MS);
  const upstreamCtx = createChildContext(spanCtx);
  const extraHeaders =
    typeof opts.extraFetchHeaders === 'function'
      ? opts.extraFetchHeaders(request)
      : (opts.extraFetchHeaders ?? {});
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // BYOK omits Authorization so the gateway injects the stored provider key.
        ...(byok ? {} : { Authorization: authHeader }),
        [REQUEST_ID_HEADER]: requestId,
        traceparent: buildTraceparent(upstreamCtx),
        ...extraHeaders,
        ...gatewayHeaders,
      },
      body: normalized.bodyText,
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = err instanceof Error ? err.message : String(err);
    wlog('error', 'unhandled', {
      requestId,
      route: opts.route,
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? opts.timeoutError : message },
      { status: isTimeout ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  wlog('info', 'upstream_ok', {
    requestId,
    route: opts.route,
    status: upstream.status,
    trace_id: spanCtx.traceId,
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    wlog('error', 'upstream_error', {
      requestId,
      route: opts.route,
      status: upstream.status,
      body: errBody.slice(0, 500),
    });
    return Response.json(
      {
        error: `${opts.providerLabel} ${upstream.status}: ${extractProviderHttpErrorDetail(upstream.status, errBody)}`,
        code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
      },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      [REQUEST_ID_HEADER]: requestId,
      'X-Push-Trace-Id': spanCtx.traceId,
      'X-Push-Span-Id': spanCtx.spanId,
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function handleOpenRouterResponses(request: Request, env: Env): Promise<Response> {
  return handleResponsesProxy(request, env, {
    providerLabel: 'OpenRouter',
    authSecret: 'OPENROUTER_API_KEY',
    keyMissingError: OPENROUTER_KEY_MISSING_ERROR,
    upstreamUrl: OPENROUTER_RESPONSES_UPSTREAM_URL,
    route: 'api/openrouter/chat',
    timeoutError: 'OpenRouter request timed out after 120 seconds',
    extraFetchHeaders: openRouterExtraFetchHeaders,
    gateway: { provider: 'openrouter', pathSuffix: '/responses' },
  });
}

export async function handleOpenAIChat(request: Request, env: Env): Promise<Response> {
  return handleResponsesProxy(request, env, {
    providerLabel: 'OpenAI',
    authSecret: 'OPENAI_API_KEY',
    keyMissingError:
      'OpenAI API key not configured. Add it in Settings or set OPENAI_API_KEY on the Worker.',
    upstreamUrl: OPENAI_RESPONSES_UPSTREAM_URL,
    route: 'api/openai/chat',
    timeoutError: 'OpenAI request timed out after 120 seconds',
    gateway: { provider: 'openai', pathSuffix: '/responses' },
  });
}

export async function handleXAIChat(request: Request, env: Env): Promise<Response> {
  return handleResponsesProxy(request, env, {
    providerLabel: 'xAI',
    authSecret: 'XAI_API_KEY',
    keyMissingError:
      'xAI API key not configured. Add it in Settings or set XAI_API_KEY on the Worker.',
    upstreamUrl: XAI_RESPONSES_UPSTREAM_URL,
    route: 'api/xai/chat',
    timeoutError: 'xAI request timed out after 120 seconds',
    // xAI is a FIRST-PARTY AI Gateway provider (`grok`, proxying api.x.ai) — not
    // a custom slug. So it routes via `/grok/v1/responses` (Responses API
    // verified 200 through the gateway) and needs only CF_AI_GATEWAY_BYOK (no
    // CUSTOM_SLUGS). The gateway's provider name is `grok`, which is the byok
    // id the Responses factory checks against CF_AI_GATEWAY_BYOK.
    gateway: { provider: 'grok', pathSuffix: '/v1/responses' },
  });
}

export async function handleSakanaChat(request: Request, env: Env): Promise<Response> {
  return handleResponsesProxy(request, env, {
    providerLabel: 'Sakana AI',
    authSecret: 'SAKANA_API_KEY',
    keyMissingError:
      'Sakana AI API key not configured. Add it in Settings or set SAKANA_API_KEY on the Worker.',
    upstreamUrl: SAKANA_RESPONSES_UPSTREAM_URL,
    route: 'api/sakana/chat',
    timeoutError: 'Sakana AI request timed out after 120 seconds',
    // Bucket C custom provider (AIG v2 Path 1.5), Responses-native: base_url
    // https://api.sakana.ai; dormant until `sakana` is registered + listed in
    // CF_AI_GATEWAY_CUSTOM_SLUGS.
    gateway: { provider: 'custom-sakana', pathSuffix: '/v1/responses' },
  });
}

export async function handleFireworksChat(request: Request, env: Env): Promise<Response> {
  return handleResponsesProxy(request, env, {
    providerLabel: 'Fireworks AI',
    authSecret: 'FIREWORKS_API_KEY',
    keyMissingError:
      'Fireworks AI API key not configured. Add it in Settings or set FIREWORKS_API_KEY on the Worker.',
    upstreamUrl: FIREWORKS_RESPONSES_UPSTREAM_URL,
    route: 'api/fireworks/chat',
    timeoutError: 'Fireworks AI request timed out after 120 seconds',
    // Bucket C custom provider (AIG v2 Path 1.5), Responses-native: base_url
    // https://api.fireworks.ai (the /inference prefix lives in the path here);
    // dormant until `fireworks` is registered + listed in CF_AI_GATEWAY_CUSTOM_SLUGS.
    gateway: { provider: 'custom-fireworks', pathSuffix: '/inference/v1/responses' },
  });
}

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
  // Legacy embedding-search families: text-search-ada-doc-001,
  // text-search-curie-query-001, etc. Anchored to ^text-search- so it
  // does NOT match chat-capable search-preview models like
  // gpt-4o-search-preview / gpt-4o-mini-search-preview, which route
  // through /v1/chat/completions just like any other chat model.
  /^text-search-/,
  /^code-/,
  // Legacy completions-only "-instruct" models (gpt-3.5-turbo-instruct,
  // gpt-3.5-turbo-instruct-0914). These do NOT accept /v1/chat/completions
  // requests, so letting them through the dropdown would surface a
  // selection that fails at chat time. Anchored to a hyphen boundary so a
  // hypothetical chat model with "instruct" as a substring (e.g.
  // gpt-N-instructive) wouldn't be caught.
  /(?:^|-)instruct(?:-|$)/,
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

  // BYOK: the gateway injects the stored openai key, so the live list stays
  // reachable with no key anywhere client- or Worker-side. Otherwise a
  // resolvable key goes direct; no key at all falls back to curated.
  const byok = gatewayByokActive(env, 'openai');
  const apiKey = byok ? null : resolveDirectProviderKey(env.OPENAI_API_KEY, request);
  if (!byok && !apiKey) {
    return curatedOpenAIModelsResponse(requestId);
  }
  // The openai slug absorbs the /v1 prefix (same as the chat binding's
  // `/responses` suffix), so the suffix is just `/models`.
  const { upstreamUrl, gatewayHeaders } = byok
    ? resolveAiGatewayFetchTarget(env, OPENAI_MODELS_URL, {
        provider: 'openai',
        pathSuffix: '/models',
      })
    : { upstreamUrl: OPENAI_MODELS_URL, gatewayHeaders: {} as Record<string, string> };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          // BYOK omits Authorization so the gateway injects the stored key.
          ...(byok ? {} : { Authorization: `Bearer ${apiKey}` }),
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
        },
        signal: controller.signal,
        // Skip the edge cache so each refresh reflects the live catalog (see
        // the GET note in createJsonProxyHandler for the stale-list rationale).
        cache: 'no-store',
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

const XAI_MODELS_URL = 'https://api.x.ai/v1/models';

export async function handleXAIModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: () => 'XAIModelsList',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;
  const { requestId } = preamble;

  const byok = gatewayByokActive(env, 'grok');
  const apiKey = byok ? null : resolveDirectProviderKey(env.XAI_API_KEY, request);
  if (!byok && !apiKey) {
    return curatedXAIModelsResponse(requestId);
  }
  const { upstreamUrl, gatewayHeaders } = byok
    ? resolveAiGatewayFetchTarget(env, XAI_MODELS_URL, {
        provider: 'grok',
        pathSuffix: '/v1/models',
      })
    : { upstreamUrl: XAI_MODELS_URL, gatewayHeaders: {} as Record<string, string> };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_MODELS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          ...(byok ? {} : { Authorization: `Bearer ${apiKey}` }),
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
        },
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      wlog('warn', 'upstream_error_fallback', {
        requestId,
        route: 'api/xai/models',
        status: upstream.status,
        body: body.slice(0, 300),
      });
      return curatedXAIModelsResponse(requestId);
    }

    const json = (await upstream.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
    const upstreamData = Array.isArray(json?.data) ? json!.data : [];
    const filtered = upstreamData
      .map((entry) => (entry && typeof entry === 'object' ? entry.id : null))
      .filter((id): id is string => typeof id === 'string' && id.trim().startsWith('grok-'))
      .map((id) => ({ id, name: id }));

    if (filtered.length === 0) {
      wlog('warn', 'empty_after_filter_fallback', {
        requestId,
        route: 'api/xai/models',
        upstreamCount: upstreamData.length,
      });
      return curatedXAIModelsResponse(requestId);
    }

    return Response.json(
      { object: 'list', data: filtered },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('warn', isTimeout ? 'upstream_timeout_fallback' : 'unhandled_fallback', {
      requestId,
      route: 'api/xai/models',
      message: err instanceof Error ? err.message : String(err),
      timeout: isTimeout,
    });
    return curatedXAIModelsResponse(requestId);
  }
}

function curatedXAIModelsResponse(requestId: string): Response {
  return Response.json(
    { object: 'list', data: XAI_MODELS.map((id) => ({ id, name: id })) },
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
// Native-Anthropic transport path: auth is a flat `x-api-key` header, and the
// `anthropic_version` goes in the header rather than the body. Reuses
// `buildAnthropicMessagesRequest` from the bridge; the raw
// Anthropic SSE is proxied straight to the client, which parses it with the
// native `anthropicEventStream` (no OpenAI-shaped intermediate).

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
  // BYOK: when anthropic's key is stored in the gateway, the caller sends no
  // key and the gateway injects it — so don't 401 on a missing key and omit the
  // x-api-key header below.
  const byok = gatewayByokActive(env, 'anthropic');
  const preamble = await runPreamble(request, env, {
    buildAuth: buildAnthropicAuth,
    keyMissingError:
      'Anthropic API key not configured. Add it in Settings or set ANTHROPIC_API_KEY on the Worker.',
    needsBody: true,
    allowMissingKey: byok,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

  const policy = {
    routeLabel: 'Anthropic',
    maxOutputTokens: 12_288,
    provider: 'anthropic',
  } as const;

  // Dual-accept (push.stream.v1): a body carrying a `contract` field is the
  // neutral wire shape, serialized straight from PushStreamRequest; anything
  // else is the legacy OpenAI Chat Completions shape. The web client sends
  // neutral since the #852 flip, so a legacy body here is a pre-flip tab; the
  // legacy branch retires at Step 5 once the `request` log's `contract` field
  // reads zero legacy. See
  // docs/runbooks/Anthropic Worker Contract Migration.md.
  const dual = parseDualAcceptRequest(bodyText, policy);
  if (!dual.ok) {
    return Response.json({ error: dual.error }, { status: dual.status });
  }
  if (dual.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/anthropic/chat',
      adjustments: dual.adjustments,
    });
  }

  // Both branches converge on `{ upstreamBody, model }`. The version stays a
  // header (the direct Anthropic API ignores any body `anthropic_version`),
  // and `model` is re-attached into the body because the direct `/v1/messages`
  // endpoint requires it there.
  let upstreamBody: string;
  let model: string;

  if (dual.contractKind === 'neutral') {
    model = dual.request.model;
    try {
      // `toAnthropicMessages` includes `model` and throws loudly on a content
      // part it can't represent (e.g. a non-data/non-http image URL). Map that
      // to a 400 rather than letting it fall through to the 502 upstream catch.
      upstreamBody = JSON.stringify(
        toAnthropicMessages(dual.request, {
          modelOverride: model,
          enableWebSearch: dual.request.anthropicWebSearch === true,
          // Pause-turn continuation: the client replays prior paused assistant
          // content[] here (web-search iteration-cap resumption). Appended as
          // trailing assistant turns by toAnthropicMessages.
          replayAssistantTurns: dual.request.replayAssistantTurns,
        }),
      );
    } catch (err) {
      return Response.json(
        { error: `Anthropic request: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  } else {
    model = typeof dual.parsed.model === 'string' ? dual.parsed.model.trim() : '';
    if (!model) {
      return Response.json({ error: 'Anthropic request is missing a model id' }, { status: 400 });
    }
    upstreamBody = JSON.stringify({
      ...buildAnthropicMessagesRequest(dual.parsed),
      model,
    });
  }

  // Symmetric log on both branches — `contract` lets ops measure how much
  // traffic still uses the legacy shape before the legacy branch is dropped.
  wlog('info', 'request', {
    requestId,
    route: 'api/anthropic/chat',
    model,
    contract: dual.contractKind,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      const { upstreamUrl, gatewayHeaders } = resolveAiGatewayFetchTarget(
        env,
        ANTHROPIC_MESSAGES_URL,
        { provider: 'anthropic', pathSuffix: '/v1/messages' },
      );
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          // BYOK omits x-api-key so the gateway injects the stored anthropic key.
          ...(byok ? {} : { 'x-api-key': apiKey }),
          'anthropic-version': ANTHROPIC_API_VERSION,
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
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
// Google's Generative Language API with `x-goog-api-key`, then proxies the raw
// upstream SSE straight to the client, which parses it with the native
// `geminiEventStream` (no OpenAI-shaped intermediate).
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
  const byok = gatewayByokActive(env, 'google', 'google-ai-studio');
  const preamble = await runPreamble(request, env, {
    buildAuth: buildGoogleAuth,
    keyMissingError:
      'Google Gemini API key not configured. Add it in Settings or set GOOGLE_API_KEY on the Worker.',
    needsBody: true,
    allowMissingKey: byok,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

  // Dual-accept (push.stream.v1): neutral wire serialized via
  // `toGeminiGenerateContent`, else the legacy OpenAI→Gemini translation. The
  // web client sends neutral since the #853 flip, so a legacy body here is a
  // pre-flip tab; the legacy branch retires at Step 5 once the `request` log's
  // `contract` field reads zero legacy. See
  // docs/runbooks/Anthropic Worker Contract Migration.md.
  const dual = parseDualAcceptRequest(bodyText, {
    routeLabel: 'Google Gemini',
    maxOutputTokens: 12_288,
    provider: 'google',
  });
  if (!dual.ok) {
    return Response.json({ error: dual.error }, { status: dual.status });
  }
  if (dual.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/google/chat',
      adjustments: dual.adjustments,
    });
  }

  let model: string;
  let upstreamBody: string;
  if (dual.contractKind === 'neutral') {
    model = dual.request.model;
    try {
      // `toGeminiGenerateContent` throws loudly on a content part it can't
      // represent (Gemini inline images require a base64 data: URL) — a 400,
      // not a 502 from the upstream catch.
      upstreamBody = JSON.stringify(
        toGeminiGenerateContent(dual.request, {
          enableGoogleSearch: dual.request.googleSearchGrounding === true,
        }),
      );
    } catch (err) {
      return Response.json(
        { error: `Google request: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  } else {
    model = typeof dual.parsed.model === 'string' ? dual.parsed.model.trim() : '';
    if (!model) {
      return Response.json({ error: 'Google request is missing a model id' }, { status: 400 });
    }
    upstreamBody = JSON.stringify(buildGeminiGenerateContentRequest(dual.parsed));
  }

  // Gemini puts the model in the URL path and selects SSE framing via
  // `?alt=sse`. Auth is the API key in the `x-goog-api-key` header (preferred
  // over the legacy `?key=` query-param so the secret stays out of access logs).
  const directUpstreamUrl = `${GOOGLE_API_BASE}/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse`;
  // The AIG google-ai-studio proxy base is generativelanguage.googleapis.com
  // (no version), so the API version lives in the path we supply. Derive the
  // gateway path from the direct upstream URL so it always mirrors
  // GOOGLE_API_BASE's version — a hardcoded `/v1/` had drifted from the
  // `/v1beta` direct call, routing gateway traffic to a different API surface.
  const directUpstream = new URL(directUpstreamUrl);
  const { upstreamUrl, gatewayHeaders } = resolveAiGatewayFetchTarget(env, directUpstreamUrl, {
    provider: 'google-ai-studio',
    pathSuffix: `${directUpstream.pathname}${directUpstream.search}`,
  });

  wlog('info', 'request', {
    requestId,
    route: 'api/google/chat',
    model,
    contract: dual.contractKind,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          // BYOK omits x-goog-api-key so the gateway injects the stored google key.
          ...(byok ? {} : { 'x-goog-api-key': apiKey }),
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
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

  // BYOK: the gateway injects the stored google key — see handleOpenAIModels
  // for the fallback ordering (byok → gateway keyless; key → direct; neither
  // → curated).
  const byok = gatewayByokActive(env, 'google', 'google-ai-studio');
  const apiKey = byok ? null : resolveDirectProviderKey(env.GOOGLE_API_KEY, request);
  if (!byok && !apiKey) {
    return curatedGoogleModelsResponse(requestId);
  }
  // The google-ai-studio proxy base carries no API version — derive the
  // gateway path from the direct URL so it always mirrors GOOGLE_API_BASE's
  // version (the #1376 lesson; a hardcoded /v1/ drifted from /v1beta).
  const directModelsUrl = `${GOOGLE_API_BASE}/models?pageSize=200`;
  const directModels = new URL(directModelsUrl);
  const { upstreamUrl, gatewayHeaders } = byok
    ? resolveAiGatewayFetchTarget(env, directModelsUrl, {
        provider: 'google-ai-studio',
        pathSuffix: `${directModels.pathname}${directModels.search}`,
      })
    : { upstreamUrl: directModelsUrl, gatewayHeaders: {} as Record<string, string> };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOOGLE_MODELS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          // BYOK omits x-goog-api-key so the gateway injects the stored key.
          ...(byok ? {} : { 'x-goog-api-key': apiKey as string }),
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
        },
        signal: controller.signal,
        // Skip the edge cache so each refresh reflects the live catalog (see
        // the GET note in createJsonProxyHandler for the stale-list rationale).
        cache: 'no-store',
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

// --- Gemini-grounded web search (one-shot generateContent + googleSearch tool) ---

const GROUNDING_DEFAULT_MODEL = 'gemini-3.5-flash';
const GROUNDING_TIMEOUT_MS = 30_000;

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

/**
 * Pulls grounded answer text + cited sources out of a Gemini `:generateContent`
 * response. Each `groundingChunks[i].web` carries `{uri, title}` for one cited
 * source; Gemini does not return per-chunk snippets, so the synthesized
 * `answer` text is what carries the actual search content.
 */
export function parseGeminiGroundingResponse(json: unknown): {
  answer: string;
  results: { title: string; url: string; content: string }[];
} {
  const candidate = (json as { candidates?: unknown[] } | null)?.candidates?.[0] as
    | {
        content?: { parts?: { text?: unknown }[] };
        groundingMetadata?: { groundingChunks?: unknown[] };
      }
    | undefined;
  const parts = candidate?.content?.parts ?? [];
  const answer = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  const chunks = (candidate?.groundingMetadata?.groundingChunks ?? []) as GeminiGroundingChunk[];
  const results: { title: string; url: string; content: string }[] = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    if (!web || typeof web.uri !== 'string') continue;
    // Allowlist http(s) only — Gemini has returned non-web schemes (e.g.
    // `javascript:`, `data:`) before, and the URL flows straight into
    // `<a href>` in the chat card.
    let parsed: URL;
    try {
      parsed = new URL(web.uri);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const title =
      typeof web.title === 'string' && web.title.trim().length > 0 ? web.title.trim() : web.uri;
    results.push({ title, url: web.uri, content: '' });
  }
  return { answer, results };
}

export async function handleGoogleSearch(request: Request, env: Env): Promise<Response> {
  // BYOK: same treatment as handleGoogleChat — keyless through the gateway,
  // which injects the stored google key. Closes the 58143aa7 known-limitation
  // where grounded search degraded once the Worker secret retired.
  const byok = gatewayByokActive(env, 'google', 'google-ai-studio');
  const preamble = await runPreamble(request, env, {
    buildAuth: buildGoogleAuth,
    keyMissingError:
      'Google Gemini API key not configured. Add it in Settings or set GOOGLE_API_KEY on the Worker.',
    needsBody: true,
    allowMissingKey: byok,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader: apiKey, bodyText, requestId } = preamble;

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
  // Reject whitespace-only queries that would survive the missing-field
  // check but produce a useless upstream call.
  if (!query) {
    return Response.json({ error: 'Empty "query" field' }, { status: 400 });
  }

  const model = (env.PUSH_GOOGLE_GROUNDING_MODEL ?? '').trim() || GROUNDING_DEFAULT_MODEL;
  const directSearchUrl = `${GOOGLE_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  // Derive the gateway path from the direct URL so it mirrors
  // GOOGLE_API_BASE's version (the #1376 lesson), same as handleGoogleChat.
  const directSearch = new URL(directSearchUrl);
  const { upstreamUrl, gatewayHeaders } = byok
    ? resolveAiGatewayFetchTarget(env, directSearchUrl, {
        provider: 'google-ai-studio',
        pathSuffix: `${directSearch.pathname}${directSearch.search}`,
      })
    : { upstreamUrl: directSearchUrl, gatewayHeaders: {} as Record<string, string> };
  const upstreamBody = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ googleSearch: {} }],
  });

  wlog('info', 'search', { provider: 'google-grounded', query, model, requestId });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GROUNDING_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          // BYOK omits x-goog-api-key so the gateway injects the stored key.
          ...(byok ? {} : { 'x-goog-api-key': apiKey }),
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...gatewayHeaders,
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
        route: 'api/google/search',
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

    const json = (await upstream.json().catch(() => null)) as unknown;
    const { answer, results } = parseGeminiGroundingResponse(json);
    wlog('info', 'search_results', {
      provider: 'google-grounded',
      query,
      count: results.length,
      hasAnswer: answer.length > 0,
    });
    return Response.json({ answer, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'search_error', { provider: 'google-grounded', message, timeout: isTimeout });
    return Response.json(
      { error: isTimeout ? 'Grounded search timed out' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

export type WorkerProviderHandler = (request: Request, env: Env) => Promise<Response>;

export interface WorkerProviderHandlers {
  readonly chat: WorkerProviderHandler;
  readonly models: WorkerProviderHandler;
}

export interface WorkerProviderApiRoute {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly handler: WorkerProviderHandler;
}

export const WORKER_PROVIDER_HANDLERS = {
  ollama: { chat: handleOllamaChat, models: handleOllamaModels },
  openrouter: { chat: handleOpenRouterChat, models: handleOpenRouterModels },
  zai: { chat: handleZaiChat, models: handleZaiModels },
  kimi: { chat: handleKimiChat, models: handleKimiModels },
  huggingface: { chat: handleHuggingFaceChat, models: handleHuggingFaceModels },
  cloudflare: { chat: handleCloudflareChat, models: handleCloudflareModels },
  zen: { chat: handleZenChat, models: handleZenModels },
  fireworks: { chat: handleFireworksChat, models: handleFireworksModels },
  deepseek: { chat: handleDeepSeekChat, models: handleDeepSeekModels },
  sakana: { chat: handleSakanaChat, models: handleSakanaModels },
  anthropic: { chat: handleAnthropicChat, models: handleAnthropicModels },
  openai: { chat: handleOpenAIChat, models: handleOpenAIModels },
  xai: { chat: handleXAIChat, models: handleXAIModels },
  google: { chat: handleGoogleChat, models: handleGoogleModels },
} satisfies Record<RealProviderId, WorkerProviderHandlers>;

export const WORKER_PROVIDER_API_ROUTES: readonly WorkerProviderApiRoute[] =
  PROVIDER_DEFINITIONS.flatMap((def) => {
    const handlers = WORKER_PROVIDER_HANDLERS[def.id];
    const routes: WorkerProviderApiRoute[] = [];
    if (def.webProxyPath) {
      routes.push({ path: def.webProxyPath, method: 'POST', handler: handlers.chat });
    }
    if (def.modelsProxyPath) {
      routes.push({ path: def.modelsProxyPath, method: 'GET', handler: handlers.models });
    }
    return routes;
  });
