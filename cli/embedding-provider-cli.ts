/**
 * CLI embedding-provider selection for semantic memory.
 *
 * Precedence (in `installCliEmbeddingProvider`):
 *   1. `PUSH_EMBED_URL` set  → remote provider, POSTs to a deployed Worker's
 *      `/api/memory/embed` (the only place `env.AI` is reachable). Explicit
 *      remote choice wins.
 *   2. `PUSH_EMBED_LOCAL !== '0'` → local on-device provider (transformers.js
 *      BGE), auto-on when the optional dependency is installed. Closes the
 *      offline gap so the CLI no longer needs a Worker for semantic recall.
 *   3. otherwise → no provider; retrieval stays lexical (zero regression).
 *
 * Auth (remote path): if `PUSH_EMBED_TOKEN` is set it rides as the
 * `X-Push-Session` header (what the gate reads), for deploys with the session
 * gate enforced. In observe mode the token is unnecessary.
 */

import {
  EMBEDDING_MODEL,
  setDefaultEmbeddingProvider,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingProvider,
  type EmbedResult,
} from '../lib/embedding-provider.js';
import { createLocalEmbeddingProvider } from './embedding-provider-local.js';

function resolveEmbedUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/api/memory/embed') ? trimmed : `${trimmed}/api/memory/embed`;
}

function createCliEmbeddingProvider(
  endpoint: string,
  token: string | undefined,
): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts: string[]): Promise<EmbedResult[]> {
      const allNull = (): EmbedResult[] =>
        texts.map(() => ({ model: EMBEDDING_MODEL, vector: null }));
      try {
        const body: EmbedRequest = { texts };
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        // The universal /api/* session gate reads the session token from the
        // `X-Push-Session` header (or the push_session cookie), NOT Authorization
        // — see SESSION_HEADER in app/src/lib/session-constants.ts. Sending it as
        // a Bearer token would 401 against an enforced deployment.
        if (token) headers['X-Push-Session'] = token;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) return allNull();
        const data = (await res.json()) as EmbedResponse;
        const model = data.model ?? EMBEDDING_MODEL;
        return texts.map((_, i) => ({ model, vector: data.vectors?.[i] ?? null }));
      } catch {
        return allNull();
      }
    },
  };
}

const DEBUG = process.env.PUSH_DEBUG === '1' || process.env.PUSH_DEBUG === 'true';

/**
 * Select and install the CLI embedding provider (see precedence in the module
 * header). Idempotent and safe to call at each memory-store bootstrap site.
 *
 * Diagnostics go to stderr and only under PUSH_DEBUG: this runs on every CLI
 * command, and stdout is the user-output / `--json` channel — a stray log line
 * there corrupts machine-readable output (and broke `push theme show` /
 * `push resume --json` when this first logged to stdout).
 */
export function installCliEmbeddingProvider(): void {
  const base = process.env.PUSH_EMBED_URL?.trim();
  if (base) {
    const endpoint = resolveEmbedUrl(base);
    setDefaultEmbeddingProvider(
      createCliEmbeddingProvider(endpoint, process.env.PUSH_EMBED_TOKEN?.trim()),
    );
    if (DEBUG)
      console.error(
        JSON.stringify({ level: 'debug', event: 'cli_embed_provider_remote', endpoint }),
      );
    return;
  }
  if (process.env.PUSH_EMBED_LOCAL === '0') {
    setDefaultEmbeddingProvider(null);
    if (DEBUG)
      console.error(JSON.stringify({ level: 'debug', event: 'cli_embed_provider_lexical_only' }));
    return;
  }
  // Auto-on local embeddings. The model loads lazily on the first embed() call
  // (not here — so memory-free commands don't pay for it). If the optional
  // dependency isn't installed, the provider returns all-null and retrieval
  // degrades to lexical — no error.
  setDefaultEmbeddingProvider(createLocalEmbeddingProvider());
  if (DEBUG) console.error(JSON.stringify({ level: 'debug', event: 'cli_embed_provider_local' }));
}
