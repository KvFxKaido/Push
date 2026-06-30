/**
 * Reusable in-process mock provider for Phase 6 daemon tests.
 *
 * Serves OpenAI-compatible `chat/completions` SSE by default, or Responses SSE
 * when `streamShape: 'responses'` is passed, so the real `streamCompletion` +
 * daemon ProviderStreamFn adapter exercise their full fetch/parse path without
 * a network round-trip. Two token modes:
 *
 *   - tokens: []    — responds 200 + SSE token deltas + [DONE]
 *   - responses: [[...],[...]] — one token-set PER request, in order (the Nth
 *                     request replays responses[N]; requests past the end
 *                     reuse the last set). Lets multi-round agent tests vary
 *                     the model's reply per round (e.g. round 1 emits a tool
 *                     call, round 2 emits the final answer).
 *   - hang: true    — responds 200 + keeps the connection open until
 *                     the client aborts. Used by cancellation/race tests
 *                     where the adapter needs to be blocked mid-stream
 *                     when `cancel_delegation` fires.
 *
 * `PROVIDER_CONFIGS[provider].url` is read at every `streamCompletion`
 * call (cli/provider.ts:326), so `patchProviderConfig` mutates that
 * field in place — env vars are only consulted at module-load, so
 * env patching alone is insufficient for url overrides.
 *
 * API keys resolve per-call via `resolveApiKey`, which reads
 * `process.env` live — so patching env is sufficient for credentials.
 */

import http from 'node:http';
import { PROVIDER_CONFIGS } from '../provider.ts';

/**
 * @param {{ tokens?: string[], responses?: string[][], hang?: boolean, streamShape?: 'chat' | 'responses' }} [opts]
 * @returns {Promise<{ url: string, port: number, requestCount: () => number, stop: () => Promise<void> }>}
 */
export async function startMockProviderServer(opts = {}) {
  const { tokens = [], responses = null, hang = false, streamShape = 'chat' } = opts;
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    // Drain request body before responding so the client's write is flushed.
    req.on('data', () => {});
    req.on('end', () => {
      const requestIndex = requestCount;
      requestCount += 1;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (hang) {
        // Hold the response open until the client aborts (AbortSignal
        // from the adapter). Node emits 'close' on the response when
        // the socket is torn down; we clean up then.
        const cleanup = () => {
          try {
            res.end();
          } catch {
            /* socket already closed */
          }
        };
        res.on('close', cleanup);
        return;
      }

      // Per-request mode: replay responses[requestIndex], clamping past the
      // end to the last set (so an unexpected extra round still terminates
      // rather than hanging). Falls back to the single `tokens` set.
      const activeTokens = responses
        ? (responses[Math.min(requestIndex, responses.length - 1)] ?? [])
        : tokens;

      for (const token of activeTokens) {
        const chunk =
          streamShape === 'responses'
            ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: token })}\n\n`
            : `data: ${JSON.stringify({
                choices: [{ delta: { content: token } }],
              })}\n\n`;
        res.write(chunk);
      }
      if (streamShape === 'responses') {
        res.write(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed' },
          })}\n\n`,
        );
      } else {
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('mock-provider-server: failed to bind TCP port');
  }
  const port = addr.port;

  return {
    url: `http://127.0.0.1:${port}/v1/${
      streamShape === 'responses' ? 'responses' : 'chat/completions'
    }`,
    port,
    /** Number of completed requests the mock has served so far. */
    requestCount: () => requestCount,
    async stop() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      });
    },
  };
}

/**
 * Point `PROVIDER_CONFIGS[providerId]` at a mock via env. `url` and
 * `defaultModel` are live getters over `process.env` (the reload_config
 * contract), so the env var IS the override point — direct property
 * assignment would throw on the setter-less getter. Returns a restore
 * function that un-patches the env. Must be called BEFORE the test issues
 * any request that would call the provider.
 *
 * @param {string} providerId
 * @param {{ url: string, apiKey: string }} patch
 * @returns {() => void} restore
 */
export function patchProviderConfig(providerId, { url, apiKey }) {
  const config = PROVIDER_CONFIGS[providerId];
  if (!config) {
    throw new Error(`patchProviderConfig: unknown provider "${providerId}"`);
  }
  const urlEnv = `PUSH_${providerId.toUpperCase()}_URL`;
  const originalUrl = process.env[urlEnv];
  process.env[urlEnv] = url;

  const keyEnv = config.apiKeyEnv[0];
  const originalKey = process.env[keyEnv];
  process.env[keyEnv] = apiKey;

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    if (originalUrl === undefined) {
      delete process.env[urlEnv];
    } else {
      process.env[urlEnv] = originalUrl;
    }
    if (originalKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = originalKey;
    }
  };
}
