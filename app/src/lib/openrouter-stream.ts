/**
 * OpenRouter PushStream implementation.
 *
 * Hits the existing Worker proxy at `/api/openrouter/chat` (or the Vite dev
 * passthrough at `/openrouter/api/v1/responses`), then delegates SSE parsing
 * to the shared Responses pump in `lib/`. Legacy Chat Completions remains
 * available behind VITE_OPENROUTER_TRANSPORT=chat.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type {
  LlmContentBlock,
  LlmContentPart,
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
  ResponsesReasoningItem,
} from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { openAIResponsesSSEPump } from '@push/lib/openai-responses-sse-pump';
import {
  OPENROUTER_PARAMETER_EVENTS,
  fetchOpenRouterWithStructuredOutputFallback,
  scopeOpenRouterRequiredParameters,
} from '@push/lib/openrouter-parameters';
import {
  OPENROUTER_FALLBACK_EVENTS,
  streamResponsesWithChatFallback,
} from '@push/lib/responses-chat-fallback';
import {
  expandToolMessagesForOpenAICompat,
  flatToolToOpenAITool,
  toOpenAIResponseFormat,
} from '@push/lib/openai-chat-serializer';
import { toOpenAIResponses } from '@push/lib/openai-responses-serializer';
import { isGeminiModelId } from '@push/lib/gemini-thought-signature';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { buildOpenRouterTrace, getOpenRouterSessionId } from './openrouter-session';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import {
  openRouterModelSupportsReasoning,
  getReasoningEffort,
  resolvePushCapabilityProfile,
} from './model-catalog';
import { PROVIDER_URLS } from './providers';
import type { WorkspaceContext } from '@/types';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';

/**
 * OpenRouter's native server-side web search, expressed as a server tool.
 * OpenRouter runs the search upstream (engine `auto` → native provider
 * search when the routed model supports it, else Exa) and feeds grounded,
 * `url_citation`-annotated results back to the model — Push's own
 * prompt-engineered `web_search` is suppressed for OpenRouter when this is
 * active (see `nativeWebSearchActive` in `orchestrator.ts`), so the two
 * never collide. The `openrouter:web_search` tool is the current shape;
 * the older `:online` suffix / `plugins: [{ id: 'web' }]` form is
 * deprecated. https://openrouter.ai/docs/guides/features/server-tools/web-search
 */
const OPENROUTER_WEB_SEARCH_TOOL = { type: 'openrouter:web_search' } as const;

type OpenRouterTransport = 'responses' | 'chat';

type OpenRouterLlmMessage = {
  role: LlmMessage['role'];
  content: string | LlmContentPart[];
  contentBlocks?: LlmContentBlock[];
  responsesReasoningItems?: ResponsesReasoningItem[];
};

/**
 * Per-request transport pick. The env var is an all-models override in either
 * direction (`chat` forces legacy everywhere; `responses` forces the beta
 * endpoint everywhere, e.g. to trial a model before its capability is known).
 * With no override, the shared capability profile decides per model. A
 * Responses body cannot ride /chat/completions, so the body shape MUST be
 * decided where the body is built.
 */
export function resolveOpenRouterTransport(model?: string): OpenRouterTransport {
  const raw = (import.meta.env.VITE_OPENROUTER_TRANSPORT ?? '').trim().toLowerCase();
  if (raw === 'chat' || raw === 'chat-completions' || raw === 'legacy') return 'chat';
  if (raw === 'responses') return 'responses';
  return resolvePushCapabilityProfile('openrouter', model).openaiWire === 'responses'
    ? 'responses'
    : 'chat';
}

function openRouterRequestUrl(transport: OpenRouterTransport): string {
  if (transport === 'chat' && import.meta.env.DEV) {
    return '/openrouter/api/v1/chat/completions';
  }
  return PROVIDER_URLS.openrouter.chat;
}

function contentFallbackText(content: OpenRouterLlmMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<LlmContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function toNeutralMessages(messages: OpenRouterLlmMessage[]): LlmMessage[] {
  return messages.map((message, index) => ({
    id: `openrouter-${index}`,
    role: message.role,
    content: contentFallbackText(message.content),
    timestamp: 0,
    ...(Array.isArray(message.content) ? { contentParts: message.content } : {}),
    ...(message.contentBlocks && message.contentBlocks.length > 0
      ? { contentBlocks: message.contentBlocks }
      : {}),
    ...(message.responsesReasoningItems && message.responsesReasoningItems.length > 0
      ? { responsesReasoningItems: message.responsesReasoningItems }
      : {}),
  }));
}

export async function* openrouterStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  if (resolveOpenRouterTransport(req.model) === 'chat') {
    yield* openrouterChatCompletionsStream(req);
    return;
  }

  // Responses-first with a Chat Completions fallback. OpenRouter's /responses
  // beta serves every live model, but if one fails BEFORE any output (a transient
  // provider error, an unforeseen incompatibility), retry the turn on chat rather
  // than fail it — `openrouterResponsesStream` throws its non-200 `ProviderStreamError`
  // (and the pump throws early stream errors) before yielding, which the combinator
  // catches. A user abort is never a fallback.
  yield* streamResponsesWithChatFallback({
    responses: () => openrouterResponsesStream(req),
    chat: () => openrouterChatCompletionsStream(req),
    shouldFallback: () => !req.signal?.aborted,
    onFallback: (error) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: OPENROUTER_FALLBACK_EVENTS.fellBackToChat,
          model: req.model,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
}

async function* openrouterResponsesStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context
  //    (workspaceContext, hasSandbox, onPreCompact) flows through the
  //    adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  // Native function calling is active when the caller attached function schemas
  // (gated upstream on model support). Gate the tool-history shape on this, NOT
  // on the `openrouter:web_search` server tool below — web search alone doesn't
  // put the model in native-FC mode. When active, deliver prior tool history as
  // OpenAI-native `tool_calls[]` + `role:'tool'` results instead of the
  // `[TOOL_RESULT]` text envelope, so a tool-capable model sees its own results
  // as tool output rather than untrusted user-injected data. `emitContentBlocks`
  // runs the kernel's paired tool sidecars through the whole-request adjacency
  // pass so the expansion has paired `contentBlocks`; unpaired turns degrade to
  // text. Off → byte-identical to before.
  const nativeFcActive = Array.isArray(req.tools) && req.tools.length > 0;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'openrouter',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
    emitContentBlocks: nativeFcActive,
  });

  // 2. Layer in OpenRouter-specific body extensions (reasoning effort,
  //    Push session id, trace flags). OpenRouter mirrors OpenAI Responses for
  //    the core body and extends it with routing/session fields.
  const supportsReasoning = openRouterModelSupportsReasoning(req.model);
  const effort = getReasoningEffort('openrouter');
  const useReasoning = supportsReasoning && effort !== 'off';
  const sessionId = getOpenRouterSessionId();
  const trace = buildOpenRouterTrace();

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) enables OpenRouter's `openrouter:web_search`
  // server tool so chats search the web without the user opting in;
  // explicit non-native backends suppress it. Mirrors the Anthropic /
  // Gemini native-search adapters.
  const webSearch = req.openrouterWebSearch ?? isNativeWebSearchEnabled('openrouter', req.model);

  // Native function calling: when the caller attached function schemas (gated on
  // model support via `providerModelSupportsNativeToolCalling`), forward them so
  // OpenRouter routes through the model's constrained tool-calling path. Additive
  // to text-dispatch — the Responses SSE pump emits native `function_call`
  // output as structured events, while prompt-described text tools keep using fenced JSON.
  // OpenRouter's default `tool_choice: 'auto'` keeps prose answers available
  // when no tool is needed; the body scoper below omits that redundant value.
  // OpenRouter accepts a mixed `tools` array,
  // so native function schemas and the `openrouter:web_search` server tool merge
  // (web search appended last) when both are active.
  const nativeTools = nativeFcActive ? (req.tools ?? []) : [];
  // `provider.require_parameters` is load-bearing whenever we send native tools
  // or a `response_format` constraint: by default OpenRouter may route to an
  // endpoint that doesn't honor those params and silently drops them — dropping
  // native tool calling back to prompt-only (or the schema constraint back to
  // prompt-only JSON) despite the model advertising support. require_parameters
  // restricts routing to providers that honor every param we send, so the
  // constraint can't be lost mid-route. Because OpenRouter's flag is all-or-
  // nothing, the shared body helper omits only redundant `tool_choice: 'auto'`;
  // explicit sampling remains part of the request. If routing proves the native
  // schema unsatisfiable, the fetch helper retries once without the schema while
  // retaining tools (and their guard) plus every sampling choice. Web search
  // alone doesn't need the guard, so it stays off that path.
  const requireParameters = nativeTools.length > 0 || Boolean(req.responseFormat);
  const baseBody = toOpenAIResponses(
    {
      provider: 'openrouter',
      model: req.model,
      messages: toNeutralMessages(llmMessages as OpenRouterLlmMessage[]),
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      signal: req.signal,
      responseFormat: req.responseFormat,
      tools: nativeTools,
      toolChoice: req.toolChoice,
    },
    {
      geminiThoughtSignatureFallback: nativeFcActive && isGeminiModelId(req.model),
      encryptedReasoningReplay: true,
    },
  ) as unknown as Record<string, unknown>;
  const responseTools = Array.isArray(baseBody.tools)
    ? [...(baseBody.tools as Record<string, unknown>[])]
    : [];
  const toolsArray = [...responseTools, ...(webSearch ? [OPENROUTER_WEB_SEARCH_TOOL] : [])];

  const body = scopeOpenRouterRequiredParameters(
    {
      ...baseBody,
      ...(useReasoning ? { reasoning: { effort } } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(toolsArray.length > 0 ? { tools: toolsArray } : {}),
      trace,
    },
    requireParameters,
  );

  // 3. Headers. The Worker proxy overrides Authorization server-side when
  //    OPENROUTER_API_KEY is configured; we still send the client-side key
  //    so dev (Vite passthrough) and unconfigured-Worker paths work. Omit
  //    the header entirely when no client key is configured — `standardAuth`
  //    treats any non-empty client `Authorization` as "key supplied" and
  //    skips the Worker's `keyMissingError` 401, so sending `Bearer ` would
  //    bypass the configured fallback and forward an empty bearer upstream.
  const apiKey = (getOpenRouterKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const { response, errorBody } = await fetchOpenRouterWithStructuredOutputFallback({
    body,
    transport: 'responses',
    requireParameters,
    requireParametersAfterRelaxation: nativeTools.length > 0,
    attempt: (attemptBody) =>
      fetch(openRouterRequestUrl('responses'), {
        method: 'POST',
        headers,
        body: JSON.stringify(attemptBody),
        signal: req.signal,
      }),
    onRelaxed: () => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: OPENROUTER_PARAMETER_EVENTS.structuredOutputRelaxed,
          reason: 'routing_constraint',
          model: req.model,
          transport: 'responses',
          droppedParameter: 'response_format',
          wireField: 'text.format',
        }),
      );
    },
  });

  if (!response.ok) {
    const errBody = errorBody ?? '';
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    throw new ProviderStreamError(`OpenRouter ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  if (!response.body) {
    throw new Error('OpenRouter response had no body');
  }

  yield* openAIResponsesSSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}

async function* openrouterChatCompletionsStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const nativeFcActive = Array.isArray(req.tools) && req.tools.length > 0;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'openrouter',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
    emitContentBlocks: nativeFcActive,
  });
  // OpenRouter routes `google/gemini-*` to Gemini, which 400s on the replay turn
  // unless the prior call's first functionCall carries a thought_signature;
  // backfill the documented placeholder when none was captured.
  const expandedMessages = nativeFcActive
    ? expandToolMessagesForOpenAICompat(llmMessages, isGeminiModelId(req.model))
    : llmMessages;
  // `responsesReasoningItems` is a Responses-only field (opaque, provider-bound
  // encrypted reasoning items). It must never ride the Chat Completions wire: a
  // strict OpenAI-compat transport may reject the unknown message field, and on
  // the responses→chat fallback that would defeat the fallback itself. Strip it
  // here — the serializer strips `contentBlocks` for exactly this reason, but the
  // raw/expanded passthrough carries this sibling field through untouched.
  const wireMessages = expandedMessages.map((message) => {
    if ('responsesReasoningItems' in message && message.responsesReasoningItems) {
      const rest = { ...message };
      delete (rest as { responsesReasoningItems?: unknown }).responsesReasoningItems;
      return rest;
    }
    return message;
  });

  const supportsReasoning = openRouterModelSupportsReasoning(req.model);
  const effort = getReasoningEffort('openrouter');
  const useReasoning = supportsReasoning && effort !== 'off';
  const sessionId = getOpenRouterSessionId();
  const trace = buildOpenRouterTrace();
  const webSearch = req.openrouterWebSearch ?? isNativeWebSearchEnabled('openrouter', req.model);
  const nativeTools = nativeFcActive ? (req.tools ?? []) : [];
  const openAITools = nativeTools.map(flatToolToOpenAITool);
  const toolsArray = [...openAITools, ...(webSearch ? [OPENROUTER_WEB_SEARCH_TOOL] : [])];
  const requireParameters = nativeTools.length > 0 || Boolean(req.responseFormat);

  const body = scopeOpenRouterRequiredParameters(
    {
      model: req.model,
      messages: wireMessages,
      stream: true,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(useReasoning ? { reasoning: { effort } } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(toolsArray.length > 0 ? { tools: toolsArray } : {}),
      ...(nativeTools.length > 0 ? { tool_choice: req.toolChoice ?? 'auto' } : {}),
      ...(req.responseFormat
        ? { response_format: toOpenAIResponseFormat(req.responseFormat) }
        : {}),
      trace,
    },
    requireParameters,
  );

  const apiKey = (getOpenRouterKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const { response, errorBody } = await fetchOpenRouterWithStructuredOutputFallback({
    body,
    transport: 'chat',
    requireParameters,
    requireParametersAfterRelaxation: nativeTools.length > 0,
    attempt: (attemptBody) =>
      fetch(openRouterRequestUrl('chat'), {
        method: 'POST',
        headers,
        body: JSON.stringify(attemptBody),
        signal: req.signal,
      }),
    onRelaxed: () => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: OPENROUTER_PARAMETER_EVENTS.structuredOutputRelaxed,
          reason: 'routing_constraint',
          model: req.model,
          transport: 'chat',
          droppedParameter: 'response_format',
          wireField: 'response_format',
        }),
      );
    },
  });

  if (!response.ok) {
    const errBody = errorBody ?? '';
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    throw new ProviderStreamError(`OpenRouter ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  if (!response.body) {
    throw new Error('OpenRouter response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
