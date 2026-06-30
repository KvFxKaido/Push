/**
 * OpenAI Responses SSE pump.
 *
 * Converts `/v1/responses` typed streaming events into PushStreamEvent. This
 * is intentionally separate from `openai-sse-pump.ts`, which parses Chat
 * Completions-compatible `choices[0].delta` streams.
 */

import type { PushStreamEvent, StreamUsage, UrlCitation } from './provider-contract.js';
import { parseNativeToolCallArgs } from './openai-sse-pump.js';

/**
 * Normalize a Responses `url_citation` annotation into a `UrlCitation`. The
 * Responses shape is flat (`{ type, url, title, start_index, end_index }`),
 * unlike the Chat Completions shape where the fields nest under `url_citation`.
 * Returns null for anything that isn't a well-formed url_citation — a malformed
 * citation is display-only metadata loss, never a reason to disturb the stream.
 */
function parseResponsesAnnotation(value: unknown): UrlCitation | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== 'url_citation') return null;
  if (typeof rec.url !== 'string' || !rec.url) return null;
  return {
    url: rec.url,
    title: typeof rec.title === 'string' ? rec.title : rec.url,
    content: typeof rec.content === 'string' ? rec.content : '',
    startIndex: typeof rec.start_index === 'number' ? rec.start_index : 0,
    endIndex: typeof rec.end_index === 'number' ? rec.end_index : 0,
  };
}

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
  const pendingToolCalls = new Map<number, PendingResponseToolCall>();

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

    if (type === 'response.output_text.delta') {
      if (typeof parsed.delta === 'string' && parsed.delta) {
        yield { type: 'text_delta', text: parsed.delta };
      }
      return;
    }

    // Native web-search citations arrive as `url_citation` annotations on the
    // output text. Additive to the `text_delta` channel — the grounded answer
    // still streams as text; this carries the structured source for a "Sources"
    // UI affordance. Consumers dedupe by url. Emitted one-at-a-time as each
    // annotation lands.
    if (type === 'response.output_text.annotation.added') {
      const citation = parseResponsesAnnotation(parsed.annotation);
      if (citation) {
        yield { type: 'citations', citations: [citation] };
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
      type === 'response.reasoning_summary.delta'
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

    if (type === 'response.completed' || type === 'response.incomplete') {
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
        upsertToolCallsFromCompletedResponse(response);
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
