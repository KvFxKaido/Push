/**
 * Reusable in-process mock provider for Phase 6 daemon tests.
 *
 * Serves OpenAI-compatible `chat/completions` SSE so the real
 * `streamCompletion` + daemon ProviderStreamFn adapter exercise their
 * full fetch/parse path without a network round-trip. Two modes:
 *
 *   - tokens: []    — responds 200 + SSE token deltas + [DONE]
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
 * @param {{ tokens?: string[], hang?: boolean }} [opts]
 * @returns {Promise<{ url: string, port: number, stop: () => Promise<void> }>}
 */
export async function startMockProviderServer(opts = {}) {
  const { tokens = [], hang = false } = opts;

  const server = http.createServer((req, res) => {
    // Drain request body before responding so the client's write is flushed.
    req.on('data', () => {});
    req.on('end', () => {
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

      for (const token of tokens) {
        const chunk = `data: ${JSON.stringify({
          choices: [{ delta: { content: token } }],
        })}\n\n`;
        res.write(chunk);
      }
      res.write('data: [DONE]\n\n');
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
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    port,
    async stop() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      });
    },
  };
}

/**
 * Mutate `PROVIDER_CONFIGS[providerId]` + env to point at a mock.
 * Returns a restore function that un-mutates both. Must be called
 * BEFORE the test issues any request that would call the provider.
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
  const originalUrl = config.url;
  config.url = url;

  const keyEnv = config.apiKeyEnv[0];
  const originalKey = process.env[keyEnv];
  process.env[keyEnv] = apiKey;

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    config.url = originalUrl;
    if (originalKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = originalKey;
    }
  };
}
