/**
 * Provider stream adapter — returns a `PushStream<ChatMessage>` that runs
 * inside the CoderJob DO by calling the existing Worker provider handler
 * (e.g. `handleOpenRouterChat`) directly. Same architecture decision as
 * the executor adapter: skip HTTP self-loop, skip origin validation round
 * trip, reuse the exact upstream-proxy behaviour the browser path already
 * gets.
 *
 * Scope note (Phase 1):
 *   PR #3a wires the direct Worker handlers currently validated for
 *   background jobs: openrouter, ollama, cloudflare, zen, nvidia,
 *   blackbox, kilocode, and openadapter. Providers that still require
 *   extra runtime setup or are intentionally unsupported here return
 *   `null` from `resolveProviderHandler` so the caller can surface an
 *   explicit diagnostic and fail fast instead of silently hanging.
 *
 * SSE parsing:
 *   Providers proxy OpenAI-compatible SSE. We normalize CRLF to LF so
 *   providers that frame events with `\r\n\r\n` still split on the
 *   blank-line delimiter, parse `data: {...}` events, and yield
 *   `text_delta` events for `choices[0].delta.content`. Malformed chunks
 *   are skipped silently (providers interleave heartbeats that aren't
 *   always valid JSON); `[DONE]` sentinels close the stream cleanly.
 */

import type { AIProviderType, PushStream, PushStreamEvent } from '@push/lib/provider-contract';
import type { ChatMessage } from '@/types';
import type { Env } from './worker-middleware';
import {
  handleBlackboxChat,
  handleCloudflareChat,
  handleKiloCodeChat,
  handleNvidiaChat,
  handleOllamaChat,
  handleOpenAdapterChat,
  handleOpenRouterChat,
  handleZenChat,
} from './worker-providers';

export interface CoderJobStreamAdapterArgs {
  env: Env;
  origin: string;
  provider: AIProviderType;
  modelId: string | undefined;
  /** Unique per-job id — used to produce a stable rate-limit bucket
   * (`X-Forwarded-For: job:<jobId>`) so background-job traffic doesn't
   * collapse into the global `'unknown'` IP bucket and spuriously 429
   * other jobs. */
  jobId: string;
}

type ProviderHandler = (request: Request, env: Env) => Promise<Response>;

function resolveProviderHandler(provider: AIProviderType): ProviderHandler | null {
  switch (provider) {
    case 'openrouter':
      return handleOpenRouterChat as unknown as ProviderHandler;
    case 'ollama':
      return handleOllamaChat as unknown as ProviderHandler;
    case 'cloudflare':
      return handleCloudflareChat as unknown as ProviderHandler;
    case 'zen':
      return handleZenChat as unknown as ProviderHandler;
    case 'nvidia':
      return handleNvidiaChat as unknown as ProviderHandler;
    case 'blackbox':
      return handleBlackboxChat as unknown as ProviderHandler;
    case 'kilocode':
      return handleKiloCodeChat as unknown as ProviderHandler;
    case 'openadapter':
      return handleOpenAdapterChat as unknown as ProviderHandler;
    case 'demo':
      return null;
    // The remaining providers (azure, bedrock, vertex) exist on the
    // Worker but require extra runtime configuration this DO can't
    // exercise in Phase 1 — they stay gated until PR #3b validates them
    // against a real job.
    case 'azure':
    case 'bedrock':
    case 'vertex':
      return null;
  }
  return null;
}

export function createWebStreamAdapter(args: CoderJobStreamAdapterArgs): PushStream<ChatMessage> {
  // Strip trailing slash so URL construction can't produce double
  // slashes (`https://host//api/...`).
  const origin = args.origin.replace(/\/$/, '');
  const handler = resolveProviderHandler(args.provider);

  return (req) =>
    (async function* () {
      if (!handler) {
        throw new Error(
          `Background Coder jobs don't yet support provider "${args.provider}". ` +
            `Supported in Phase 1 PR #3a: openrouter, ollama, cloudflare, zen, nvidia, blackbox, kilocode, openadapter.`,
        );
      }

      const signal = req.signal;
      if (signal?.aborted) {
        throw new Error('Stream aborted before provider dispatch');
      }

      // Build an OpenAI-compatible chat payload. The Worker's
      // createStreamProxyHandler validates and normalizes this body
      // before forwarding upstream, so we only need the portable shape.
      const payloadMessages: Array<{ role: string; content: string }> = req.messages.map((m) => ({
        role: m.role,
        content: m.content ?? '',
      }));
      const systemPromptOverride = req.systemPromptOverride;
      if (systemPromptOverride && !payloadMessages.some((m) => m.role === 'system')) {
        payloadMessages.unshift({ role: 'system', content: systemPromptOverride });
      }

      const body = JSON.stringify({
        model: req.model || args.modelId,
        messages: payloadMessages,
        stream: true,
      });

      const request = new Request(`${origin}/api/${providerSlug(args.provider)}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: origin,
          // Stable per-job rate-limit key. Without this, the preamble's
          // `getClientIp(req)` falls back to 'unknown' for every
          // synthetic internal Request and all background jobs share one
          // bucket — a single burst can 429 every other running job.
          'X-Forwarded-For': `job:${args.jobId}`,
        },
        body,
        signal,
      });

      const response = (await handler(
        request as unknown as Request,
        args.env as unknown as Env,
      )) as unknown as Response;

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        throw new Error(
          `Provider ${args.provider} returned ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`,
        );
      }

      yield* pumpSseBody(response.body as unknown as ReadableStream<Uint8Array>, signal);
    })();
}

// Provider slug for URL construction. Matches PROVIDER_URLS in
// `app/src/lib/providers.ts`. Only used for the Request URL — the
// handler does the actual routing once called.
function providerSlug(provider: AIProviderType): string {
  return provider;
}

// ---------------------------------------------------------------------------
// SSE pump — parses an OpenAI-compatible stream body into PushStream events.
// ---------------------------------------------------------------------------

async function* pumpSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<PushStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Stream aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let delimiterIdx = buffer.indexOf('\n\n');
      while (delimiterIdx !== -1) {
        const rawEvent = buffer.slice(0, delimiterIdx);
        buffer = buffer.slice(delimiterIdx + 2);
        const yielded = parseSseEvent(rawEvent);
        for (const ev of yielded.events) {
          yield ev;
        }
        if (yielded.done) {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        delimiterIdx = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim().length > 0) {
      const yielded = parseSseEvent(buffer);
      for (const ev of yielded.events) {
        yield ev;
      }
    }
    yield { type: 'done', finishReason: 'stop' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader has already been closed —
      // harmless here, the stream is done either way.
    }
  }
}

function parseSseEvent(rawEvent: string): { events: PushStreamEvent[]; done: boolean } {
  const lines = rawEvent.split('\n');
  const dataParts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataParts.push(trimmed.slice(5).trim());
    }
  }
  if (dataParts.length === 0) return { events: [], done: false };
  const data = dataParts.join('\n');
  if (data === '[DONE]') return { events: [], done: true };
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    const events: PushStreamEvent[] = [];
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      events.push({ type: 'text_delta', text: delta });
    }
    const done = Boolean(parsed.choices?.[0]?.finish_reason);
    return { events, done };
  } catch {
    // Malformed chunk — skip quietly. Don't surface errors: providers
    // occasionally interleave heartbeats and non-JSON control frames.
    return { events: [], done: false };
  }
}
