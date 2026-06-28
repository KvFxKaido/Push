import type { VerbatimEntry, VerbatimLog } from '@push/lib/verbatim-log';
import { verbatimScopeMatches, verbatimScopedRef } from '@push/lib/verbatim-log';
import { STORE, count, deleteMany, get, getAll, put } from './app-db';

export * from '@push/lib/verbatim-log';

/**
 * IndexedDB-backed verbatim log for the web app — the durable backing store for
 * typed memory's `verbatimRef` (LCM #1234). The web typed-record store is
 * already IndexedDB-durable (`createIndexedDbStore`), but the verbatim log
 * defaulted to in-memory, so a `memory_expand` ref dead-ended after a reload.
 * This backend persists the full text in `app-db` alongside the records, so
 * expansion survives across sessions, not just within one.
 *
 * Semantics match `createInMemoryVerbatimLog` in `lib/verbatim-log.ts`:
 * append-only and never-overwritten, content-addressed with a collision-safe
 * probe, soft-scope `listByScope`, and age-based `pruneOlderThan`. Scans use
 * `getAll` + filter — the same approach `createIndexedDbStore` takes for its
 * scoped clears; per-scope verbatim volume is small.
 *
 * Not wired here: orphan collection. A verbatim entry outlives the typed record
 * that referenced it once that record is freshness-pruned. `pruneOlderThan` is
 * the lever a future GC would pull; see #1234 for the deferred follow-up.
 */
export function createIndexedDbVerbatimLog(): VerbatimLog {
  return {
    async append(input) {
      const { scope, text, kind, label, now = Date.now() } = input;
      const base = verbatimScopedRef(scope, text);
      // Collision-safe identity: reuse the entry on an exact text match, else
      // probe a disambiguated ref so two distinct texts never share one ref.
      // A `put` only lands on an empty ref (or after the exact-match early
      // return), so it never overwrites a different text. Mirrors the in-memory
      // backend; the only residual race is two *different* texts that both hash
      // to one ref appended concurrently — which needs a genuine hash collision
      // and at worst loses one entry (expands as "Not found"), never a wrong read.
      let ref = base;
      for (let probe = 1; ; probe++) {
        const existing = await get<VerbatimEntry>(STORE.verbatim, ref);
        if (!existing) break;
        if (existing.text === text) return existing;
        ref = `${base}_${probe + 1}`;
      }
      const entry: VerbatimEntry = {
        ref,
        scope: { ...scope },
        text,
        byteLen: text.length,
        createdAt: now,
        ...(kind ? { kind } : {}),
        ...(label ? { label } : {}),
      };
      await put(STORE.verbatim, entry);
      return entry;
    },
    async read(ref) {
      return get<VerbatimEntry>(STORE.verbatim, ref);
    },
    async listByScope(scope, predicate) {
      const all = await getAll<VerbatimEntry>(STORE.verbatim);
      const out = all.filter(
        (entry) => verbatimScopeMatches(scope, entry.scope) && (!predicate || predicate(entry)),
      );
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    },
    async pruneOlderThan(cutoffMs) {
      const all = await getAll<VerbatimEntry>(STORE.verbatim);
      const stale = all.filter((entry) => entry.createdAt < cutoffMs);
      await deleteMany(
        STORE.verbatim,
        stale.map((entry) => entry.ref),
      );
      return stale.length;
    },
    async size() {
      return count(STORE.verbatim);
    },
  };
}
