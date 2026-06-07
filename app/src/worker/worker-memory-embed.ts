/**
 * Worker handler for `POST /api/memory/embed`.
 *
 * Backs semantic memory retrieval: turns text into dense vectors via the
 * Workers AI BGE model (the `AI` binding). Both the web app and the CLI call
 * this — it's the only place `env.AI` is reachable, since memory retrieval runs
 * client-side (browser) or in-process (CLI), neither of which has the binding.
 *
 * Request/response shapes are defined once in `@push/lib/embedding-provider`
 * (EmbedRequest / EmbedResponse) and shared by both callers, so the wire
 * vocabulary has a single source of truth.
 *
 * Auth: the universal /api/* session gate in worker.ts applies — same as
 * artifacts/library. No per-handler authn here.
 *
 * Fail-closed: when `env.AI` isn't bound, returns NOT_CONFIGURED 503 (matching
 * the artifacts/sandbox-cf convention) so an operator notices a missing binding
 * rather than silently losing semantic recall.
 */

import type { Ai } from '@cloudflare/workers-types';

import { EMBEDDING_MODEL, type EmbedResponse } from '@push/lib/embedding-provider';

interface MemoryEmbedEnv {
  AI?: Ai;
}

// Guardrails: cap batch size and per-text length so a malformed/oversized
// payload can't fan out into a huge upstream call. BGE truncates at ~512
// tokens; 2000 chars is a comfortable ceiling below that.
const MAX_TEXTS = 128;
const MAX_TEXT_CHARS = 2000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface BgeOutput {
  shape: number[];
  data: number[][];
}

export async function handleMemoryEmbed(request: Request, env: MemoryEmbedEnv): Promise<Response> {
  if (!env.AI) {
    console.log(JSON.stringify({ level: 'warn', event: 'memory_embed_not_configured' }));
    return jsonResponse(
      {
        ok: false,
        code: 'NOT_CONFIGURED',
        message:
          'AI binding is not configured. Add an `ai` binding (binding="AI") to wrangler.jsonc to enable semantic memory retrieval.',
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body.' }, 400);
  }

  const rawTexts = (body as { texts?: unknown })?.texts;
  if (!Array.isArray(rawTexts)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: '`texts` must be an array of strings.' },
      400,
    );
  }
  if (rawTexts.length > MAX_TEXTS) {
    return jsonResponse(
      {
        ok: false,
        code: 'BAD_REQUEST',
        message: `\`texts\` exceeds the ${MAX_TEXTS}-item limit.`,
      },
      400,
    );
  }

  // Normalize and remember which inputs are embeddable. Empty/non-string inputs
  // map to a `null` vector in the response so the caller keeps index alignment
  // with its records without us sending blanks to the model.
  const inputs = rawTexts.map((t) =>
    typeof t === 'string' ? t.trim().slice(0, MAX_TEXT_CHARS) : '',
  );
  const embeddableIndices: number[] = [];
  const batch: string[] = [];
  inputs.forEach((text, i) => {
    if (text.length > 0) {
      embeddableIndices.push(i);
      batch.push(text);
    }
  });

  const vectors: (number[] | null)[] = inputs.map(() => null);

  if (batch.length === 0) {
    console.log(
      JSON.stringify({ level: 'debug', event: 'memory_embed_ok', count: 0, total: inputs.length }),
    );
    const empty: EmbedResponse = { model: EMBEDDING_MODEL, vectors };
    return jsonResponse(empty);
  }

  try {
    const runner = env.AI as unknown as {
      run: (model: string, input: { text: string[] }) => Promise<BgeOutput>;
    };
    const output = await runner.run(EMBEDDING_MODEL, { text: batch });
    const data = output?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'memory_embed_failed',
          reason: 'shape_mismatch',
          expected: batch.length,
          got: Array.isArray(data) ? data.length : null,
        }),
      );
      return jsonResponse(
        {
          ok: false,
          code: 'UPSTREAM_ERROR',
          message: 'Embedding model returned an unexpected shape.',
        },
        502,
      );
    }
    data.forEach((vector, j) => {
      vectors[embeddableIndices[j]] = vector;
    });
    console.log(
      JSON.stringify({
        level: 'debug',
        event: 'memory_embed_ok',
        count: batch.length,
        total: inputs.length,
      }),
    );
    const response: EmbedResponse = { model: EMBEDDING_MODEL, vectors };
    return jsonResponse(response);
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'memory_embed_failed',
        reason: 'upstream_exception',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse(
      { ok: false, code: 'UPSTREAM_ERROR', message: 'Embedding request failed upstream.' },
      502,
    );
  }
}
