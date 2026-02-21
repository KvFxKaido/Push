import process from 'node:process';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function isRetryableError(err, response) {
  if (!response) return true; // network error
  const status = response.status;
  return status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PROVIDER_CONFIGS = {
  ollama: {
    id: 'ollama',
    url: process.env.PUSH_OLLAMA_URL || process.env.OLLAMA_API_URL || 'http://localhost:11434/v1/chat/completions',
    defaultModel: process.env.PUSH_OLLAMA_MODEL || 'gemini-3-flash-preview',
    apiKeyEnv: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    requiresKey: false,
    supportsNativeFC: false,
  },
  mistral: {
    id: 'mistral',
    url: process.env.PUSH_MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: process.env.PUSH_MISTRAL_MODEL || 'devstral-small-latest',
    apiKeyEnv: ['PUSH_MISTRAL_API_KEY', 'MISTRAL_API_KEY', 'VITE_MISTRAL_API_KEY'],
    requiresKey: true,
    supportsNativeFC: true,
    toolChoice: 'any',
  },
  openrouter: {
    id: 'openrouter',
    url: process.env.PUSH_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: process.env.PUSH_OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6',
    apiKeyEnv: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    requiresKey: true,
    supportsNativeFC: true,
    toolChoice: 'auto',
  },
};

/**
 * Resolve whether native FC is active for a provider.
 * Respects PUSH_NATIVE_FC env var as an override:
 *   0 / false → force OFF (fallback to prompt-engineered)
 *   1 / true  → force ON  (even if provider config says false — use at your own risk)
 *   unset     → use provider config default
 */
export function resolveNativeFC(config) {
  const envOverride = process.env.PUSH_NATIVE_FC;
  if (envOverride === '0' || envOverride === 'false') return false;
  if (envOverride === '1' || envOverride === 'true') return true;
  return Boolean(config.supportsNativeFC);
}

export function resolveApiKey(config) {
  for (const key of config.apiKeyEnv) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  if (config.requiresKey) {
    throw new Error(`Missing API key for ${config.id}. Set one of: ${config.apiKeyEnv.join(', ')}`);
  }
  return '';
}

/**
 * Bridge native tool calls (delta.tool_calls) to fenced JSON text.
 * Accumulated tool call data is converted to the same format used by
 * the prompt-engineered protocol, so detectAllToolCalls() works unchanged.
 */
function bridgeNativeToolCalls(pendingCalls) {
  let bridged = '';
  for (const [, tc] of pendingCalls) {
    if (!tc.name) continue;
    try {
      const parsedArgs = tc.args ? JSON.parse(tc.args) : {};
      const toolJson = JSON.stringify({ tool: tc.name, args: parsedArgs });
      bridged += '\n```json\n' + toolJson + '\n```\n';
    } catch {
      // Args didn't parse — best-effort with empty args
      bridged += '\n```json\n' + JSON.stringify({ tool: tc.name, args: {} }) + '\n```\n';
    }
  }
  return bridged;
}

export async function streamCompletion(config, apiKey, model, messages, onToken, timeoutMs = DEFAULT_TIMEOUT_MS, externalSignal = null, options = undefined) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Check for external abort before starting attempt
    if (externalSignal?.aborted) {
      const err = new Error('Request aborted.');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signals = [timeoutController.signal];
    if (externalSignal) signals.push(externalSignal);
    const controller = { signal: AbortSignal.any(signals) };
    const headers = {
      'Content-Type': 'application/json',
    };

    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (config.id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.PUSH_OPENROUTER_REFERER || 'https://push.local';
      headers['X-Title'] = 'Push CLI';
    }

    // Build request body — conditionally include native FC schemas
    const requestBody = {
      model,
      messages,
      stream: true,
      temperature: 0.1,
    };
    // forceNativeFC allows env override (PUSH_NATIVE_FC=1) to enable tools[]
    // even for providers whose default config has supportsNativeFC=false.
    const nativeFCEnabled = options?.forceNativeFC === true || config.supportsNativeFC;
    if (options?.tools && nativeFCEnabled) {
      requestBody.tools = options.tools;
      requestBody.tool_choice = options.toolChoice || config.toolChoice || 'auto';
    }

    let response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '(no body)');
        const err = new Error(
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
        const fallbackJson = await response.json().catch(() => null);
        return fallbackJson?.choices?.[0]?.message?.content || '';
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      // Accumulate native tool calls by index (same bridge pattern as web app)
      const pendingNativeToolCalls = new Map();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const token =
              choice.delta?.content ??
              choice.message?.content ??
              '';
            if (token) {
              accumulated += token;
              if (onToken) onToken(token);
            }

            // Accumulate native tool calls (delta.tool_calls)
            const toolCalls = choice.delta?.tool_calls;
            if (toolCalls) {
              for (const tc of toolCalls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const fnCall = tc.function;
                if (!fnCall) continue;
                if (!pendingNativeToolCalls.has(idx)) {
                  pendingNativeToolCalls.set(idx, { name: '', args: '' });
                }
                const entry = pendingNativeToolCalls.get(idx);
                if (fnCall.name) entry.name = fnCall.name;
                if (fnCall.arguments) entry.args += fnCall.arguments;
              }
            }

            // Flush on finish_reason that indicates tool calls
            const reason = choice.finish_reason;
            if (reason === 'tool_calls' || reason === 'stop' || reason === 'end_turn' || reason === 'length') {
              if (pendingNativeToolCalls.size > 0) {
                const bridged = bridgeNativeToolCalls(pendingNativeToolCalls);
                accumulated += bridged;
                if (onToken) onToken(bridged);
                pendingNativeToolCalls.clear();
              }
            }
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }

      // Flush any remaining native tool calls on stream end
      if (pendingNativeToolCalls.size > 0) {
        const bridged = bridgeNativeToolCalls(pendingNativeToolCalls);
        accumulated += bridged;
        if (onToken) onToken(bridged);
        pendingNativeToolCalls.clear();
      }

      clearTimeout(timeout);
      return accumulated;
    } catch (err) {
      clearTimeout(timeout);
      if ((err instanceof DOMException || err instanceof Error) && err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          const abortErr = new Error('Request aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)}s [provider=${config.id} model=${model} url=${config.url}]`,
        );
      }
      if (attempt < MAX_RETRIES && isRetryableError(err, response)) {
        lastError = err;
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Provider request failed after retries');
}
