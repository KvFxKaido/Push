/**
 * Provider stream adapter — PR #3a real implementation.
 *
 * Builds a `ProviderStreamFn` that runs inside the CoderJob DO by
 * calling the existing Worker provider handler (e.g.
 * `handleOpenRouterChat`) directly — same architecture decision as
 * the executor adapter: skip HTTP self-loop, skip origin validation
 * round trip, reuse the exact upstream-proxy behavior the browser
 * path already gets.
 *
 * Scope note (Phase 1):
 *   Only OpenRouter is wired in PR #3a. Other providers return an
 *   explicit diagnostic via `onError` so a misconfigured background
 *   job fails fast instead of silently hanging. PR #3b / #4 can
 *   broaden the provider set as the UI exercises them — each
 *   additional provider is a ~3-line addition to the switch.
 *
 * SSE parsing:
 *   Providers proxy OpenAI-compatible SSE. We read chunks, split on
 *   blank-line delimiters, and dispatch `data: {...}` events through
 *   `onToken` / `onDone` / `onError`. Malformed chunks are logged
 *   once and skipped; [DONE] sentinels close the stream cleanly.
 */

import type { AIProviderType, ProviderStreamFn } from '@push/lib/provider-contract';
import type { ChatMessage } from '@/types';
import type { Env } from './worker-middleware';
import {
  handleBlackboxChat,
  handleNvidiaChat,
  handleOllamaChat,
  handleOpenAdapterChat,
  handleOpenRouterChat,
  handleZenChat,
  handleKiloCodeChat,
} from './worker-providers';

export interface CoderJobStreamAdapterArgs {
  env: Env;
  origin: string;
  provider: AIProviderType;
  modelId: string | undefined;
}

type ProviderHandler = (request: Request, env: Env) => Promise<Response>;

function resolveProviderHandler(provider: AIProviderType): ProviderHandler | null {
  switch (provider) {
    case 'openrouter':
      return handleOpenRouterChat as unknown as ProviderHandler;
    case 'ollama':
      return handleOllamaChat as unknown as ProviderHandler;
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
    // Zen-Go isn't a distinct AIProviderType at the kernel level — it's a
    // flavor of 'zen' toggled client-side. Treated here as a sibling
    // handler in case a future provider picks up the label.
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
  // Exhaustive switch above; this satisfies TS when ZenGo etc. are added.
  const _void: ProviderHandler | null = null;
  void _void;
  return null;
}

export function createWebStreamAdapter(
  args: CoderJobStreamAdapterArgs,
): ProviderStreamFn<ChatMessage> {
  const handler = resolveProviderHandler(args.provider);

  return async (
    messages,
    onToken,
    onDone,
    onError,
    _onThinkingToken,
    _ws,
    _hasSandbox,
    modelOverride,
    systemPromptOverride,
  ) => {
    if (!handler) {
      onError(
        new Error(
          `Background Coder jobs don't yet support provider "${args.provider}". ` +
            `Supported in Phase 1 PR #3a: openrouter, ollama, zen, nvidia, blackbox, kilocode, openadapter.`,
        ),
      );
      return;
    }

    // Build an OpenAI-compatible chat payload. The Worker's
    // createStreamProxyHandler validates and normalizes this body
    // before forwarding upstream, so we only need the portable shape.
    // `role` is widened to string because the Coder kernel mixes in
    // 'system' messages that the Web ChatMessage union doesn't carry.
    const payloadMessages: Array<{ role: string; content: string }> = messages.map((m) => ({
      role: m.role,
      content: m.content ?? '',
    }));
    if (systemPromptOverride && !payloadMessages.some((m) => m.role === 'system')) {
      payloadMessages.unshift({ role: 'system', content: systemPromptOverride });
    }

    const body = JSON.stringify({
      model: modelOverride ?? args.modelId,
      messages: payloadMessages,
      stream: true,
    });

    const request = new Request(`${args.origin}/api/${providerSlug(args.provider)}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: args.origin,
      },
      body,
    });

    let response: Response;
    try {
      response = (await handler(
        request as unknown as Request,
        args.env as unknown as Env,
      )) as unknown as Response;
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      onError(
        new Error(
          `Provider ${args.provider} returned ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`,
        ),
      );
      return;
    }

    await pumpSseBody(
      response.body as unknown as ReadableStream<Uint8Array>,
      onToken,
      onDone,
      onError,
    );
  };
}

// Provider slug for URL construction. Matches PROVIDER_URLS in
// `app/src/lib/providers.ts`. Only used for the Request URL — the
// handler does the actual routing once called.
function providerSlug(provider: AIProviderType): string {
  return provider;
}

// ---------------------------------------------------------------------------
// SSE pump — parses an OpenAI-compatible stream body.
// ---------------------------------------------------------------------------

async function pumpSseBody(
  body: ReadableStream<Uint8Array>,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines. Split off complete
      // events; keep any partial trailing event in `buffer`.
      let delimiterIdx = buffer.indexOf('\n\n');
      while (delimiterIdx !== -1) {
        const rawEvent = buffer.slice(0, delimiterIdx);
        buffer = buffer.slice(delimiterIdx + 2);
        const handled = handleSseEvent(rawEvent, onToken);
        if (handled === 'done') {
          closed = true;
          onDone();
          return;
        }
        delimiterIdx = buffer.indexOf('\n\n');
      }
    }
    // Flush any trailing event the stream closed before we saw \n\n on.
    if (buffer.trim().length > 0) {
      handleSseEvent(buffer, onToken);
    }
    if (!closed) onDone();
  } catch (err) {
    if (!closed) onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader has already been closed —
      // harmless here, the stream is done either way.
    }
  }
}

function handleSseEvent(rawEvent: string, onToken: (token: string) => void): 'continue' | 'done' {
  // An SSE event can span multiple `data: ` lines; OpenAI-format
  // streams use exactly one data line per event in practice, but we
  // tolerate both.
  const lines = rawEvent.split('\n');
  const dataParts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataParts.push(trimmed.slice(5).trim());
    }
  }
  if (dataParts.length === 0) return 'continue';
  const data = dataParts.join('\n');
  if (data === '[DONE]') return 'done';
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      onToken(delta);
    }
    if (parsed.choices?.[0]?.finish_reason) {
      return 'done';
    }
  } catch {
    // Malformed chunk — skip quietly. Don't fire onError: providers
    // occasionally interleave heartbeats and non-JSON control frames.
  }
  return 'continue';
}
