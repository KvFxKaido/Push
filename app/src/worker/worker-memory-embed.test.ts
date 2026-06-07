/**
 * Integration tests for the `/api/memory/embed` worker handler.
 *
 * Drives the handler against a fake `env.AI` so the wire contract
 * (EmbedResponse shape, index alignment, null-for-empty, fail-closed
 * NOT_CONFIGURED, and upstream-shape-mismatch handling) is pinned. The
 * request/response types live in `@push/lib/embedding-provider`, which both the
 * web and CLI providers consume — this test is the drift detector for that
 * shared shape.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';

import { EMBEDDING_MODEL } from '@push/lib/embedding-provider';
import { handleMemoryEmbed } from './worker-memory-embed';

function makeRequest(body: unknown): Request {
  return new Request('https://example.com/api/memory/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Fake AI binding that returns one unit-ish vector per input text. */
function fakeAi(vectorFor: (text: string, i: number) => number[]) {
  return {
    run: vi.fn(async (_model: string, input: { text: string[] }) => ({
      shape: [input.text.length, 3],
      data: input.text.map(vectorFor),
    })),
  } as unknown as Ai;
}

describe('handleMemoryEmbed', () => {
  it('returns NOT_CONFIGURED 503 when the AI binding is missing', async () => {
    const res = await handleMemoryEmbed(makeRequest({ texts: ['hi'] }), {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_CONFIGURED');
  });

  it('rejects a non-array texts field with 400', async () => {
    const res = await handleMemoryEmbed(makeRequest({ texts: 'nope' }), {
      AI: fakeAi(() => [1, 0, 0]),
    });
    expect(res.status).toBe(400);
  });

  it('embeds texts and returns model + index-aligned vectors', async () => {
    const ai = fakeAi((_t, i) => [i, 1, 0]);
    const res = await handleMemoryEmbed(makeRequest({ texts: ['alpha', 'beta'] }), { AI: ai });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; vectors: (number[] | null)[] };
    expect(body.model).toBe(EMBEDDING_MODEL);
    expect(body.vectors).toEqual([
      [0, 1, 0],
      [1, 1, 0],
    ]);
  });

  it('maps empty/blank inputs to null without sending them upstream', async () => {
    const ai = fakeAi(() => [9, 9, 9]);
    const res = await handleMemoryEmbed(makeRequest({ texts: ['', '  ', 'real'] }), { AI: ai });
    const body = (await res.json()) as { vectors: (number[] | null)[] };
    expect(body.vectors[0]).toBeNull();
    expect(body.vectors[1]).toBeNull();
    expect(body.vectors[2]).toEqual([9, 9, 9]);
    // Only the one non-blank text reached the model.
    expect(ai.run as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      text: ['real'],
    });
  });

  it('returns 502 when the model returns a mismatched number of vectors', async () => {
    const ai = {
      run: vi.fn(async () => ({ shape: [1, 3], data: [[1, 0, 0]] })),
    } as unknown as Ai;
    const res = await handleMemoryEmbed(makeRequest({ texts: ['a', 'b'] }), { AI: ai });
    expect(res.status).toBe(502);
  });

  it('returns all-null vectors with 200 when every input is blank', async () => {
    const ai = fakeAi(() => [1, 2, 3]);
    const res = await handleMemoryEmbed(makeRequest({ texts: ['', ''] }), { AI: ai });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: (number[] | null)[] };
    expect(body.vectors).toEqual([null, null]);
    expect(ai.run as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
