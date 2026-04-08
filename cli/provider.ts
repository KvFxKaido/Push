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

interface ReasoningTokenParser {
  pushContent: (rawToken: string) => void;
  pushReasoning: (token: string) => void;
  flush: () => void;
  closeThinking: () => void;
}

function isRetryableError(err: unknown, response: Response | undefined): boolean {
  if (!response) return true; // network error
  const status: number = response.status;
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    url: process.env.PUSH_OLLAMA_URL || process.env.OLLAMA_API_URL || 'https://ollama.com/v1/chat/completions',
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
    apiKeyEnv: [
      'PUSH_NVIDIA_API_KEY',
      'NVIDIA_API_KEY',
      'VITE_NVIDIA_API_KEY',
    ],
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
    url: process.env.PUSH_BLACKBOX_URL || 'https://www.blackbox.ai/chat/completions',
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
    } catch { /* key missing */ }
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
 * Split provider output into visible assistant content vs reasoning/thinking tokens.
 * Handles both explicit `<think>...</think>` blocks in streamed content and native
 * `reasoning_content` deltas (routed via pushReasoning()).
 */
export function createReasoningTokenParser(
  onContentToken: ((token: string) => void) | null | undefined,
  onThinkingToken: ((token: string | null) => void) | null | undefined,
): ReasoningTokenParser {
  let insideThink: boolean = false;
  let tagBuffer: string = '';
  let thinkingOpen: boolean = false;

  function emitContent(token: string): void {
    if (!token) return;
    onContentToken?.(token);
  }

  function emitThinking(token: string): void {
    if (!token) return;
    thinkingOpen = true;
    onThinkingToken?.(token);
  }

  function closeThinking(): void {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    onThinkingToken?.(null);
  }

  function pushContent(rawToken: string): void {
    if (!rawToken) return;
    tagBuffer += rawToken;

    // Detect <think> opening outside a think block.
    if (!insideThink && tagBuffer.includes('<think>')) {
      const parts: string[] = tagBuffer.split('<think>');
      const before: string = parts.shift() || '';
      const afterOpen: string = parts.join('<think>');
      if (before) {
        closeThinking();
        emitContent(before);
      }
      insideThink = true;
      thinkingOpen = true;
      tagBuffer = '';
      if (afterOpen) {
        pushContent(afterOpen);
      }
      return;
    }

    // Inside <think>...</think> — emit to reasoning channel.
    if (insideThink) {
      if (tagBuffer.includes('</think>')) {
        const thinkContent: string = tagBuffer.split('</think>')[0];
        if (thinkContent) emitThinking(thinkContent);
        closeThinking();

        const after: string = tagBuffer.split('</think>').slice(1).join('</think>');
        insideThink = false;
        tagBuffer = '';
        const cleaned: string = after.replace(/^\s+/, '');
        if (cleaned) emitContent(cleaned);
      } else {
        // Hold a short tail so split closing tags can still be detected.
        const safe: string = tagBuffer.slice(0, -10);
        if (safe) emitThinking(safe);
        tagBuffer = tagBuffer.slice(-10);
      }
      return;
    }

    // Normal content — flush when we are not holding a possible partial tag.
    if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
      closeThinking(); // native reasoning_content often precedes visible content
      emitContent(tagBuffer);
      tagBuffer = '';
    }
  }

  function pushReasoning(token: string): void {
    emitThinking(token);
  }

  function flush(): void {
    if (insideThink) {
      if (tagBuffer) emitThinking(tagBuffer);
      insideThink = false;
      tagBuffer = '';
      closeThinking();
      return;
    }
    if (tagBuffer) {
      closeThinking();
      emitContent(tagBuffer);
      tagBuffer = '';
      return;
    }
    closeThinking();
  }

  return { pushContent, pushReasoning, flush, closeThinking };
}

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
  let lastError: Error | undefined;

  for (let attempt: number = 1; attempt <= MAX_RETRIES; attempt++) {
    // Check for external abort before starting attempt
    if (externalSignal?.aborted) {
      const err: Error = new Error('Request aborted.');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutController: AbortController = new AbortController();
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signals: AbortSignal[] = [timeoutController.signal];
    if (externalSignal) signals.push(externalSignal);
    const controller: { signal: AbortSignal } = { signal: AbortSignal.any(signals) };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (config.id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
      headers['X-Title'] = 'Push CLI';
    }

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: 0.1,
    };

    // OpenRouter session tracking & trace metadata
    // See: https://openrouter.ai/docs/guides/features/broadcast/overview
    if (config.id === 'openrouter') {
      if (options?.sessionId) {
        requestBody.session_id = options.sessionId.slice(0, 256);
      }
      requestBody.trace = {
        generation_name: 'push-cli-chat',
        trace_name: 'push-cli',
      };
    }

    let response: Response | undefined;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        keepalive: true,
      });

      if (!response.ok) {
        const body: string = await response.text().catch(() => '(no body)');
        const err: Error = new Error(
          `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${body.slice(0, 400)}`,
        );
        if (attempt < MAX_RETRIES && isRetryableError(err, response)) {
          lastError = err;
          clearTimeout(timeout);
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }
        throw err;
      }

      if (!response.body) {
        clearTimeout(timeout);
        const fallbackJson: { choices?: { message?: { content?: string } }[] } | null =
          await response.json().catch(() => null);
        return fallbackJson?.choices?.[0]?.message?.content || '';
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const decoder: TextDecoder = new TextDecoder();
      let buffer: string = '';
      let accumulated: string = '';
      const reasoningParser: ReasoningTokenParser = createReasoningTokenParser(
        (token: string) => {
          accumulated += token;
          if (onToken) onToken(token);
        },
        options?.onThinkingToken,
      );

      while (true) {
        const { done, value }: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines: string[] = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data: string = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed: {
              choices?: {
                delta?: { content?: string; reasoning_content?: string };
                message?: { content?: string };
              }[];
            } = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const reasoningToken: string | undefined = choice.delta?.reasoning_content;
            if (reasoningToken) {
              reasoningParser.pushReasoning(reasoningToken);
            }

            const token: string =
              choice.delta?.content ??
              choice.message?.content ??
              '';
            if (token) {
              reasoningParser.pushContent(token);
            }
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }

      reasoningParser.flush();

      clearTimeout(timeout);
      return accumulated;
    } catch (err) {
      clearTimeout(timeout);
      if ((err instanceof DOMException || err instanceof Error) && err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          const abortErr: Error = new Error('Request aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)}s [provider=${config.id} model=${model} url=${config.url}]`,
        );
      }
      if (attempt < MAX_RETRIES && isRetryableError(err, response)) {
        lastError = err as Error;
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Provider request failed after retries');
}
