/**
 * Web EmbeddingProvider — POSTs to the Worker's `/api/memory/embed`.
 *
 * The browser can't reach `env.AI` directly, so embeddings round-trip through
 * the Worker. Authentication rides the global authed-fetch wrapper installed by
 * `installApiAuthFetch()`, so a plain `fetch('/api/...')` is already gated.
 *
 * The endpoint is resolved via `resolveApiUrl` so native/Capacitor builds hit
 * the deployed Worker (VITE_API_BASE_URL) instead of the WebView origin
 * (`https://localhost`) — without it, embedding silently all-nulls on mobile.
 *
 * Best-effort by contract: any failure (HTTP error, malformed body) yields
 * all-null vectors so context-memory retrieval falls back to lexical scoring
 * rather than throwing into the delegation path.
 */

import {
  EMBEDDING_MODEL,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingProvider,
  type EmbedResult,
} from '@push/lib/embedding-provider';
import { resolveApiUrl } from '@/lib/api-url';

export function createWebEmbeddingProvider(): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts: string[]): Promise<EmbedResult[]> {
      const allNull = (): EmbedResult[] =>
        texts.map(() => ({ model: EMBEDDING_MODEL, vector: null }));
      try {
        const body: EmbedRequest = { texts };
        const res = await fetch(resolveApiUrl('/api/memory/embed'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
