/**
 * Integration tests for the `/api/artifacts/*` worker handlers.
 *
 * Drives the handlers against an in-memory KV mock so each route's
 * happy path, validation envelope, and NOT_CONFIGURED fail-closed
 * behavior are pinned. The store-level tests in
 * `artifact-store-kv.test.ts` cover the KV-shape semantics.
 */

import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';

import {
  handleArtifactsCreate,
  handleArtifactsDelete,
  handleArtifactsGet,
  handleArtifactsList,
} from './worker-artifacts';

interface MockKvEntry {
  value: string;
  metadata?: unknown;
}

class MockKvNamespace {
  readonly store = new Map<string, MockKvEntry>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list<TMeta = unknown>(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? '';
    const keys = [];
    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      keys.push({ name, metadata: entry.metadata as TMeta });
    }
    return { keys };
  }
}

function makeRequest(body: unknown): Request {
  return new Request('https://push.test/api/artifacts/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const SCOPE = { repoFullName: 'acme/widgets', branch: 'main', chatId: 'chat_1' };

describe('handleArtifactsCreate', () => {
  it('persists a valid mermaid artifact and returns the record + summary', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const req = makeRequest({
      scope: SCOPE,
      args: { kind: 'mermaid', title: 'Auth flow', source: 'graph TD; A-->B' },
    });

    const res = await handleArtifactsCreate(req, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.summary).toMatch(/Artifact created: [\w-]+ — mermaid "Auth flow"\./);
    const record = json.record as Record<string, unknown>;
    expect(record.kind).toBe('mermaid');
    expect((record.scope as Record<string, unknown>).repoFullName).toBe('acme/widgets');
    // Default author is synthesized when the client omits it.
    const author = record.author as Record<string, unknown>;
    expect(author.surface).toBe('web');
    expect(author.role).toBe('orchestrator');
  });

  it('honors a client-supplied author', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const req = makeRequest({
      scope: SCOPE,
      args: { kind: 'mermaid', title: 'x', source: 'graph TD; A-->B' },
      author: {
        surface: 'web',
        role: 'orchestrator',
        messageId: 'msg_42',
        createdAt: 1_700_000_000_000,
      },
    });
    const res = await handleArtifactsCreate(req, env);
    const json = (await res.json()) as { record: { author: Record<string, unknown> } };
    expect(json.record.author.messageId).toBe('msg_42');
    expect(json.record.author.createdAt).toBe(1_700_000_000_000);
  });

  it('returns NOT_CONFIGURED 503 when the binding is missing', async () => {
    const req = makeRequest({
      scope: SCOPE,
      args: { kind: 'mermaid', title: 'x', source: 'graph TD; A-->B' },
    });
    const res = await handleArtifactsCreate(req, {});
    expect(res.status).toBe(503);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('NOT_CONFIGURED');
  });

  it('maps validation failure to a 400 with the structured code/field', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const req = makeRequest({ scope: SCOPE, args: { kind: 'wat', title: 'x' } });
    const res = await handleArtifactsCreate(req, env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('INVALID_KIND');
    expect(json.field).toBe('kind');
  });

  it('rejects malformed scope with INVALID_SCOPE', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const req = makeRequest({
      scope: { branch: 'main' }, // missing repoFullName
      args: { kind: 'mermaid', title: 'x', source: 'graph TD; A-->B' },
    });
    const res = await handleArtifactsCreate(req, env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_SCOPE');
  });

  it('rejects a non-JSON body with BAD_REQUEST', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const req = new Request('https://push.test/api/artifacts/create', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleArtifactsCreate(req, env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('BAD_REQUEST');
  });
});

describe('handleArtifactsList', () => {
  it('returns artifacts under the scope', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };

    // Seed via create handler so we don't hand-craft KV keys.
    for (const i of [1, 2, 3]) {
      await handleArtifactsCreate(
        makeRequest({
          scope: SCOPE,
          args: { kind: 'mermaid', title: `t${i}`, source: 'graph TD; A-->B' },
        }),
        env,
      );
    }

    // Order isn't deterministic when all three are created in the same
    // millisecond and updatedAt comes from Date.now(). Newest-first
    // ordering is pinned by the store-level test suite where the test
    // sets updatedAt explicitly. Here we assert presence + count.
    const res = await handleArtifactsList(makeRequest({ scope: SCOPE }), env);
    const json = (await res.json()) as { records: { title: string }[] };
    expect(new Set(json.records.map((r) => r.title))).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('applies a kind filter', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    await handleArtifactsCreate(
      makeRequest({
        scope: SCOPE,
        args: { kind: 'mermaid', title: 'm', source: 'graph TD; A-->B' },
      }),
      env,
    );
    await handleArtifactsCreate(
      makeRequest({
        scope: SCOPE,
        args: {
          kind: 'static-html',
          title: 'h',
          files: [{ path: '/index.html', content: '<h1>hi</h1>' }],
        },
      }),
      env,
    );
    const res = await handleArtifactsList(makeRequest({ scope: SCOPE, kind: 'static-html' }), env);
    const json = (await res.json()) as { records: { kind: string }[] };
    expect(json.records.map((r) => r.kind)).toEqual(['static-html']);
  });

  it('returns an empty array when the scope has no artifacts', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const res = await handleArtifactsList(makeRequest({ scope: SCOPE }), env);
    const json = (await res.json()) as { records: unknown[] };
    expect(json.records).toEqual([]);
  });

  it('NOT_CONFIGURED 503 when the binding is missing', async () => {
    const res = await handleArtifactsList(makeRequest({ scope: SCOPE }), {});
    expect(res.status).toBe(503);
  });
});

describe('handleArtifactsGet / handleArtifactsDelete', () => {
  it('round-trips create → get → delete → get-null', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const created = (await (
      await handleArtifactsCreate(
        makeRequest({
          scope: SCOPE,
          args: { kind: 'mermaid', title: 'x', source: 'graph TD; A-->B' },
        }),
        env,
      )
    ).json()) as { record: { id: string } };

    const got = (await (
      await handleArtifactsGet(makeRequest({ scope: SCOPE, id: created.record.id }), env)
    ).json()) as { record: { id: string } };
    expect(got.record.id).toBe(created.record.id);

    const del = await handleArtifactsDelete(
      makeRequest({ scope: SCOPE, id: created.record.id }),
      env,
    );
    expect(del.status).toBe(200);

    const after = (await (
      await handleArtifactsGet(makeRequest({ scope: SCOPE, id: created.record.id }), env)
    ).json()) as { record: unknown };
    expect(after.record).toBeNull();
  });

  it('rejects path-traversal-shaped ids with INVALID_ID', async () => {
    const kv = new MockKvNamespace();
    const env = { ARTIFACTS: kv as unknown as KVNamespace };
    const res = await handleArtifactsGet(
      makeRequest({ scope: SCOPE, id: '../other-scope/art' }),
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_ID');
  });
});
