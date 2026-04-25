import process from 'node:process';
import {
  BLACKBOX_DEFAULT_MODEL,
  KILOCODE_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENADAPTER_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  ZEN_DEFAULT_MODEL,
} from '../lib/provider-models.ts';
import type { AIProviderType, LlmMessage, PushStreamEvent } from '../lib/provider-contract.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { CliProviderError, createCliProviderStream } from './openai-stream.ts';

// Re-export the shared reasoning-token parser so existing imports keep
// working. The CLI used to ship its own copy in this file; the shared
// implementation in `lib/reasoning-tokens.ts` is byte-equivalent and is the
// canonical home now that `streamCompletion` no longer drives it directly.
export { createReasoningTokenParser } from '../lib/reasoning-tokens.ts';

export const DEFAULT_TIMEOUT_MS: number = 120_000;
export const MAX_RETRIES: number = 3;
const RETRY_BASE_DELAY_MS: number = 1_000;

export interface ProviderConfig {
  id: string;
  url: string;
  defaultModel: string;
  apiKeyEnv: string[];
  requiresKey: boolean;
}

export interface ProviderListEntry {
  id: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  hasKey: boolean;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface StreamCompletionOptions {
  onThinkingToken?: ((token: string | null) => void) | null;
  /** OpenRouter session_id for grouping related requests. */
  sessionId?: string;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof CliProviderError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Anything else (network failure, TypeError from a misbehaving fetch shim)
  // is treated as transport-level — matches the legacy parser that returned
  // `true` whenever there was no `Response` object on the catch.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    url:
      process.env.PUSH_OLLAMA_URL ||
      process.env.OLLAMA_API_URL ||
      'https://ollama.com/v1/chat/completions',
    defaultModel: process.env.PUSH_OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    requiresKey: true,
  },
  openrouter: {
    id: 'openrouter',
    url: process.env.PUSH_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: process.env.PUSH_OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    requiresKey: true,
  },
  zen: {
    id: 'zen',
    url: process.env.PUSH_ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions',
    defaultModel: process.env.PUSH_ZEN_MODEL || ZEN_DEFAULT_MODEL,
    apiKeyEnv: [
      'PUSH_ZEN_API_KEY',
      'ZEN_API_KEY',
      'OPENCODE_API_KEY',
      'VITE_ZEN_API_KEY',
      'VITE_OPENCODE_API_KEY',
    ],
    requiresKey: true,
  },
  nvidia: {
    id: 'nvidia',
    url: process.env.PUSH_NVIDIA_URL || 'https://integrate.api.nvidia.com/v1/chat/completions',
    defaultModel: process.env.PUSH_NVIDIA_MODEL || NVIDIA_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_NVIDIA_API_KEY', 'NVIDIA_API_KEY', 'VITE_NVIDIA_API_KEY'],
    requiresKey: true,
  },
  kilocode: {
    id: 'kilocode',
    url: process.env.PUSH_KILOCODE_URL || 'https://api.kilo.ai/api/gateway/chat/completions',
    defaultModel: process.env.PUSH_KILOCODE_MODEL || KILOCODE_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_KILOCODE_API_KEY', 'KILOCODE_API_KEY', 'VITE_KILOCODE_API_KEY'],
    requiresKey: true,
  },
  blackbox: {
    id: 'blackbox',
    // `api.blackbox.ai` is the JSON API host. `www.blackbox.ai` is the marketing
    // frontend and returns HTML, which breaks /models fetch (and chat) silently.
    url: process.env.PUSH_BLACKBOX_URL || 'https://api.blackbox.ai/chat/completions',
    defaultModel: process.env.PUSH_BLACKBOX_MODEL || BLACKBOX_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_BLACKBOX_API_KEY', 'BLACKBOX_API_KEY', 'VITE_BLACKBOX_API_KEY'],
    requiresKey: true,
  },
  openadapter: {
    id: 'openadapter',
    url: process.env.PUSH_OPENADAPTER_URL || 'https://api.openadapter.in/v1/chat/completions',
    defaultModel: process.env.PUSH_OPENADAPTER_MODEL || OPENADAPTER_DEFAULT_MODEL,
    apiKeyEnv: ['PUSH_OPENADAPTER_API_KEY', 'OPENADAPTER_API_KEY', 'VITE_OPENADAPTER_API_KEY'],
    requiresKey: true,
  },
};

export function resolveApiKey(config: ProviderConfig): string {
  for (const key of config.apiKeyEnv) {
    const value: string | undefined = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  if (config.requiresKey) {
    throw new Error(`Missing API key for ${config.id}. Set one of: ${config.apiKeyEnv.join(', ')}`);
  }
  return '';
}

/**
 * Return enriched metadata for all providers.
 * hasKey probes resolveApiKey without throwing.
 */
export function getProviderList(): ProviderListEntry[] {
  return Object.values(PROVIDER_CONFIGS).map((cfg: ProviderConfig) => {
    let hasKey: boolean = false;
    try {
      resolveApiKey(cfg);
      hasKey = true;
    } catch {
      /* key missing */
    }
    return {
      id: cfg.id,
      url: cfg.url,
      defaultModel: cfg.defaultModel,
      requiresKey: cfg.requiresKey,
      hasKey,
    };
  });
}

/**
 * Stream a chat completion through the shared PushStream gateway and drive
 * the legacy callback API on top of the parsed event stream.
 *
 * SSE parsing lives in `lib/openai-sse-pump.ts`; `<think>` ↔ native-reasoning
 * normalization lives in `lib/reasoning-tokens.ts#normalizeReasoning`. Both
 * are shared with the web orchestrator. This wrapper preserves the CLI's
 * retry policy (3 attempts, exponential backoff for 429 / 5xx / network),
 * activity-blind total-call timeout, and abort handling.
 */
export async function streamCompletion(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: ((token: string) => void) | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  externalSignal: AbortSignal | null = null,
  options: StreamCompletionOptions | undefined = undefined,
): Promise<string> {
  const onThinkingToken = options?.onThinkingToken ?? null;
  let lastError: Error | undefined;

  for (let attempt: number = 1; attempt <= MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      const err: Error = new Error('Request aborted.');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutController: AbortController = new AbortController();
    const timeout: ReturnType<typeof setTimeout> = setTimeout(
      () => timeoutController.abort(),
      timeoutMs,
    );
    const signals: AbortSignal[] = [timeoutController.signal];
    if (externalSignal) signals.push(externalSignal);
    const compositeSignal: AbortSignal = AbortSignal.any(signals);

    const stream = createCliProviderStream(config, apiKey, {
      sessionId: options?.sessionId,
    });

    let accumulated: string = '';
    let yieldedAny: boolean = false;

    try {
      // Map the lib-side message shape onto LlmMessage. The CLI doesn't
      // populate `id` / `timestamp`, but `LlmMessage` requires them — fill
      // with placeholders that the gateway never reads.
      const llmMessages: LlmMessage[] = messages.map((m, idx) => ({
        id: `cli-${idx}`,
        role: (m.role as LlmMessage['role']) || 'user',
        content: m.content,
        timestamp: 0,
      }));

      const events: AsyncIterable<PushStreamEvent> = normalizeReasoning(
        stream({
          provider: (config.id as AIProviderType) ?? 'openrouter',
          model,
          messages: llmMessages,
          signal: compositeSignal,
        }),
      );

      for await (const event of events) {
        yieldedAny = true;
        switch (event.type) {
          case 'text_delta':
            accumulated += event.text;
            onToken?.(event.text);
            break;
          case 'reasoning_delta':
            onThinkingToken?.(event.text);
            break;
          case 'reasoning_end':
            onThinkingToken?.(null);
            break;
          case 'tool_call_delta':
            // Structural progress signal — not surfaced through the legacy
            // callback API. The text-based dispatcher picks the assembled
            // call up later as a fenced JSON `text_delta`.
            break;
          case 'done':
            // Loop exits naturally when the iterator returns after `done`.
            break;
        }
      }

      clearTimeout(timeout);
      return accumulated;
    } catch (err) {
      clearTimeout(timeout);

      const isAbort: boolean =
        (err instanceof DOMException || err instanceof Error) &&
        (err as Error).name === 'AbortError';

      if (isAbort) {
        if (externalSignal?.aborted) {
          const abortErr: Error = new Error('Request aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)}s [provider=${config.id} model=${model} url=${config.url}]`,
        );
      }

      // Mid-stream failures (after the first event) cannot be retried — the
      // consumer has already observed partial output and a fresh attempt
      // would duplicate it.
      if (!yieldedAny && attempt < MAX_RETRIES && isRetryableError(err)) {
        lastError = err as Error;
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Provider request failed after retries');
}
