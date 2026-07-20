/**
 * OpenAI Responses SSE pump.
 *
 * Converts `/v1/responses` typed streaming events into PushStreamEvent. This
 * is intentionally separate from `openai-sse-pump.ts`, which parses Chat
 * Completions-compatible `choices[0].delta` streams.
 */

import type { PushStreamEvent, StreamUsage, UrlCitation } from './provider-contract.js';
import { parseNativeToolCallArgs } from './openai-sse-pump.js';
import { parseResponsesReasoningItem } from './responses-reasoning-item.js';

export interface OpenAIResponsesSSEPumpOptions {
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  isKnownToolName?: (name: string) => boolean;
}

interface PendingResponseToolCall {
  id?: string;
  callId: string;
  name: string;
  args: string;
  flushed: boolean;
}

export class OpenAIResponsesStreamError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts?: { code?: string; status?: number }) {
    super(message);
    this.name = 'OpenAIResponsesStreamError';
    const status = opts?.status;
    this.code = opts?.code;
    this.status = status;
    // Fail open on an unclassifiable code (no mapped status): an in-band error
    // we can't pin to a status is at least as likely transient as a dead
    // transport, which this module already treats as retryable. Only the
    // *explicitly* classified terminal statuses (400/401/403/404) stay
    // non-retryable — flipping this default back to false silently turns
    // recoverable provider blips into hard turn failures.
    this.retryable =
      status === undefined ||
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (status >= 500 && status <= 599);
  }
}

export function mapOpenAIResponsesUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}): StreamUsage {
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    ...(typeof cachedInputTokens === 'number' && { cachedInputTokens }),
  };
}

function errorRecordFromEvent(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const error = parsed.error;
  if (error && typeof error === 'object') {
    return error as Record<string, unknown>;
  }
  const response =
    parsed.response && typeof parsed.response === 'object'
      ? (parsed.response as Record<string, unknown>)
      : null;
  const responseError = response?.error;
  if (responseError && typeof responseError === 'object') {
    return responseError as Record<string, unknown>;
  }
  return null;
}

function statusFromResponsesError(error: Record<string, unknown> | null): number | undefined {
  if (!error) return undefined;
  const raw = [error.code, error.type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (!raw) return undefined;
  if (raw.includes('not_found') || raw.includes('not found')) return 404;
  if (raw.includes('unauthorized') || raw.includes('authentication')) return 401;
  if (raw.includes('forbidden') || raw.includes('permission')) return 403;
  if (raw.includes('rate_limit') || raw.includes('rate limit')) return 429;
  if (raw.includes('invalid_request') || raw.includes('bad_request')) return 400;
  if (raw.includes('service_unavailable') || raw.includes('unavailable')) return 503;
  if (raw.includes('overloaded') || raw.includes('server_error')) return 500;
  return undefined;
}

function errorCodeFromRecord(error: Record<string, unknown> | null): string | undefined {
  return typeof error?.code === 'string'
    ? error.code
    : typeof error?.type === 'string'
      ? error.type
      : undefined;
}

function errorMessageFromEvent(parsed: Record<string, unknown>): string {
  const error = errorRecordFromEvent(parsed);
  const message = typeof error?.message === 'string' ? error.message : undefined;
  const code = errorCodeFromRecord(error);
  if (message && code) return `${code}: ${message}`;
  if (message) return message;
  if (typeof parsed.message === 'string') return parsed.message;
  return 'unknown stream error';
}

function parseResponseUrlCitation(value: unknown): UrlCitation | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== 'url_citation') return null;
  // Responses streaming annotations are flat, while some compatible gateways
  // place final message annotations under `url_citation` like Chat Completions.
  // Accept both and drop malformed citations without disturbing text output.
  const source =
    rec.url_citation && typeof rec.url_citation === 'object'
      ? (rec.url_citation as Record<string, unknown>)
      : rec;
  if (typeof source.url !== 'string' || !source.url) return null;
  return {
    url: source.url,
    title: typeof source.title === 'string' ? source.title : '',
    content: typeof source.content === 'string' ? source.content : '',
    startIndex: typeof source.start_index === 'number' ? source.start_index : 0,
    endIndex: typeof source.end_index === 'number' ? source.end_index : 0,
  };
}

function parseResponseUrlCitations(value: unknown): UrlCitation[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const citation = parseResponseUrlCitation(entry);
      return citation ? [citation] : [];
    });
  }
  const citation = parseResponseUrlCitation(value);
  return citation ? [citation] : [];
}

function responseOutputAnnotations(response: Record<string, unknown>): UrlCitation[] {
  if (!Array.isArray(response.output)) return [];
  const citations: UrlCitation[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    citations.push(...parseResponseUrlCitations(record.annotations));
    citations.push(...parseResponseUrlCitations(record.annotation));

    if (!Array.isArray(record.content)) continue;
    for (const content of record.content) {
      if (!content || typeof content !== 'object') continue;
      const contentRecord = content as Record<string, unknown>;
      citations.push(...parseResponseUrlCitations(contentRecord.annotations));
      citations.push(...parseResponseUrlCitations(contentRecord.annotation));
    }
  }
  return citations;
}

export async function* openAIResponsesSSEPump(
  opts: OpenAIResponsesSSEPumpOptions,
): AsyncIterable<PushStreamEvent> {
  const { body, signal, isKnownToolName } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;
  let pendingUsage: StreamUsage | undefined;
  let emittedToolCall = false;
  const emittedCitationKeys = new Set<string>();
  const emittedReasoningItemKeys = new Set<string>();
  const pendingToolCalls = new Map<number, PendingResponseToolCall>();

  function newCitations(citations: UrlCitation[]): UrlCitation[] {
    const out: UrlCitation[] = [];
    for (const citation of citations) {
      const key = `${citation.url}\n${citation.startIndex}\n${citation.endIndex}\n${citation.title}`;
      if (emittedCitationKeys.has(key)) continue;
      emittedCitationKeys.add(key);
      out.push(citation);
    }
    return out;
  }

  function* flushToolCall(index: number): Generator<PushStreamEvent> {
    const call = pendingToolCalls.get(index);
    if (!call || call.flushed) return;
    if (!call.name) {
      console.warn(
        '[Push] OpenAI Responses function call with no name - args dropped:',
        call.args.slice(0, 200),
      );
      call.flushed = true;
      return;
    }
    if (isKnownToolName && !isKnownToolName(call.name)) {
      console.warn(
        `[Push] OpenAI Responses function call "${call.name}" is not a known tool - dropped`,
      );
      call.flushed = true;
      return;
    }
    call.flushed = true;
    emittedToolCall = true;
    yield {
      type: 'native_tool_call',
      call: {
        ...(call.callId ? { id: call.callId } : call.id ? { id: call.id } : {}),
        name: call.name,
        args: parseNativeToolCallArgs(call.args),
      },
    };
  }

  function upsertToolCall(index: number, item: Record<string, unknown> | undefined): void {
    if (!item) return;
    const existing = pendingToolCalls.get(index) ?? {
      callId: '',
      name: '',
      args: '',
      flushed: false,
    };
    if (typeof item.id === 'string') existing.id = item.id;
    if (typeof item.call_id === 'string') existing.callId = item.call_id;
    if (typeof item.name === 'string') existing.name = item.name;
    if (typeof item.arguments === 'string') existing.args = item.arguments;
    pendingToolCalls.set(index, existing);
  }

  function* flushAllToolCalls(): Generator<PushStreamEvent> {
    for (const index of pendingToolCalls.keys()) {
      yield* flushToolCall(index);
    }
  }

  function* emitReasoningItem(value: unknown): Generator<PushStreamEvent> {
    const item = parseResponsesReasoningItem(value);
    if (!item) return;
    const key = item.id ? `id:${item.id}` : `encrypted:${item.encrypted_content}`;
    if (emittedReasoningItemKeys.has(key)) return;
    emittedReasoningItemKeys.add(key);
    yield { type: 'responses_reasoning_item', item };
  }

  function* emitReasoningItemsFromResponse(
    response: Record<string, unknown>,
  ): Generator<PushStreamEvent> {
    if (!Array.isArray(response.output)) return;
    for (const item of response.output) yield* emitReasoningItem(item);
  }

  function hasNamedToolCall(index: number): boolean {
    const call = pendingToolCalls.get(index);
    return Boolean(call && !call.flushed && call.name);
  }

  function upsertToolCallsFromCompletedResponse(response: Record<string, unknown>): void {
    if (!Array.isArray(response.output)) return;
    for (const [index, item] of response.output.entries()) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.type !== 'function_call') continue;
      upsertToolCall(index, record);
    }
  }

  function* parseEvent(rawEvent: string): Generator<PushStreamEvent> {
    if (stopped) return;
    const lines = rawEvent.split('\n');
    const dataParts: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data:')) {
        dataParts.push(trimmed.slice(5).trimStart());
      }
    }
    if (dataParts.length === 0) return;
    const data = dataParts.join('\n');
    if (data === '[DONE]') {
      yield* flushAllToolCalls();
      yield {
        type: 'done',
        finishReason: emittedToolCall ? 'tool_calls' : 'stop',
        usage: pendingUsage,
      };
      stopped = true;
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';

    if (type === 'response.output_text.delta' || type === 'response.content_part.delta') {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        yield { type: 'text_delta', text: parsed.delta };
      }
      return;
    }

    // Native web-search citations arrive as `url_citation` annotations on the
    // output text. Additive to the `text_delta` channel — the grounded answer
    // still streams as text; this carries the structured source for a "Sources"
    // UI affordance. Deduped when providers repeat the same annotation in a
    // later completed-response payload.
    if (type === 'response.output_text.annotation.added') {
      const citations = newCitations(parseResponseUrlCitations(parsed.annotation));
      if (citations.length > 0) {
        yield { type: 'citations', citations };
      }
      return;
    }

    // Safety refusals stream on the refusal channel, not `output_text`. Surface
    // them as visible text so a refused turn renders the model's explanation
    // instead of completing as a blank assistant response. (Codex P2, #1170.)
    if (type === 'response.refusal.delta') {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        yield { type: 'text_delta', text: parsed.delta };
      }
      return;
    }

    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_summary.delta' ||
      // OpenRouter's documented beta vocabulary uses the shorter
      // `reasoning.delta` event alongside the provider-specific family below.
      type === 'response.reasoning.delta' ||
      // OpenRouter serves two reasoning-event vocabularies: OpenAI emits the
      // `reasoning_summary_*` family, while GLM / DeepSeek / Kimi emit
      // `reasoning_text.delta`. Both carry the thinking text on `.delta`. Missing
      // the second silently drops reasoning — and for models that answer IN the
      // reasoning channel it drops the whole turn. Verified against the live
      // `/responses` model sweep.
      type === 'response.reasoning_text.delta'
    ) {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        yield { type: 'reasoning_delta', text: parsed.delta };
      }
      return;
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
      const item =
        parsed.item && typeof parsed.item === 'object'
          ? (parsed.item as Record<string, unknown>)
          : undefined;
      if (item?.type === 'function_call') {
        upsertToolCall(outputIndex, item);
        if (type === 'response.output_item.done') {
          yield* flushToolCall(outputIndex);
        }
      } else if (type === 'response.output_item.done') {
        yield* emitReasoningItem(item);
      }
      return;
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
      const existing = pendingToolCalls.get(outputIndex) ?? {
        callId: '',
        name: '',
        args: '',
        flushed: false,
      };
      if (typeof parsed.delta === 'string') existing.args += parsed.delta;
      pendingToolCalls.set(outputIndex, existing);
      yield { type: 'tool_call_delta' };
      return;
    }

    if (type === 'response.function_call_arguments.done') {
      const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0;
      const item =
        parsed.item && typeof parsed.item === 'object'
          ? (parsed.item as Record<string, unknown>)
          : parsed;
      upsertToolCall(outputIndex, item);
      if (hasNamedToolCall(outputIndex)) {
        yield* flushToolCall(outputIndex);
      }
      return;
    }

    if (
      type === 'response.completed' ||
      type === 'response.done' ||
      type === 'response.incomplete'
    ) {
      const response =
        parsed.response && typeof parsed.response === 'object'
          ? (parsed.response as Record<string, unknown>)
          : undefined;
      const usage =
        response?.usage && typeof response.usage === 'object'
          ? mapOpenAIResponsesUsage(response.usage as Parameters<typeof mapOpenAIResponsesUsage>[0])
          : undefined;
      pendingUsage = usage ?? pendingUsage;
      if (response) {
        yield* emitReasoningItemsFromResponse(response);
        upsertToolCallsFromCompletedResponse(response);
        const citations = newCitations(responseOutputAnnotations(response));
        if (citations.length > 0) {
          yield { type: 'citations', citations };
        }
      }
      yield* flushAllToolCalls();
      const incompleteReason =
        response?.incomplete_details && typeof response.incomplete_details === 'object'
          ? (response.incomplete_details as Record<string, unknown>).reason
          : undefined;
      yield {
        type: 'done',
        finishReason:
          type === 'response.incomplete'
            ? incompleteReason === 'max_output_tokens'
              ? 'length'
              : 'unknown'
            : emittedToolCall
              ? 'tool_calls'
              : 'stop',
        usage: pendingUsage,
      };
      stopped = true;
      return;
    }

    if (type === 'response.failed' || type === 'error') {
      stopped = true;
      const error = errorRecordFromEvent(parsed);
      throw new OpenAIResponsesStreamError(
        `OpenAI Responses stream error: ${errorMessageFromEvent(parsed)}`,
        { code: errorCodeFromRecord(error), status: statusFromResponsesError(error) },
      );
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
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let delimiterIdx = buffer.indexOf('\n\n');
      while (delimiterIdx !== -1) {
        const rawEvent = buffer.slice(0, delimiterIdx);
        buffer = buffer.slice(delimiterIdx + 2);
        yield* parseEvent(rawEvent);
        if (stopped) return;
        delimiterIdx = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      yield* parseEvent(buffer);
      buffer = '';
      if (stopped) return;
    }
    yield* flushAllToolCalls();
    yield {
      type: 'done',
      finishReason: emittedToolCall ? 'tool_calls' : 'stop',
      usage: pendingUsage,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* reader may have been cancelled */
    }
  }
}
