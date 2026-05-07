/**
 * Workers KV implementation of `ArtifactStore`.
 *
 * Layout: each artifact persists at key `buildScopeKeys(scope).chat ??
 * .branch + ":" + id`. List operations use KV's `list({ prefix })` to
 * find matching keys, then issue per-key gets. That's the same N+1
 * pattern as the CLI flat-JSON store — fine at v1 cardinality where
 * the doc on the lib interface budgets for "a few dozen artifacts per
 * branch."
 *
 * Metadata field on KV writes carries `{ updatedAt, kind, title }` so
 * listing can sort and filter without dereferencing every value. The
 * record itself is the source of truth; metadata is a denormalized
 * view that can be regenerated from the value if it ever drifts.
 *
 * Path-safety: KV keys aren't filesystem paths, so the CLI's `:` → `__`
 * substitution doesn't apply. Keys can contain `:` directly. The
 * canonical scope-key shape from `buildScopeKeys` is used as-is.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { buildScopeKeys } from '@push/lib/artifacts/scope';
import type { ArtifactRecord, ArtifactScope } from '@push/lib/artifacts/types';
import type { ArtifactStore, ListArtifactsQuery } from '@push/lib/artifacts/store';

interface KvListMetadata {
  updatedAt: number;
  kind: ArtifactRecord['kind'];
  title: string;
}

/**
 * Reject artifact ids that could broaden the scope when concatenated
 * into a KV key. KV doesn't have a path-traversal vector the way
 * filesystem stores do, but a malicious id containing `:` could
 * collide with our scope-key delimiter and read/overwrite an
 * unrelated record. Same allowlist as the CLI store — ASCII
 * alphanumerics, `-`, `_`, max 128 chars.
 */
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeArtifactId(id: string): void {
  if (!SAFE_ARTIFACT_ID.test(id)) {
    throw new Error(
      `Invalid artifact id ${JSON.stringify(id)}: must match ${SAFE_ARTIFACT_ID.source}.`,
    );
  }
}

function primaryKey(scope: ArtifactScope, id: string): string {
  assertSafeArtifactId(id);
  const keys = buildScopeKeys(scope);
  const parent = keys.chat ?? keys.branch;
  return `${parent}:${id}`;
}

function scopePrefix(scope: ArtifactScope): string {
  const keys = buildScopeKeys(scope);
  return `${keys.chat ?? keys.branch}:`;
}

function buildMetadata(record: ArtifactRecord): KvListMetadata {
  return {
    updatedAt: record.updatedAt,
    kind: record.kind,
    title: record.title,
  };
}

function matchesKindFilter(
  kind: ArtifactRecord['kind'],
  filter: ListArtifactsQuery['kind'],
): boolean {
  if (!filter) return true;
  const allowed = Array.isArray(filter) ? filter : [filter];
  return allowed.includes(kind);
}

export class WebKvArtifactStore implements ArtifactStore {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(scope: ArtifactScope, id: string): Promise<ArtifactRecord | null> {
    const raw = await this.kv.get(primaryKey(scope, id), 'text');
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ArtifactRecord;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Corrupt artifact at ${primaryKey(scope, id)}: ${message}`);
    }
  }

  async list(query: ListArtifactsQuery): Promise<ArtifactRecord[]> {
    const prefix = scopePrefix(query.scope);
    // Filter by metadata when possible to skip values we won't return.
    // KV's `list` returns up to 1000 keys per call by default — fine
    // until the v1 → SQLite swap point.
    const listing = await this.kv.list<KvListMetadata>({ prefix });
    type KvKey = (typeof listing.keys)[number];
    const candidates = listing.keys.filter((entry: KvKey) => {
      const meta = entry.metadata;
      if (!meta) return true; // older records without metadata still get fetched
      return matchesKindFilter(meta.kind, query.kind);
    });

    // Sort by metadata when available so we can apply `limit` before
    // dereferencing values that won't make it into the result.
    candidates.sort((a: KvKey, b: KvKey) => {
      const aTs = a.metadata?.updatedAt ?? 0;
      const bTs = b.metadata?.updatedAt ?? 0;
      return bTs - aTs;
    });
    const limited =
      query.limit !== undefined && query.limit >= 0 ? candidates.slice(0, query.limit) : candidates;

    const records = await Promise.all(
      limited.map(async (entry: KvKey) => {
        const raw = await this.kv.get(entry.name, 'text');
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as ArtifactRecord;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Corrupt artifact at ${entry.name}: ${message}`);
        }
      }),
    );
    return records
      .filter((r: ArtifactRecord | null): r is ArtifactRecord => r !== null)
      .filter((r: ArtifactRecord) => matchesKindFilter(r.kind, query.kind))
      .sort((a: ArtifactRecord, b: ArtifactRecord) => b.updatedAt - a.updatedAt);
  }

  async put(record: ArtifactRecord): Promise<void> {
    const key = primaryKey(record.scope, record.id);
    await this.kv.put(key, JSON.stringify(record), {
      metadata: buildMetadata(record),
    });
  }

  async delete(scope: ArtifactScope, id: string): Promise<void> {
    await this.kv.delete(primaryKey(scope, id));
  }
}
