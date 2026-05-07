/**
 * Workers KV implementation of `ArtifactStore`.
 *
 * Layout: each artifact persists at the canonical key from
 * `primaryStorageKey(scope, id)` in `lib/artifacts/scope.ts` — the
 * same shape the CLI store derives from. Sharing the helper keeps
 * key-shape changes centralized so a future migration touches one
 * file.
 *
 * List operations walk all KV `list({ prefix })` pages until
 * `list_complete`, then dereference each value, then filter and sort
 * on the real record fields. The N+1 pattern is acceptable at v1
 * cardinality ("a few dozen artifacts per branch" per the lib
 * interface doc) and the swap target is SQLite if listing pressure
 * shows up.
 *
 * Per-record metadata (`{ updatedAt, kind, title }`) is still written
 * at `put` time because KV's `metadata` slot is essentially free, and
 * a future re-introduction of the metadata fast-path can light up
 * without a migration. List operations don't read it today — the
 * record value is the single source of truth, which avoids false
 * negatives if metadata ever drifts.
 *
 * Path-safety: `assertSafeArtifactId` rejects ids containing `:` or
 * other path-shaping characters. KV keys aren't filesystem paths but
 * the `:` delimiter in our scope-key shape would otherwise let an id
 * like `art:foo` collide with another scope's records.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { buildScopeKeys, primaryStorageKey } from '@push/lib/artifacts/scope';
import type { ArtifactRecord, ArtifactScope } from '@push/lib/artifacts/types';
import type { ArtifactStore, ListArtifactsQuery } from '@push/lib/artifacts/store';

interface KvListMetadata {
  updatedAt: number;
  kind: ArtifactRecord['kind'];
  title: string;
}

/**
 * Typed error so handlers can distinguish a client-side id-validation
 * failure (400) from a server-side KV failure (500). The previous
 * generic `Error` had handlers blanket-mapping every store exception
 * to `INVALID_ID`, which masked real outages.
 */
export class InvalidArtifactIdError extends Error {
  constructor(id: string) {
    super(`Invalid artifact id ${JSON.stringify(id)}: must match /^[A-Za-z0-9_-]{1,128}$/.`);
    this.name = 'InvalidArtifactIdError';
  }
}

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeArtifactId(id: string): void {
  if (!SAFE_ARTIFACT_ID.test(id)) {
    throw new InvalidArtifactIdError(id);
  }
}

function recordKey(scope: ArtifactScope, id: string): string {
  assertSafeArtifactId(id);
  return primaryStorageKey(scope, id);
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

interface KvKeyEntry {
  name: string;
}

/**
 * Walk every page of `kv.list({ prefix })` until `list_complete`.
 * Workers KV caps a single `list` call at 1000 keys, and a long-lived
 * chat that crosses that boundary would otherwise silently drop
 * artifacts past the first page from `list()` results.
 */
async function listAllKeys(kv: KVNamespace, prefix: string): Promise<KvKeyEntry[]> {
  const all: KvKeyEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<KvListMetadata>({ prefix, cursor });
    for (const key of page.keys) all.push({ name: key.name });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return all;
}

export class WebKvArtifactStore implements ArtifactStore {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(scope: ArtifactScope, id: string): Promise<ArtifactRecord | null> {
    const key = recordKey(scope, id);
    const raw = await this.kv.get(key, 'text');
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ArtifactRecord;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Corrupt artifact at ${key}: ${message}`);
    }
  }

  async list(query: ListArtifactsQuery): Promise<ArtifactRecord[]> {
    const prefix = scopePrefix(query.scope);
    const entries = await listAllKeys(this.kv, prefix);

    // Fetch every value, filter and sort on the real record fields.
    // Treating the record as the single source of truth (rather than
    // KV metadata) avoids false-negative drops if metadata ever drifts
    // — Copilot's read on the previous metadata fast-path. Limit
    // applies after sort so newest-first semantics hold even if some
    // entries are missing metadata.
    const records = await Promise.all(
      entries.map(async (entry) => {
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

    const filtered = records
      .filter((r: ArtifactRecord | null): r is ArtifactRecord => r !== null)
      .filter((r: ArtifactRecord) => matchesKindFilter(r.kind, query.kind))
      .sort((a: ArtifactRecord, b: ArtifactRecord) => b.updatedAt - a.updatedAt);

    if (query.limit !== undefined && query.limit >= 0) {
      return filtered.slice(0, query.limit);
    }
    return filtered;
  }

  async put(record: ArtifactRecord): Promise<void> {
    const key = recordKey(record.scope, record.id);
    await this.kv.put(key, JSON.stringify(record), {
      metadata: buildMetadata(record),
    });
  }

  async delete(scope: ArtifactScope, id: string): Promise<void> {
    await this.kv.delete(recordKey(scope, id));
  }
}
