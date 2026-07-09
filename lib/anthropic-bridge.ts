import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIReasoningBlock,
} from './openai-chat-types.ts';
import type { LlmContentBlock, LlmMessage, PushStreamRequest } from './provider-contract.ts';
import type { PushStreamEvent, StreamUsage, ToolFunctionSchema } from './provider-contract.ts';
import { EPHEMERAL_CACHE_CONTROL } from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';
import { withRequestContentBlocks } from './content-blocks.ts';
import { parseNativeToolCallArgs, stripTemplateTokens } from './openai-sse-pump.ts';
import { openAIToolToFlatTool } from './openai-chat-serializer.ts';
import { anthropicModelSupportsNativeStructuredOutput } from './anthropic-structured-output.ts';
import type { PushStructuredOutputMode } from './capabilities.ts';

/**
 * Reserved tool name for the structured-output forced-tool fallback. Modern
 * Claude models prefer native `output_config.format`; older Anthropic-transport
 * routes still express the JSON-schema constraint as this single forced tool.
 * The SSE translators recognize the name and route the tool's streamed `input`
 * to plain text content — so the JSON arrives as message content, matching
 * OpenAI `response_format`, rather than as a fenced `tool_call`. The
 * double-underscore name avoids colliding with any registry tool
 * (`KNOWN_TOOL_NAMES`).
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = '__push_structured_output__';

/**
 * Anthropic removed `temperature`, `top_p`, and `top_k` on Opus 4.7+, Sonnet 5,
 * and the Fable/Mythos 5 family. Sending any of them returns a 400
 * (`invalid_request_error`). Sonnet 4.6, Haiku 4.5, and Opus 4.6-and-earlier
 * still accept them.
 *
 * The model id reaching this bridge is usually the native Anthropic form
 * (`claude-opus-4-8`, optionally date- or `@`-suffixed, or the `[1m]`
 * long-context tag), but OpenRouter/Bedrock-ish prefixes can also appear in
 * tests and local routing. We parse the Claude family + major/minor and reject
 * only the families with the removed sampling surface. The single/double-digit
 * minor guard `(?!\d)` keeps dated 4.0 ids such as `claude-opus-4-20250514`
 * from being misread as "Opus 4.<date>".
 *
 * Other Claude models and non-Anthropic models that pass through this bridge
 * (e.g. Zen-Go's `minimax-*`) return false, so their sampling params flow
 * unchanged.
 */
export function anthropicModelRejectsSamplingParams(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const match = model
    .toLowerCase()
    .match(/claude[-.](opus|sonnet|haiku|fable|mythos)[-.](\d+)(?:[-.](\d{1,2})(?!\d))?/);
  if (!match) return false;
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);

  if (family === 'opus') {
    if (major > 4) return true;
    if (major < 4) return false;
    return minor >= 7;
  }

  if (family === 'sonnet') return major >= 5;
  if (family === 'fable' || family === 'mythos') return major >= 5;
  return false;
}

/**
 * Separate rule from the Opus 4.7+ *removal* above: every Claude 4+ model
 * (Opus, Sonnet, and Haiku alike) accepts at most ONE of `temperature` /
 * `top_p` — sending both returns a 400 (`invalid_request_error`). Claude 3.x
 * and earlier accepted both. The OpenAI-canonical wire carries both as
 * first-class fields, so a caller that sets both reaches the serializer with
 * both populated; this predicate flags the models where that pair is illegal.
 *
 * Handles both id shapes: 4.x is `claude-<family>-<major>-…`
 * (`claude-sonnet-4-6`), while 3.x puts the major right after the prefix
 * (`claude-3-5-sonnet-…`, `claude-3-opus-…`). Non-Anthropic ids return false.
 */
export function anthropicModelEnforcesSamplingExclusivity(
  model: string | null | undefined,
): boolean {
  if (typeof model !== 'string') return false;
  const id = model.toLowerCase();
  // 4.x-style: family precedes the major. 3.x-style: major precedes the family.
  const match = id.match(/claude-(?:opus|sonnet|haiku)-(\d+)/) ?? id.match(/claude-(\d+)/);
  if (!match) return false;
  return Number(match[1]) >= 4;
}

function dataUrlToAnthropicImagePart(dataUrl: string): Record<string, unknown> | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  };
}

/** Reasoning blocks must appear BEFORE text/tool_use in Anthropic's
 *  assistant `content[]` when extended thinking is in use — otherwise the
 *  API rejects the turn with `invalid_request_error`. */
function reasoningBlocksToAnthropic(
  blocks: OpenAIReasoningBlock[] | undefined,
): Array<Record<string, unknown>> {
  if (!blocks || blocks.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'thinking') {
      out.push({ type: 'thinking', thinking: block.text, signature: block.signature });
    } else if (block.type === 'redacted_thinking') {
      out.push({ type: 'redacted_thinking', data: block.data });
    }
  }
  return out;
}

function convertOpenAIContentToAnthropic(
  content: string | OpenAIContentPart[] | null | undefined,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: '' }];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const textPart: Record<string, unknown> = { type: 'text', text: part.text };
      // Anthropic accepts the same `cache_control: { type: 'ephemeral' }` shape
      // OpenAI uses for prompt caching. Pass it through verbatim — dropping it
      // here would silently disable caching on every direct-Anthropic /
      // Vertex-Anthropic turn even when the caller set breakpoints upstream.
      if (part.cache_control) textPart.cache_control = part.cache_control;
      parts.push(textPart);
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const imagePart = dataUrlToAnthropicImagePart(part.image_url.url);
      if (imagePart) {
        if (part.cache_control) imagePart.cache_control = part.cache_control;
        parts.push(imagePart);
      }
    }
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/**
 * Strict converter for the neutral `LlmMessage.contentBlocks` → Anthropic
 * content blocks — the native block direction of the contract migration
 * (see `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 * Because the block model is Anthropic-canonical, each block maps with only
 * field-name nudges and zero upcasting/fakery: `image.source` is already
 * Anthropic's shape, `thinking.text` → the `thinking` field, `tool_use` is
 * verbatim, and `tool_result` keeps its `is_error` flag (which OpenAI lacks).
 * THROWS on a malformed block. `tagLast` adds the `cache_control` breakpoint to
 * the final text block, mirroring the string fallback's tagging.
 *
 * Block ORDER is preserved verbatim — Anthropic requires `thinking` blocks to
 * lead an assistant turn using extended thinking, which the producer of
 * `contentBlocks` is responsible for emitting in order (so the legacy
 * `reasoningBlocks` sidecar prepend is skipped when blocks are present).
 */
function llmContentBlocksToAnthropic(
  blocks: readonly LlmContentBlock[],
  tagLast: boolean,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rawBlock of blocks) {
    const block = rawBlock as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
      signature?: unknown;
      data?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
      cache_control?: unknown;
    };
    const cc = block.cache_control ? { cache_control: block.cache_control } : {};
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text, ...cc });
      continue;
    }
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const s = block.source;
      if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: s.media_type, data: s.data },
          ...cc,
        });
        continue;
      }
      if (s.type === 'url' && typeof s.url === 'string') {
        out.push({ type: 'image', source: { type: 'url', url: s.url }, ...cc });
        continue;
      }
      // Malformed image source — fall through to the loud throw below.
    }
    if (
      block.type === 'thinking' &&
      typeof block.text === 'string' &&
      typeof block.signature === 'string'
    ) {
      // Anthropic's thinking block carries the text under `thinking`, not `text`.
      // No cache_control on signed-reasoning blocks.
      out.push({ type: 'thinking', thinking: block.text, signature: block.signature });
      continue;
    }
    if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      out.push({ type: 'redacted_thinking', data: block.data });
      continue;
    }
    if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      block.input !== null &&
      typeof block.input === 'object'
    ) {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input, ...cc });
      continue;
    }
    if (
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      typeof block.content === 'string'
    ) {
      const result: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...cc,
      };
      // Anthropic HAS a typed `is_error` slot (unlike OpenAI) — preserve it.
      if (block.is_error === true) result.is_error = true;
      out.push(result);
      continue;
    }
    throw new Error(
      `toAnthropicMessages: unsupported or malformed content block (type: ${JSON.stringify(block.type)})`,
    );
  }
  if (tagLast) {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].type === 'text') {
        out[i].cache_control = EPHEMERAL_CACHE_CONTROL;
        break;
      }
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

function isToolResultOnlyContent(content: Array<Record<string, unknown>>): boolean {
  return content.length > 0 && content.every((part) => part.type === 'tool_result');
}

function mergeIntoPreviousToolResultUserMessage(
  messages: Array<Record<string, unknown>>,
  content: Array<Record<string, unknown>>,
): boolean {
  if (!isToolResultOnlyContent(content)) return false;
  const previous = messages[messages.length - 1];
  if (!previous || previous.role !== 'user' || !Array.isArray(previous.content)) return false;
  const previousContent = previous.content as Array<Record<string, unknown>>;
  if (!isToolResultOnlyContent(previousContent)) return false;
  previous.content = [...previousContent, ...content];
  return true;
}

function mapAnthropicStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    // `pause_turn` is Anthropic's signal that the server-side sampling loop
    // ran out of iterations before completing the turn (web_search_20250305
    // and other server tools can trigger it). The client is expected to
    // replay the assistant's content[] in a follow-up request to continue;
    // see the SSE translator below for the capture path and the pump for
    // the surface event.
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'stop';
  }
}

export function buildAnthropicMessagesRequest(
  request: OpenAIChatRequest,
  options?: {
    anthropicVersion?: string;
  },
): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];

  // Anthropic accepts `system` as a plain string OR as an array of content
  // blocks. We use the array form whenever the upstream system message carries
  // a `cache_control` marker so the Hermes `system_and_3` strategy's longest-
  // lived breakpoint survives translation. Otherwise we flatten to a string
  // (cheaper to wire, and consistent with the historical Vertex behaviour).
  const systemBlocks: Array<Record<string, unknown>> = [];
  let systemHasCacheControl = false;
  const anthropicMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      const parts = convertOpenAIContentToAnthropic(message.content);
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          if (part.cache_control) systemHasCacheControl = true;
          systemBlocks.push(part);
        }
      }
      continue;
    }

    const contentBlocks = convertOpenAIContentToAnthropic(message.content);
    if (role === 'assistant') {
      // Pause-turn continuation: when the caller carries the raw assistant
      // content array from a prior paused response (server-side sampling
      // loop hit its iteration cap), emit it verbatim. Anthropic treats it
      // as continuation context, so the text + reasoning_blocks
      // reconstruction would corrupt the round-trip — drop them.
      if (
        Array.isArray(message.assistant_content_blocks) &&
        message.assistant_content_blocks.length > 0
      ) {
        anthropicMessages.push({
          role: 'assistant',
          content: message.assistant_content_blocks,
        });
        continue;
      }
      const reasoning = reasoningBlocksToAnthropic(message.reasoning_blocks);
      anthropicMessages.push({
        role: 'assistant',
        content: reasoning.length > 0 ? [...reasoning, ...contentBlocks] : contentBlocks,
      });
    } else {
      anthropicMessages.push({ role: 'user', content: contentBlocks });
    }
  }

  return assembleAnthropicBody({
    anthropicMessages,
    systemBlocks,
    systemHasCacheControl,
    maxTokens:
      typeof request.max_completion_tokens === 'number'
        ? request.max_completion_tokens
        : typeof request.max_tokens === 'number'
          ? request.max_tokens
          : 8192,
    stream: Boolean(request.stream),
    samplingModel: request.model,
    temperature: request.temperature,
    topP: request.top_p,
    enableWebSearch: request.anthropic_web_search === true,
    tools: request.tools?.map(openAIToolToFlatTool),
    structuredOutput: request.response_format
      ? {
          name: request.response_format.json_schema.name,
          schema: request.response_format.json_schema.schema,
          strict: request.response_format.json_schema.strict,
        }
      : undefined,
    structuredOutputMode: anthropicModelSupportsNativeStructuredOutput(request.model)
      ? 'strict'
      : 'best-effort',
    anthropicVersion: options?.anthropicVersion,
    // `buildAnthropicMessagesRequest` intentionally omits `model` — callers
    // re-attach it (the body translation is provider-version-agnostic).
  });
}

/**
 * Final body assembly shared by both entry points — the OpenAI-shape bridge
 * (`buildAnthropicMessagesRequest`) and the neutral serializer
 * (`toAnthropicMessages`). Keeping the request-field logic (max_tokens,
 * stream, system flatten/array, sampling-capability gate, web search) in one
 * place means the two paths can only drift on message conversion, which the
 * drift test in `anthropic-bridge.test.ts` pins.
 */
interface AnthropicBodyAssembly {
  anthropicMessages: Array<Record<string, unknown>>;
  systemBlocks: Array<Record<string, unknown>>;
  systemHasCacheControl: boolean;
  maxTokens: number;
  stream: boolean;
  /** Model id consulted ONLY for the sampling-capability gate. */
  samplingModel: string | null | undefined;
  temperature?: number;
  topP?: number;
  enableWebSearch: boolean;
  /** Native function-calling schemas in Anthropic's flat
   *  `{ name, description, input_schema }` custom-tool shape. */
  tools?: ToolFunctionSchema[];
  /** Structured-output JSON-Schema constraint. */
  structuredOutput?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /** Serializer policy for Anthropic structured outputs. */
  structuredOutputMode?: PushStructuredOutputMode;
  anthropicVersion?: string;
  /**
   * When set, emitted as the top-level `model`. `buildAnthropicMessagesRequest`
   * leaves it undefined (its callers re-attach `model`); `toAnthropicMessages`
   * sets it so the body is complete.
   */
  emitModel?: string;
}

function assembleAnthropicBody(parts: AnthropicBodyAssembly): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages:
      parts.anthropicMessages.length > 0
        ? parts.anthropicMessages
        : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    max_tokens: parts.maxTokens,
    stream: parts.stream,
  };

  if (typeof parts.emitModel === 'string' && parts.emitModel.length > 0) {
    body.model = parts.emitModel;
  }
  if (parts.anthropicVersion) {
    body.anthropic_version = parts.anthropicVersion;
  }
  if (parts.systemBlocks.length > 0) {
    body.system = parts.systemHasCacheControl
      ? parts.systemBlocks
      : parts.systemBlocks.map((p) => p.text).join('\n\n');
  }

  // Sampling params are gated on model capability. Opus 4.7+ removed
  // temperature/top_p/top_k (a 400 if sent), and the OpenAI-canonical wire
  // carries them as first-class fields, so without this guard every caller
  // that sets a sampling param — including the CLI, which defaults
  // `temperature: 0.1` on every Anthropic turn — hard-fails on Opus 4.7/4.8.
  // We never forward `top_k` (the OpenAI shape doesn't carry it and Anthropic
  // rejects it on the same models anyway).
  if (anthropicModelRejectsSamplingParams(parts.samplingModel)) {
    if (typeof parts.temperature === 'number' || typeof parts.topP === 'number') {
      // Symmetric structured log: observable behavior (a user-set param is
      // being dropped) gets a line so the strip is visible to ops rather than
      // silently swallowed. Pairs with the no-strip path being the default.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'anthropic_sampling_params_stripped',
          model: parts.samplingModel,
          droppedTemperature: typeof parts.temperature === 'number',
          droppedTopP: typeof parts.topP === 'number',
        }),
      );
    }
  } else {
    const hasTemperature = typeof parts.temperature === 'number';
    const hasTopP = typeof parts.topP === 'number';
    // Claude 4+ accepts at most one of temperature / top_p — sending both 400s
    // (a separate rule from the Opus 4.7+ removal above). When a caller sets
    // both, keep temperature (the more commonly-meaningful knob) and drop
    // top_p so the request doesn't hard-fail.
    const dropTopP =
      hasTemperature && hasTopP && anthropicModelEnforcesSamplingExclusivity(parts.samplingModel);
    if (dropTopP) {
      // Symmetric structured log, mirroring anthropic_sampling_params_stripped:
      // a user-set param is being dropped, so the strip is visible to ops.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'anthropic_sampling_top_p_dropped',
          model: parts.samplingModel,
          reason: 'temperature_top_p_mutually_exclusive',
        }),
      );
    }
    if (hasTemperature) {
      body.temperature = parts.temperature;
    }
    if (hasTopP && !dropTopP) {
      body.top_p = parts.topP;
    }
  }

  // Tools array: native function-calling schemas (translated to Anthropic's flat
  // custom-tool shape) plus the server-side web-search tool, in one array —
  // Anthropic accepts a mix. Function tools come first; the model emits a
  // `tool_use` content block per call, which the SSE translators surface as
  // structured native tool-call events (additive to text-dispatch). Web search
  // emits `server_tool_use` + `web_search_tool_result`
  // blocks instead; the translators capture those for pause_turn but never surface
  // them as tool calls, so the user just sees the model's narration + citations.
  const anthropicTools: Array<Record<string, unknown>> = [];
  if (parts.tools && parts.tools.length > 0) {
    for (const tool of parts.tools) anthropicTools.push(openAIToolToAnthropicTool(tool));
  }
  if (parts.enableWebSearch) {
    anthropicTools.push({ type: 'web_search_20250305', name: 'web_search' });
  }
  // Structured outputs: modern Claude routes support native JSON outputs via
  // `output_config.format`. Older Anthropic-transport routes fall back to the
  // historical forced-tool bridge: a single custom tool with `tool_choice`
  // pinned to it. The SSE translators recognize the reserved name
  // (`STRUCTURED_OUTPUT_TOOL_NAME`) and route its streamed `input` to plain text
  // content (not a tool call), so callers `JSON.parse` the accumulated text
  // exactly as they do with OpenAI `response_format`.
  if (parts.structuredOutput) {
    const useNativeOutputConfig =
      parts.structuredOutputMode === 'strict' && parts.structuredOutput.strict !== false;
    if (useNativeOutputConfig) {
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: parts.structuredOutput.schema,
        },
      };
    } else {
      anthropicTools.push({
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description:
          'Return the response as a single JSON object matching the schema. Call this tool exactly once.',
        input_schema: parts.structuredOutput.schema,
        // Top-level `strict` makes Anthropic enforce schema conformance for the
        // tool input (without it the model is only forced to *call* the tool, not
        // to fill the schema exactly). Defaults true, mirroring the OpenAI
        // `response_format` path (`ResponseFormatSpec.strict ?? true`).
        strict: parts.structuredOutput.strict ?? true,
      });
      body.tool_choice = { type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME };
    }
  }
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  return body;
}

/**
 * Translate one OpenAI `ToolFunctionSchema` to Anthropic's native custom-tool
 * shape. Anthropic's Messages API takes tools FLAT — `{ name, description,
 * input_schema }` — not nested under a `function` key like OpenAI, and the
 * JSON-Schema parameter object maps straight onto `input_schema`.
 */
function openAIToolToAnthropicTool(tool: ToolFunctionSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

/** Options for the neutral `PushStreamRequest` → Anthropic Messages serializer. */
export interface ToAnthropicMessagesOptions {
  /**
   * `anthropic_version` body field (Vertex's `vertex-2023-10-16`). Omit for
   * the direct first-party API, which takes the version as a header instead.
   */
  anthropicVersion?: string;
  /**
   * Whether to attach the native `web_search_20250305` tool. The caller owns
   * the policy decision (e.g. the CLI's env-driven default-on). Defaults to
   * `req.anthropicWebSearch === true`.
   */
  enableWebSearch?: boolean;
  /** Model id for the body + sampling gate. Defaults to `req.model`. */
  modelOverride?: string;
  /**
   * Temperature applied when `req.temperature` is unset. The CLI passes 0.1 to
   * preserve its historical default; the sampling gate still strips it on
   * Opus 4.7+. Omit for no default.
   */
  temperatureDefault?: number;
  /** max_tokens applied when `req.maxTokens` is unset. Defaults to 8192. */
  maxTokensDefault?: number;
  /** Whether to set `stream: true`. Defaults to true. */
  stream?: boolean;
  /**
   * Whether to emit the top-level `model` field. Defaults to true — the direct
   * Anthropic API requires `model` in the body. Set false ONLY for transports
   * that genuinely carry the model out-of-band: Vertex puts it in the URL path
   * (`/models/{model}:...`). Endpoints with a fixed shared URL (the direct
   * Anthropic API, and Zen-Go's `/v1/messages`) must keep `model` in the body —
   * leave this true for them. This mirrors `buildAnthropicMessagesRequest`,
   * whose body never includes `model` (its callers re-attach it where the
   * endpoint needs it). The sampling-capability gate still uses the resolved
   * model regardless of this flag.
   */
  emitModel?: boolean;
  /**
   * Pause-turn continuation: prior paused assistant `content[]` arrays,
   * appended verbatim as trailing assistant turns (oldest first). Anthropic
   * treats them as continuation context, so the text/reasoning reconstruction
   * is skipped — they ride through raw, mirroring the bridge's
   * `assistant_content_blocks` handling.
   */
  replayAssistantTurns?: Array<Array<Record<string, unknown>>>;
}

/**
 * Build a complete Anthropic Messages API body **directly** from the neutral
 * `PushStreamRequest` — no OpenAI Chat Completions intermediate. This is the
 * Phase 2 serializer from `docs/runbooks/Provider Request Normalization.md`:
 * it folds the system-prompt hoist, message conversion, cache-control tagging,
 * and request-field assembly that the CLI previously did in two steps
 * (neutral → OpenAI shape, then `buildAnthropicMessagesRequest`) into one pass.
 *
 * Behavior is pinned byte-for-byte against the old two-step path by the drift
 * test in `anthropic-bridge.test.ts` and by the CLI adapter's
 * body-capture suite (`cli/tests/anthropic-stream.test.mjs`).
 */
export function toAnthropicMessages(
  req: PushStreamRequest<LlmMessage>,
  options?: ToAnthropicMessagesOptions,
): Record<string, unknown> {
  // Producer flip: materialize contentBlocks for multimodal/tool turns so they
  // run the block path in production. See lib/content-blocks.ts.
  const messages = withRequestContentBlocks(Array.isArray(req.messages) ? req.messages : []);
  const hasOverride =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride.length > 0;

  // Resolve cache-control tagging to message indices, reproducing the
  // wire-tagging that `cli/anthropic-stream.ts` used to do on the OpenAI
  // intermediate: when any breakpoint is present the leading system block is
  // tagged, and each (capped) breakpoint index tags its `req.messages` entry.
  // The leading system is tagged via its own path, so the breakpoint loop
  // skips index 0 when the head is an untagged-by-override system message —
  // matching the old `wireIndex === 0 && role === 'system'` guard.
  const rawBreakpoints = req.cacheBreakpointIndices;
  const hasBreakpoints = Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0;
  const leadingIsSystem = hasOverride || messages[0]?.role === 'system';
  const offset = hasOverride ? 1 : 0;
  const tagLeadingSystem = hasBreakpoints && leadingIsSystem;
  const taggedIndices = new Set<number>();
  if (hasBreakpoints) {
    for (const reqIndex of (rawBreakpoints as number[]).slice(-MAX_ROLLING_CACHE_BREAKPOINTS)) {
      if (reqIndex < 0 || reqIndex >= messages.length) continue;
      const wireIndex = reqIndex + offset;
      if (wireIndex === 0 && leadingIsSystem) continue;
      taggedIndices.add(reqIndex);
    }
  }

  const systemBlocks: Array<Record<string, unknown>> = [];
  let systemHasCacheControl = false;
  const anthropicMessages: Array<Record<string, unknown>> = [];

  // Reuse the leaf content converter so tagged/untagged block shapes match the
  // bridge exactly: a tagged message is passed as a `cache_control`-bearing
  // part array, an untagged one as a bare string.
  const toContent = (content: string, tagged: boolean): Array<Record<string, unknown>> =>
    tagged
      ? convertOpenAIContentToAnthropic([
          { type: 'text', text: content, cache_control: EPHEMERAL_CACHE_CONTROL },
        ])
      : convertOpenAIContentToAnthropic(content);

  // Push the text blocks of a converted content array into `systemBlocks`,
  // tracking whether any carried a `cache_control` marker (which selects the
  // array `system` shape downstream). Anthropic's `system` field is text-only.
  const pushSystemBlocks = (blocks: Array<Record<string, unknown>>): void => {
    for (const part of blocks) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        if (part.cache_control) systemHasCacheControl = true;
        systemBlocks.push(part);
      }
    }
  };
  const pushSystem = (content: string, tagged: boolean): void => {
    pushSystemBlocks(toContent(content, tagged));
  };

  if (hasOverride) {
    pushSystem(req.systemPromptOverride as string, tagLeadingSystem);
  }

  messages.forEach((m, i) => {
    const tagged =
      taggedIndices.has(i) ||
      // Head system message with no override is tagged via the leading path.
      (!hasOverride && i === 0 && tagLeadingSystem && m.role === 'system');

    if (m.role === 'system') {
      // The request materializer normalizes rich system prompts onto
      // `contentBlocks` so cache_control survives. Plain-string system messages
      // (CLI, override) still flow through `content`; `pushSystemBlocks` keeps
      // only text parts, which is all Anthropic's text-only `system` field
      // accepts.
      if (m.contentBlocks && m.contentBlocks.length > 0) {
        pushSystemBlocks(llmContentBlocksToAnthropic(m.contentBlocks, tagged));
      } else {
        pushSystem(m.content, tagged);
      }
      return;
    }

    // Prefer the Anthropic-conceptual `contentBlocks` when present, else the
    // permanent `content` text fallback. Multimodal `contentParts` are normalized
    // into blocks by `withRequestContentBlocks`; malformed/non-adjacent tool turns
    // deliberately stay on text. For tool turns the block path emits native
    // `tool_use`/`tool_result` where the text arm emits fenced JSON as text — a
    // behavior change, not a re-encoding (see lib/content-blocks.ts). When blocks
    // are present, signed thinking is carried in-stream and in order, so
    // the legacy `reasoningBlocks` sidecar prepend is skipped (it's the old
    // representation of the same thing — applying both would duplicate it).
    let anthropicContent: Array<Record<string, unknown>>;
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      anthropicContent = llmContentBlocksToAnthropic(m.contentBlocks, tagged);
    } else {
      const base = toContent(m.content, tagged);
      if (m.role === 'assistant') {
        const reasoning = reasoningBlocksToAnthropic(m.reasoningBlocks);
        anthropicContent = reasoning.length > 0 ? [...reasoning, ...base] : base;
      } else {
        anthropicContent = base;
      }
    }
    const anthropicRole = m.role === 'assistant' ? 'assistant' : 'user';
    // Push's Coder transcript stores batched tool results as consecutive user
    // turns, one `tool_result` each. First-party Anthropic coalesces those, but
    // DeepSeek's Anthropic-compatible endpoint validates the raw `messages[]`
    // shape and requires every result block to be in the single user message
    // immediately after the assistant `tool_use` turn. Coalesce that narrow
    // structured-result shape here; leave ordinary user text/messages alone.
    if (
      anthropicRole === 'user' &&
      mergeIntoPreviousToolResultUserMessage(anthropicMessages, anthropicContent)
    ) {
      return;
    }
    anthropicMessages.push({
      role: anthropicRole,
      content: anthropicContent,
    });
  });

  for (const blocks of options?.replayAssistantTurns ?? []) {
    if (blocks.length > 0) {
      anthropicMessages.push({ role: 'assistant', content: blocks });
    }
  }

  const model = options?.modelOverride ?? req.model;
  return assembleAnthropicBody({
    anthropicMessages,
    systemBlocks,
    systemHasCacheControl,
    maxTokens:
      typeof req.maxTokens === 'number' ? req.maxTokens : (options?.maxTokensDefault ?? 8192),
    stream: options?.stream ?? true,
    samplingModel: model,
    // Apply the default temperature only when the caller set neither sampling
    // param. If they explicitly chose top_p, injecting a default temperature
    // would (a) on Claude 4+ force the exclusivity guard to drop their explicit
    // top_p, and (b) anywhere fabricate a sampling param they never asked for.
    temperature:
      typeof req.temperature === 'number'
        ? req.temperature
        : typeof req.topP === 'number'
          ? undefined
          : options?.temperatureDefault,
    topP: req.topP,
    enableWebSearch: options?.enableWebSearch ?? req.anthropicWebSearch === true,
    tools: req.tools,
    structuredOutput: req.responseFormat
      ? {
          name: req.responseFormat.name,
          schema: req.responseFormat.schema,
          strict: req.responseFormat.strict,
        }
      : undefined,
    structuredOutputMode: anthropicModelSupportsNativeStructuredOutput(model)
      ? 'strict'
      : 'best-effort',
    anthropicVersion: options?.anthropicVersion,
    // `model` stays the sampling-gate input above; only the top-level body
    // field is suppressed when the transport carries the model out-of-band.
    emitModel: options?.emitModel === false ? undefined : model,
  });
}

/**
 * Phase 3a (see `docs/runbooks/Provider Request Normalization.md`): parse the
 * Anthropic Messages-API SSE stream **directly into neutral `PushStreamEvent`s**,
 * with no OpenAI Chat-Completions SSE intermediate.
 *
 * This is the production response path for every Anthropic-Messages route — the
 * CLI, the direct web Anthropic provider, and the multiplexed Vertex-Claude /
 * Zen-Go routes (their Workers proxy the raw upstream SSE straight through). The
 * old OpenAI-SSE-serialize-then-reparse detour (`createAnthropicTranslatedStream
 * → openAISSEPump`) has been removed entirely; the test corpus in
 * `anthropic-bridge.test.ts` pins this pump to the event sequence that
 * detour produced.
 *
 * Behavior: text deltas → `text_delta`; a signed
 * `thinking` / `redacted_thinking` block, accumulated across its
 * `content_block_start`/delta/`content_block_stop` frames, → a single
 * `reasoning_block` at stop (signature-less thinking is dropped — it can't
 * round-trip); `stop_reason: pause_turn` with captured assistant blocks →
 * `pause_turn` (else a terminal `done`); otherwise a terminal `done` with the
 * mapped finish reason and accumulated usage.
 */
export async function* anthropicEventStream(
  upstream: Response,
  signal?: AbortSignal,
  // Optional early drop of hallucinated/unknown tool names, matching the
  // `openAISSEPump` filter the web path used before this native pump replaced
  // it. The CLI omits it and relies on downstream `detectNativeToolCalls`.
  isKnownToolName?: (name: string) => boolean,
): AsyncIterable<PushStreamEvent> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let usage: StreamUsage | undefined;
  let stopped = false;

  // Per-index thinking/redacted accumulators (signature arrives in its own
  // delta), plus per-index raw-block capture for pause_turn replay.
  type ThinkingState = { kind: 'thinking'; text: string; signature: string };
  type RedactedState = { kind: 'redacted_thinking'; data: string };
  const openBlocks = new Map<number, ThinkingState | RedactedState>();
  const capturedBlocks = new Map<number, Record<string, unknown>>();
  const inputJsonBuffers = new Map<number, string>();
  // Per-index model `tool_use` blocks (native function calls). No downstream
  // pump here (the CLI consumes events directly), so we accumulate name + args
  // and flush each as a structured native_tool_call event.
  const toolUseBlocks = new Map<number, { id: string; name: string; args: string }>();
  // Structured-output forced-tool blocks: their `input` streams out as plain
  // text content (mirrors the web translator), so the JSON arrives as message
  // content for the caller to parse — not a fenced tool call.
  const structuredOutputBlocks = new Set<number>();
  function* flushToolUse(): Generator<PushStreamEvent> {
    for (const [, tc] of toolUseBlocks) {
      if (!tc.name) continue;
      if (isKnownToolName && !isKnownToolName(tc.name)) {
        console.warn(`[Push] Native tool call "${tc.name}" is not a known tool — dropped`);
        continue;
      }
      yield {
        type: 'native_tool_call',
        call: {
          ...(tc.id ? { id: tc.id } : {}),
          name: tc.name,
          args: parseNativeToolCallArgs(tc.args),
        },
      };
    }
    toolUseBlocks.clear();
  }

  const updateUsage = (usageRec: Record<string, unknown> | undefined): void => {
    if (!usageRec) return;
    const inputTokens =
      typeof usageRec.input_tokens === 'number' ? usageRec.input_tokens : (usage?.inputTokens ?? 0);
    const outputTokens =
      typeof usageRec.output_tokens === 'number'
        ? usageRec.output_tokens
        : (usage?.outputTokens ?? 0);
    usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  };

  function* processLine(rawLine: string): Generator<PushStreamEvent> {
    if (stopped) return;
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const jsonStr = line[5] === ' ' ? line.slice(6) : line.slice(5);
    if (jsonStr === '[DONE]') {
      yield* flushToolUse();
      yield { type: 'done', finishReason: 'stop', usage };
      stopped = true;
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return;
    }
    const eventType = typeof parsed.type === 'string' ? parsed.type : '';

    if (eventType === 'content_block_start') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const block = parsed.content_block as Record<string, unknown> | undefined;
      if (idx >= 0 && block) {
        if (block.type === 'thinking') {
          openBlocks.set(idx, {
            kind: 'thinking',
            text: typeof block.thinking === 'string' ? block.thinking : '',
            signature: typeof block.signature === 'string' ? block.signature : '',
          });
        } else if (block.type === 'redacted_thinking') {
          openBlocks.set(idx, {
            kind: 'redacted_thinking',
            data: typeof block.data === 'string' ? block.data : '',
          });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : '';
          if (name === STRUCTURED_OUTPUT_TOOL_NAME) {
            // Forced structured-output tool — its `input` streams out as text
            // content (below), not a tool call.
            structuredOutputBlocks.add(idx);
          } else {
            toolUseBlocks.set(idx, {
              id: typeof block.id === 'string' ? block.id : '',
              name,
              args: '',
            });
            // One `tool_call_delta` progress marker per fragment, matching the
            // pump (which yields one per OpenAI tool_calls fragment it accumulates).
            yield { type: 'tool_call_delta' };
          }
        }
        capturedBlocks.set(idx, { ...block });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        // Accumulate the RAW text onto the captured block for pause_turn replay
        // (Anthropic expects its original content[] back verbatim).
        const captured = idx >= 0 ? capturedBlocks.get(idx) : undefined;
        if (captured && captured.type === 'text') {
          captured.text = (typeof captured.text === 'string' ? captured.text : '') + delta.text;
        }
        // Emit the token through the same chat-template-token strip the
        // openAISSEPump text branch applies, so the direct path stays
        // event-for-event identical to the legacy translate→pump path. A delta
        // that is entirely control tokens strips to '' and yields nothing —
        // matching the pump. (Anthropic's native API doesn't emit these
        // markers, so on real traffic this is a no-op; the parity matters for
        // the drift guarantee and any upstream that proxies template tokens.)
        const token = stripTemplateTokens(delta.text);
        if (token) yield { type: 'text_delta', text: token };
        return;
      }
      const state = idx >= 0 ? openBlocks.get(idx) : undefined;
      if (state?.kind === 'thinking') {
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          state.text += delta.thinking;
          // Emit live progress as thinking streams: the consumer
          // (`iterate-chat-stream`) resets its no-content timer on
          // `reasoning_delta` and streams the thinking panel. The whole signed
          // block is still emitted at `content_block_stop` for replay. Without
          // this, a model that thinks longer than the content timeout — notably
          // DeepSeek on its Anthropic endpoint, which thinks by default — is
          // aborted as "no data" mid-thought (`reasoning_block` alone neither
          // displays nor resets the timer).
          if (delta.thinking) yield { type: 'reasoning_delta', text: delta.thinking };
        } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
          state.signature += delta.signature;
        }
      }
      if (
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string' &&
        idx >= 0
      ) {
        inputJsonBuffers.set(idx, (inputJsonBuffers.get(idx) ?? '') + delta.partial_json);
        if (structuredOutputBlocks.has(idx)) {
          // Structured-output forced tool: stream its JSON `input` as text content
          // (through the same template-token strip the text branch uses) so the
          // caller accumulates + parses it like an OpenAI `response_format` body.
          const token = stripTemplateTokens(delta.partial_json);
          if (token) yield { type: 'text_delta', text: token };
        } else {
          const tc = toolUseBlocks.get(idx);
          if (tc) {
            tc.args += delta.partial_json;
            yield { type: 'tool_call_delta' };
          }
        }
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const state = idx >= 0 ? openBlocks.get(idx) : undefined;
      if (state) {
        openBlocks.delete(idx);
        if (state.kind === 'thinking') {
          // Signature-less thinking can't round-trip — drop it (text already
          // streamed via text_delta would be absent here anyway; display is
          // unaffected). Matches the translator.
          if (state.signature) {
            yield {
              type: 'reasoning_block',
              block: { type: 'thinking', text: state.text, signature: state.signature },
            };
          }
        } else if (state.data) {
          yield { type: 'reasoning_block', block: { type: 'redacted_thinking', data: state.data } };
        }
      }
      if (idx >= 0) {
        const captured = capturedBlocks.get(idx);
        if (captured) {
          if (captured.type === 'thinking' && state?.kind === 'thinking') {
            captured.thinking = state.text;
            captured.signature = state.signature;
          } else if (captured.type === 'redacted_thinking' && state?.kind === 'redacted_thinking') {
            captured.data = state.data;
          }
          const pendingJson = inputJsonBuffers.get(idx);
          if (pendingJson !== undefined) {
            inputJsonBuffers.delete(idx);
            if (pendingJson.length > 0) {
              try {
                captured.input = JSON.parse(pendingJson);
              } catch {
                // Malformed partial JSON — keep whatever shape arrived in
                // content_block_start (often `{}`).
              }
            }
          }
        }
      }
      return;
    }

    if (
      eventType === 'message_start' ||
      eventType === 'message_delta' ||
      eventType === 'message_stop'
    ) {
      const message = parsed.message as Record<string, unknown> | undefined;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      updateUsage(
        (parsed.usage as Record<string, unknown> | undefined) ||
          (message?.usage as Record<string, unknown> | undefined) ||
          (delta?.usage as Record<string, unknown> | undefined),
      );

      if (eventType === 'message_delta' || eventType === 'message_stop') {
        const stopReason =
          typeof delta?.stop_reason === 'string'
            ? delta.stop_reason
            : typeof message?.stop_reason === 'string'
              ? message.stop_reason
              : null;
        if (stopReason || eventType === 'message_stop') {
          const mapped = mapAnthropicStopReason(stopReason);
          // Flush accumulated native tool calls before the terminal event, just
          // as the pump flushes on finish_reason / [DONE].
          yield* flushToolUse();
          if (mapped === 'pause_turn') {
            const assistantBlocks = Array.from(capturedBlocks.entries())
              .sort(([a], [b]) => a - b)
              .map(([, block]) => block);
            if (assistantBlocks.length > 0) {
              yield { type: 'pause_turn', assistantBlocks };
              stopped = true;
              return;
            }
            yield { type: 'done', finishReason: 'stop', usage };
            stopped = true;
            return;
          }
          // `mapped` is one of 'stop' | 'length' | 'tool_calls' here.
          yield { type: 'done', finishReason: mapped as 'stop' | 'length' | 'tool_calls', usage };
          stopped = true;
          return;
        }
      }
      return;
    }
  }

  const onAbort = () => {
    reader.cancel().catch(() => {
      /* reader may already be closed */
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        yield* processLine(line);
        if (stopped) return;
      }
    }

    // Stream ended without a terminal stop_reason / [DONE]. Flush any trailing
    // bytes + buffered line, then emit a clean terminal `done` so the consumer
    // never hangs — mirrors the translator's clean-close path.
    buffer += decoder.decode();
    if (buffer.trim()) {
      yield* processLine(buffer);
      if (stopped) return;
    }
    yield* flushToolUse();
    yield { type: 'done', finishReason: 'stop', usage };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
