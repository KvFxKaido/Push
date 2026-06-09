import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIReasoningBlock,
} from './openai-chat-types.ts';
import type { LlmMessage, PushStreamRequest } from './provider-contract.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from './context-transformer.ts';

/**
 * Anthropic removed `temperature`, `top_p`, and `top_k` on Opus 4.7 and every
 * later Opus (4.8 inherits the same request surface). Sending any of them
 * returns a 400 (`invalid_request_error`). Sonnet 4.6, Haiku 4.5, and
 * Opus 4.6-and-earlier still accept them.
 *
 * The model id reaching this bridge is the native Anthropic form
 * (`claude-opus-4-7`, `claude-opus-4-8`, optionally date- or `@`-suffixed, or
 * the `[1m]` long-context tag). We parse the Opus major/minor and reject 4.7+
 * (and any future Opus 5+). The single-digit-minor guard `(?!\d)` keeps the
 * dated 4.0 id `claude-opus-4-20250514` from being misread as "Opus 4.<date>".
 *
 * Non-Opus models (and non-Anthropic models that pass through this bridge, e.g.
 * Zen-Go's `minimax-*`) return false, so their sampling params flow unchanged.
 */
export function anthropicModelRejectsSamplingParams(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const match = model.toLowerCase().match(/claude-opus-(\d+)(?:[-.](\d{1,2})(?!\d))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (major > 4) return true; // future Opus generations inherit the removed surface
  if (major < 4) return false; // Opus 3 and earlier accepted sampling params
  return minor >= 7; // Opus 4.7 / 4.8 / 4.9 …
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

function buildOpenAISseChunk(params: {
  model: string;
  content?: string;
  reasoningBlock?: OpenAIReasoningBlock;
  finishReason?: string | null;
  /**
   * Push-private sidecar: when finishReason is `'pause_turn'`, this carries
   * the full assistant `content[]` array from the paused upstream so the
   * pump can surface it to the stream adapter for a continuation request.
   */
  assistantBlocks?: Array<Record<string, unknown>>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}): string {
  const delta: Record<string, unknown> = {};
  if (params.content) delta.content = params.content;
  if (params.reasoningBlock) delta.reasoning_block = params.reasoningBlock;
  if (params.assistantBlocks) delta.assistant_content_blocks = params.assistantBlocks;

  const payload: Record<string, unknown> = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };

  if (params.usage) {
    payload.usage = {
      prompt_tokens: params.usage.prompt_tokens ?? 0,
      completion_tokens: params.usage.completion_tokens ?? 0,
      total_tokens: params.usage.total_tokens ?? 0,
    };
  }

  return `data: ${JSON.stringify(payload)}\n\n`;
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
 * drift test in `openai-anthropic-bridge.test.ts` pins.
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

  // Anthropic's native server-side web search. The model emits
  // `server_tool_use` + `web_search_tool_result` content blocks alongside
  // its text response; our SSE translator ignores those block types (only
  // text and signed thinking flow through), so the user sees the model's
  // narration including any inline citations. Multi-turn round-trip of
  // the search blocks is lossy — but the model can simply re-search on
  // the next turn, so functionally it works.
  if (parts.enableWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  return body;
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
 * test in `openai-anthropic-bridge.test.ts` and by the CLI adapter's
 * body-capture suite (`cli/tests/anthropic-stream.test.mjs`).
 */
export function toAnthropicMessages(
  req: PushStreamRequest<LlmMessage>,
  options?: ToAnthropicMessagesOptions,
): Record<string, unknown> {
  const messages = Array.isArray(req.messages) ? req.messages : [];
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
          { type: 'text', text: content, cache_control: { type: 'ephemeral' } },
        ])
      : convertOpenAIContentToAnthropic(content);

  const pushSystem = (content: string, tagged: boolean): void => {
    for (const part of toContent(content, tagged)) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        if (part.cache_control) systemHasCacheControl = true;
        systemBlocks.push(part);
      }
    }
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
      pushSystem(m.content, tagged);
      return;
    }

    const contentBlocks = toContent(m.content, tagged);
    if (m.role === 'assistant') {
      const reasoning = reasoningBlocksToAnthropic(m.reasoningBlocks);
      anthropicMessages.push({
        role: 'assistant',
        content: reasoning.length > 0 ? [...reasoning, ...contentBlocks] : contentBlocks,
      });
    } else {
      anthropicMessages.push({ role: 'user', content: contentBlocks });
    }
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
    temperature:
      typeof req.temperature === 'number' ? req.temperature : options?.temperatureDefault,
    topP: req.topP,
    enableWebSearch: options?.enableWebSearch ?? req.anthropicWebSearch === true,
    anthropicVersion: options?.anthropicVersion,
    emitModel: model,
  });
}

export function createAnthropicTranslatedStream(
  upstream: Response,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, finishReason: 'stop' })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      let buffer = '';
      let usage:
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        | undefined;

      // Per-index thinking-block accumulators. Anthropic streams open a
      // `thinking` or `redacted_thinking` block via `content_block_start`,
      // emit zero or more `thinking_delta` + a single `signature_delta`,
      // then close with `content_block_stop`. We accumulate until stop and
      // emit a single structured `reasoning_block` SSE chunk so the OpenAI
      // pump can persist it onto the assistant message intact — the
      // signature is what makes the next turn round-trippable, so
      // splitting it across multiple deltas would force every consumer to
      // re-assemble.
      type ThinkingState = {
        kind: 'thinking';
        text: string;
        signature: string;
      };
      type RedactedState = { kind: 'redacted_thinking'; data: string };
      const openBlocks = new Map<number, ThinkingState | RedactedState>();

      // Per-index full-content capture for `pause_turn` continuation. We
      // keep the original `content_block_start` payload (so server_tool_use
      // / web_search_tool_result blocks survive opaquely) and accumulate
      // text / thinking / input_json deltas onto it as they arrive. On
      // `pause_turn` stop_reason we emit the assembled blocks via the
      // pump's `assistant_content_blocks` sidecar so the stream adapter
      // can replay them in a follow-up request and continue the turn.
      const capturedBlocks = new Map<number, Record<string, unknown>>();
      // Accumulates partial JSON for server_tool_use input across
      // `input_json_delta` events. Joined on content_block_stop.
      const inputJsonBuffers = new Map<number, string>();

      const processSseLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return false;
        const jsonStr = line[5] === ' ' ? line.slice(6) : line.slice(5);
        if (jsonStr === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return true;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          return false;
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
            }
            // Capture the raw block shape for pause_turn replay. We keep a
            // shallow clone so subsequent delta accumulation doesn't mutate
            // the upstream's view of the payload.
            capturedBlocks.set(idx, { ...block });
          }
          return false;
        }

        if (eventType === 'content_block_stop') {
          const idx = typeof parsed.index === 'number' ? parsed.index : -1;
          const state = idx >= 0 ? openBlocks.get(idx) : undefined;
          if (state) {
            openBlocks.delete(idx);
            if (state.kind === 'thinking') {
              // Drop blocks with no signature: without one Anthropic
              // would reject the round-trip on the next turn anyway, and
              // emitting a half-formed block would just push the failure
              // downstream. Text-only thinking still flows via the
              // existing reasoning_delta channel for display.
              if (state.signature) {
                controller.enqueue(
                  encoder.encode(
                    buildOpenAISseChunk({
                      model,
                      reasoningBlock: {
                        type: 'thinking',
                        text: state.text,
                        signature: state.signature,
                      },
                    }),
                  ),
                );
              }
            } else if (state.data) {
              controller.enqueue(
                encoder.encode(
                  buildOpenAISseChunk({
                    model,
                    reasoningBlock: { type: 'redacted_thinking', data: state.data },
                  }),
                ),
              );
            }
          }
          // Finalize the captured block for pause_turn replay. Patch the
          // accumulated text / thinking / signature / input back onto the
          // raw block so replaying it as `content[]` round-trips with
          // upstream's expected shape.
          if (idx >= 0) {
            const captured = capturedBlocks.get(idx);
            if (captured) {
              if (captured.type === 'thinking' && state?.kind === 'thinking') {
                captured.thinking = state.text;
                captured.signature = state.signature;
              } else if (
                captured.type === 'redacted_thinking' &&
                state?.kind === 'redacted_thinking'
              ) {
                captured.data = state.data;
              }
              const pendingJson = inputJsonBuffers.get(idx);
              if (pendingJson !== undefined) {
                inputJsonBuffers.delete(idx);
                if (pendingJson.length > 0) {
                  try {
                    captured.input = JSON.parse(pendingJson);
                  } catch {
                    // Malformed partial JSON shouldn't crash the bridge —
                    // upstream may have closed mid-token. Leave the
                    // captured `input` at whatever shape arrived in
                    // `content_block_start` (often `{}`).
                  }
                }
              }
            }
          }
          return false;
        }

        if (eventType === 'content_block_delta') {
          const idx = typeof parsed.index === 'number' ? parsed.index : -1;
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            controller.enqueue(encoder.encode(buildOpenAISseChunk({ model, content: delta.text })));
            // Accumulate onto the captured block so the replay payload
            // carries the full text the model emitted before pausing.
            const captured = idx >= 0 ? capturedBlocks.get(idx) : undefined;
            if (captured && captured.type === 'text') {
              captured.text = (typeof captured.text === 'string' ? captured.text : '') + delta.text;
            }
            return false;
          }
          // Thinking deltas ride a separate per-block state machine.
          // Anthropic emits `thinking_delta` for the visible reasoning
          // text and `signature_delta` for the cryptographic signature
          // that makes the block round-trippable. We accumulate both into
          // the open state and flush together at content_block_stop.
          const state = idx >= 0 ? openBlocks.get(idx) : undefined;
          if (state?.kind === 'thinking') {
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              state.text += delta.thinking;
            } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
              state.signature += delta.signature;
            }
          }
          // server_tool_use blocks stream their `input` field as
          // `input_json_delta` partials. Concatenate the partials so we
          // can JSON-parse the complete object at content_block_stop.
          if (
            delta?.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string' &&
            idx >= 0
          ) {
            inputJsonBuffers.set(idx, (inputJsonBuffers.get(idx) ?? '') + delta.partial_json);
          }
          return false;
        }

        if (
          eventType === 'message_start' ||
          eventType === 'message_delta' ||
          eventType === 'message_stop'
        ) {
          const message = parsed.message as Record<string, unknown> | undefined;
          const delta = parsed.delta as Record<string, unknown> | undefined;
          const usageRec =
            (parsed.usage as Record<string, unknown> | undefined) ||
            (message?.usage as Record<string, unknown> | undefined) ||
            (delta?.usage as Record<string, unknown> | undefined);
          if (usageRec) {
            const promptTokens =
              typeof usageRec.input_tokens === 'number'
                ? usageRec.input_tokens
                : (usage?.prompt_tokens ?? 0);
            const completionTokens =
              typeof usageRec.output_tokens === 'number'
                ? usageRec.output_tokens
                : (usage?.completion_tokens ?? 0);
            usage = {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            };
          }

          if (eventType === 'message_delta' || eventType === 'message_stop') {
            const stopReason =
              typeof delta?.stop_reason === 'string'
                ? delta.stop_reason
                : typeof message?.stop_reason === 'string'
                  ? message.stop_reason
                  : null;
            if (stopReason || eventType === 'message_stop') {
              const mappedFinish = mapAnthropicStopReason(stopReason);
              // On `pause_turn`, attach the captured assistant content[] so
              // the pump can surface it to the stream adapter for replay.
              // We sort by index so the upstream's content[] ordering is
              // preserved through the round-trip (Anthropic relies on it).
              const assistantBlocks =
                mappedFinish === 'pause_turn'
                  ? Array.from(capturedBlocks.entries())
                      .sort(([a], [b]) => a - b)
                      .map(([, block]) => block)
                  : undefined;
              controller.enqueue(
                encoder.encode(
                  buildOpenAISseChunk({
                    model,
                    finishReason: mappedFinish,
                    ...(assistantBlocks ? { assistantBlocks } : {}),
                    usage,
                  }),
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return true;
            }
          }
        }

        return false;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            if (processSseLine(rawLine)) return;
          }
        }

        if (buffer.trim()) {
          if (processSseLine(buffer)) return;
        }

        controller.enqueue(
          encoder.encode(buildOpenAISseChunk({ model, finishReason: 'stop', usage })),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
