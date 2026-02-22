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
    url: process.env.PUSH_OLLAMA_URL || process.env.OLLAMA_API_URL || 'https://ollama.com/v1/chat/completions',
    defaultModel: process.env.PUSH_OLLAMA_MODEL || 'gemini-3-flash-preview',
    apiKeyEnv: ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'],
    requiresKey: true,
  },
  mistral: {
    id: 'mistral',
    url: process.env.PUSH_MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: process.env.PUSH_MISTRAL_MODEL || 'devstral-small-latest',
    apiKeyEnv: ['PUSH_MISTRAL_API_KEY', 'MISTRAL_API_KEY', 'VITE_MISTRAL_API_KEY'],
    requiresKey: true,
  },
  openrouter: {
    id: 'openrouter',
    url: process.env.PUSH_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: process.env.PUSH_OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6',
    apiKeyEnv: ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
    requiresKey: true,
  },
  zai: {
    id: 'zai',
    url: process.env.PUSH_ZAI_URL || 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    defaultModel: process.env.PUSH_ZAI_MODEL || 'glm-4.5',
    apiKeyEnv: ['PUSH_ZAI_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY', 'VITE_ZAI_API_KEY'],
    requiresKey: true,
  },
  google: {
    id: 'google',
    url: process.env.PUSH_GOOGLE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: process.env.PUSH_GOOGLE_MODEL || 'gemini-3.1-pro-preview',
    apiKeyEnv: [
      'PUSH_GOOGLE_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'VITE_GOOGLE_API_KEY',
    ],
    requiresKey: true,
  },
  zen: {
    id: 'zen',
    url: process.env.PUSH_ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions',
    defaultModel: process.env.PUSH_ZEN_MODEL || 'big-pickle',
    apiKeyEnv: [
      'PUSH_ZEN_API_KEY',
      'ZEN_API_KEY',
      'OPENCODE_API_KEY',
      'VITE_ZEN_API_KEY',
      'VITE_OPENCODE_API_KEY',
    ],
    requiresKey: true,
  },
};

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
 * Return enriched metadata for all providers.
 * hasKey probes resolveApiKey without throwing.
 */
export function getProviderList() {
  return Object.values(PROVIDER_CONFIGS).map((cfg) => {
    let hasKey = false;
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
export function createReasoningTokenParser(onContentToken, onThinkingToken) {
  let insideThink = false;
  let tagBuffer = '';
  let thinkingOpen = false;

  function emitContent(token) {
    if (!token) return;
    onContentToken?.(token);
  }

  function emitThinking(token) {
    if (!token) return;
    thinkingOpen = true;
    onThinkingToken?.(token);
  }

  function closeThinking() {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    onThinkingToken?.(null);
  }

  function pushContent(rawToken) {
    if (!rawToken) return;
    tagBuffer += rawToken;

    // Detect <think> opening outside a think block.
    if (!insideThink && tagBuffer.includes('<think>')) {
      const parts = tagBuffer.split('<think>');
      const before = parts.shift() || '';
      const afterOpen = parts.join('<think>');
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
        const thinkContent = tagBuffer.split('</think>')[0];
        if (thinkContent) emitThinking(thinkContent);
        closeThinking();

        const after = tagBuffer.split('</think>').slice(1).join('</think>');
        insideThink = false;
        tagBuffer = '';
        const cleaned = after.replace(/^\s+/, '');
        if (cleaned) emitContent(cleaned);
      } else {
        // Hold a short tail so split closing tags can still be detected.
        const safe = tagBuffer.slice(0, -10);
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

  function pushReasoning(token) {
    emitThinking(token);
  }

  function flush() {
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

    const requestBody = {
      model,
      messages,
      stream: true,
      temperature: 0.1,
    };

    let response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        keepalive: true,
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
      const reasoningParser = createReasoningTokenParser(
        (token) => {
          accumulated += token;
          if (onToken) onToken(token);
        },
        options?.onThinkingToken,
      );

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

            const reasoningToken = choice.delta?.reasoning_content;
            if (reasoningToken) {
              reasoningParser.pushReasoning(reasoningToken);
            }

            const token =
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
