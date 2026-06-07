/**
 * CLI EmbeddingProvider — opt-in semantic memory via a deployed Push Worker.
 *
 * Unlike the web app, the CLI has no inherent Worker URL — it talks straight to
 * LLM provider endpoints. Embeddings need `env.AI`, which only the Worker has,
 * so the CLI reaches semantic recall *only* when pointed at a Worker via
 * `PUSH_EMBED_URL` (the deploy's base URL, e.g. https://push.<acct>.workers.dev).
 * When unset, `installCliEmbeddingProvider()` is a no-op and retrieval stays
 * lexical — zero regression for fully-offline CLI runs.
 *
 * This is the known parity gap: the surface that most benefits from better
 * recall (small models on the CLI) gets it only with a Worker. A local
 * embedder (transformers.js BGE) is the follow-up that closes it offline.
 *
 * Auth: if `PUSH_EMBED_TOKEN` is set it rides as a Bearer header, for deploys
 * with the session gate enforced. In observe mode the token is unnecessary.
 */

import {
  EMBEDDING_MODEL,
  setDefaultEmbeddingProvider,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingProvider,
  type EmbedResult,
} from '../lib/embedding-provider.js';

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
        if (token) headers.authorization = `Bearer ${token}`;
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
 * Install the CLI embedding provider when `PUSH_EMBED_URL` is configured.
 * Idempotent and safe to call at each memory-store bootstrap site.
 *
 * Diagnostics go to stderr and only under PUSH_DEBUG: this runs on every CLI
 * command, and stdout is the user-output / `--json` channel — a stray log line
 * there corrupts machine-readable output (and broke `push spinner show` /
 * `push resume --json` when this first logged to stdout).
 */
export function installCliEmbeddingProvider(): void {
  const base = process.env.PUSH_EMBED_URL?.trim();
  if (!base) {
    setDefaultEmbeddingProvider(null);
    if (DEBUG)
      console.error(JSON.stringify({ level: 'debug', event: 'cli_embed_provider_lexical_only' }));
    return;
  }
  const endpoint = resolveEmbedUrl(base);
  setDefaultEmbeddingProvider(
    createCliEmbeddingProvider(endpoint, process.env.PUSH_EMBED_TOKEN?.trim()),
  );
  if (DEBUG)
    console.error(
      JSON.stringify({ level: 'debug', event: 'cli_embed_provider_installed', endpoint }),
    );
}
