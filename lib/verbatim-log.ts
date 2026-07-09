/**
 * Append-only verbatim log — the lossless backing store behind typed memory
 * (LCM Phase 3).
 *
 * The typed `MemoryRecord` store (`context-memory-store.ts`) is small, ranked,
 * packed, and freshness-expired; its `detail` is truncated on write
 * (`MAX_DETAIL_CHARS` = 2000) and again on persist
 * (`PERSISTED_DETAIL_MAX_CHARS` = 800). That truncation is what makes
 * `memory_expand` only *selectively* verbatim today: a long diff, full stack
 * trace, or multi-thousand-line command log is already lossy by the time it is
 * stored, so the model can never recall the true original.
 *
 * This module is the other half: an **append-only, never-mutated** store of the
 * full original text, content-addressed so a typed record (or a reduced tool
 * result — see `tool-output-reducers.ts`, whose "keep the raw" half this backs)
 * can carry a small `ref` pointer and the model can pull the exact bytes back on
 * demand. Writes never overwrite; the only mutation is age-based pruning, which
 * deletes whole entries rather than editing them.
 *
 * Why this lives in `lib/` from day one: the LCM decision doc requires the
 * durable backend to be a web/CLI-symmetric contract with repo-scoped recall
 * plus optional branch/chat refinements (new-feature checklist #1), not a
 * per-surface bolt-on. This file is that contract plus the in-memory backend
 * (default + tests); the CLI ships a file/JSONL backend mirroring
 * `cli/context-memory-file-store.ts`, and a Worker-side durable backend lands
 * when one exists (deferred exactly like Phase 2's background-coder memory).
 *
 * Hashing is dependency-free on purpose: `lib/` is bundled for the browser and
 * the Cloudflare Worker, where `node:crypto` is not available. We use FNV-1a
 * plus the byte length as the content key, and — because a hash collision that
 * silently returned the *wrong* verbatim text would defeat the entire point of
 * a lossless store — `append` verifies the stored text on a ref hit and probes
 * a disambiguated ref on the (astronomically rare) genuine collision. Identity
 * is therefore exact regardless of hash strength.
 *
 * The kernel is intentionally side-effect-free and **does not log**, mirroring
 * `context-memory-retrieval.ts` / `context-memory-expand.ts`. Symmetric
 * structured logs (`verbatim_read_hit` ↔ `verbatim_read_miss`, etc.) belong at
 * the integration call-site (the write path and the memory tool), where the
 * wiring increment adds them — keeping unit tests and the packer quiet.
 *
 * Pure module — safe for both web and CLI.
 */

/**
 * Durable scope for a verbatim entry. `repoFullName` is the required isolation
 * boundary; `branch` and `chatId` are optional refinements chosen by each
 * retention path. Chat-carried refs can deliberately omit `branch` so a marker
 * remains recallable after switch_branch/create_branch.
 */
export interface VerbatimScope {
  repoFullName: string;
  branch?: string;
  chatId?: string;
}

/** What was stored, returned verbatim. */
export interface VerbatimEntry {
  /** Content-addressed handle, e.g. `vb_1a2b3c4d_5120`. Stable + immutable. */
  ref: string;
  scope: VerbatimScope;
  /** The full, untruncated original text. */
  text: string;
  /** UTF-16 length of `text` (cheap; matches `.length` callers reason about). */
  byteLen: number;
  createdAt: number;
  /** Optional provenance tag, e.g. `tool_output` | `memory_detail`. */
  kind?: string;
  /** Optional human label for `ls`/debug, e.g. the command or record id. */
  label?: string;
}

export interface VerbatimAppendInput {
  scope: VerbatimScope;
  text: string;
  kind?: string;
  label?: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/**
 * Append-only verbatim store. Every method returns `T | Promise<T>` so the
 * in-memory backend can be synchronous while file/Worker backends are async —
 * the same shape `ContextMemoryStore` uses, so callers `await` uniformly.
 */
export interface VerbatimLog {
  /**
   * Store `text` verbatim and return its entry. Idempotent on identical
   * (scope, text): a repeat append returns the existing entry rather than
   * duplicating it. Never overwrites an existing entry's text.
   */
  append(input: VerbatimAppendInput): VerbatimEntry | Promise<VerbatimEntry>;
  /** Resolve a `ref` to its entry, or `undefined` if unknown/pruned. */
  read(ref: string): VerbatimEntry | undefined | Promise<VerbatimEntry | undefined>;
  /** All entries matching `scope` (soft match: a scope dimension only excludes
   *  when both sides name it and differ), newest-first, optional predicate. */
  listByScope(
    scope: VerbatimScope,
    predicate?: (entry: VerbatimEntry) => boolean,
  ): VerbatimEntry[] | Promise<VerbatimEntry[]>;
  /** Delete entries created strictly before `cutoffMs`. Returns the count
   *  removed. Age-based, not freshness-based — verbatim text has no `stale`
   *  state, it is either retained or aged out. */
  pruneOlderThan(cutoffMs: number, now?: number): number | Promise<number>;
  /** Total entry count (across all scopes). */
  size(): number | Promise<number>;
}

/**
 * FNV-1a (32-bit) over the UTF-16 code units of `text`. Not cryptographic and
 * not collision-proof on its own — `append` guarantees identity by verifying
 * stored text on a hit and probing on a genuine collision. Combined with
 * `byteLen` in the ref, accidental collisions for our scale are vanishingly
 * unlikely, and the verify step makes a collision merely produce a second
 * entry, never a wrong read.
 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    // Mix the high byte too so multi-byte code units affect the hash.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    hash ^= (text.charCodeAt(i) >> 8) & 0xff;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Base content ref (pre-disambiguation): `vb_<hash>_<len>`. */
export function verbatimBaseRef(text: string): string {
  return `vb_${fnv1aHex(text)}_${text.length}`;
}

function scopeKey(scope: VerbatimScope): string {
  return `${scope.repoFullName}\0${scope.branch ?? ''}\0${scope.chatId ?? ''}`;
}

/**
 * Scope-aware base ref. Content addressing is folded with the scope so identical
 * text in *different* scopes gets *distinct* refs. This is required for
 * correctness, not just tidiness: entries are scope-guarded on direct read
 * (`memory_expand` refs / `verbatimScopeMatches`), so a cross-scope-deduped ref
 * would point at an entry the caller's scope rejects — the ref would expand as
 * "Not found". Per-scope refs keep every advertised ref resolvable in the scope
 * that produced it. (The length suffix reflects the hashed input, not `text` —
 * it's an opaque collision-spreader, not a parsed field.)
 */
export function verbatimScopedRef(scope: VerbatimScope, text: string): string {
  return verbatimBaseRef(`${scopeKey(scope)}\0${text}`);
}

/**
 * Soft scope match mirroring `scoreRecord`/`expandMemoryRecords`: a dimension
 * excludes only when the query names it and the entry's value differs. A query
 * that omits `branch`/`chatId` matches entries regardless of theirs. Exported as
 * `verbatimScopeMatches` so direct ref reads (`memory_expand` refs) enforce the
 * same cross-repo guard.
 */
export function verbatimScopeMatches(query: VerbatimScope, entry: VerbatimScope): boolean {
  if (query.repoFullName && entry.repoFullName && query.repoFullName !== entry.repoFullName) {
    return false;
  }
  if (query.branch && entry.branch && query.branch !== entry.branch) return false;
  if (query.chatId && entry.chatId && query.chatId !== entry.chatId) return false;
  return true;
}

/**
 * In-memory backend: default store and the one tests run against. Entries live
 * for the life of the process; the store shape is deliberately identical to the
 * durable backends so swapping in a file/Worker store needs no caller change.
 */
export function createInMemoryVerbatimLog(): VerbatimLog {
  const entries = new Map<string, VerbatimEntry>();

  return {
    append(input) {
      const { scope, text, kind, label, now = Date.now() } = input;
      const base = verbatimScopedRef(scope, text);
      // Collision-safe identity: reuse on an exact text match, otherwise probe
      // a disambiguated ref so two distinct texts can never share one ref. The
      // base is scope-aware, so identical text in another scope gets its own ref.
      let ref = base;
      for (let probe = 1; ; probe++) {
        const existing = entries.get(ref);
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
      entries.set(ref, entry);
      return entry;
    },
    read(ref) {
      return entries.get(ref);
    },
    listByScope(scope, predicate) {
      const out: VerbatimEntry[] = [];
      for (const entry of entries.values()) {
        if (!verbatimScopeMatches(scope, entry.scope)) continue;
        if (predicate && !predicate(entry)) continue;
        out.push(entry);
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    },
    pruneOlderThan(cutoffMs) {
      let removed = 0;
      for (const [ref, entry] of entries.entries()) {
        if (entry.createdAt < cutoffMs) {
          entries.delete(ref);
          removed++;
        }
      }
      return removed;
    },
    size() {
      return entries.size;
    },
  };
}

let defaultLog: VerbatimLog | null = null;

/** Process-default verbatim log. Lazily created in-memory; the CLI replaces it
 *  with the file backend via `setDefaultVerbatimLog`, mirroring the typed
 *  store's `getDefaultMemoryStore` / `setDefaultMemoryStore` pair. */
export function getDefaultVerbatimLog(): VerbatimLog {
  if (!defaultLog) defaultLog = createInMemoryVerbatimLog();
  return defaultLog;
}

export function setDefaultVerbatimLog(log: VerbatimLog | null): void {
  defaultLog = log;
}
