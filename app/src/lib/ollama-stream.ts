/**
 * Ollama Cloud PushStream implementation.
 *
 * Hits the existing Worker proxy at `/api/ollama/chat` (or the Vite dev
 * passthrough at `/ollama/v1/chat/completions`), then delegates SSE
 * parsing to the shared `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import {
  expandToolMessagesForOpenAICompat,
  flatToolToOpenAITool,
} from '@push/lib/openai-chat-serializer';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getModelCapabilities, getReasoningEffort } from './model-catalog';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';

export async function* ollamaStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  // Native function calling is active when the caller attached tool schemas
  // (gated upstream on model support). When active, deliver prior tool history
  // in the OpenAI-native shape — assistant `tool_calls[]` + `role: 'tool'`
  // results — instead of the `[TOOL_RESULT]` text envelope. A tool-capable model
  // then sees its own results as tool output rather than untrusted user-injected
  // data (the provenance-confusion failure mode). `emitContentBlocks` runs the
  // kernel's tool sidecars through the whole-request adjacency/pairing pass so
  // `expandToolMessagesForOpenAICompat` has paired `contentBlocks` to flatten;
  // unpaired turns degrade to their text form. Off → byte-identical to before.
  const nativeFcActive = Array.isArray(req.tools) && req.tools.length > 0;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'ollama',
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
  const wireMessages = nativeFcActive
    ? expandToolMessagesForOpenAICompat(llmMessages)
    : llmMessages;

  // 2. Reasoning effort. Ollama Cloud's OpenAI-compatible endpoint honors a
  //    `reasoning_effort` field (`high|medium|low|none`) on thinking-capable
  //    models, translating it to the native `think` option. Gate it on cached
  //    model metadata: non-reasoning models reject the field, and Ollama
  //    auto-enables thinking when it's absent — so we send it explicitly,
  //    mapping Push's `off` onto Ollama's `none` so the Reasoning control can
  //    actually disable thinking instead of silently leaving it on. The UI
  //    button is already gated on the same `reasoning` capability, so the
  //    field is only ever attached for models the user can toggle.
  const supportsReasoning = getModelCapabilities('ollama', req.model).reasoning;
  const effort = getReasoningEffort('ollama');
  const reasoningEffort = effort === 'off' ? 'none' : effort;

  // 3. OpenAI-compatible request body. Aside from `reasoning_effort` above,
  //    Ollama Cloud has no provider-specific extensions on
  //    `/v1/chat/completions`.
  const nativeTools = nativeFcActive ? req.tools : undefined;
  const openAITools = nativeTools?.map(flatToolToOpenAITool);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: wireMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(supportsReasoning ? { reasoning_effort: reasoningEffort } : {}),
    // Native function calling: gated upstream by model support. The shared SSE
    // pump emits native tool_calls as structured events for dispatch.
    ...(openAITools ? { tools: openAITools, tool_choice: 'auto' } : {}),
  };

  // 4. Headers. Ollama Cloud uses a straight Bearer token; the Worker proxy
  //    overrides Authorization server-side when OLLAMA_API_KEY is configured.
  //    When neither the client nor the Worker has a key configured we omit
  //    Authorization entirely — sending `Bearer ` (empty token) reads as a
  //    truthy header to `standardAuth('OLLAMA_API_KEY')` and bypasses the
  //    Worker's `keyMissingError` 401, surfacing as an upstream auth error
  //    instead of the configured "key not configured" message.
  const apiKey = (getOllamaKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 5. POST + stream response.
  const response = await fetch(PROVIDER_URLS.ollama.chat, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    throw new ProviderStreamError(`Ollama Cloud ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  if (!response.body) {
    throw new Error('Ollama Cloud response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
