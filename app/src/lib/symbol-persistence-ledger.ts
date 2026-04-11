/**
 * Symbol Persistence Ledger — cross-session symbol cache backed by IndexedDB.
 *
 * When `sandbox_read_symbols` extracts symbols from a file, the result is
 * cached here. Subsequent calls check the ledger first and skip the sandbox
 * round-trip if the entry is still fresh. Entries are invalidated when:
 *   - The file is edited (sandbox_edit_file, sandbox_write_file, etc.)
 *   - A broad mutation occurs (sandbox_exec that marks all files stale)
 *   - The sandbox is torn down / branch is switched
 *
 * Storage: standalone IndexedDB database (`push-symbol-ledger`, `symbols`
 * store). In-memory Map for synchronous fast-path lookups; IndexedDB is the
 * durable backing store.
 */

import type { SandboxSymbol } from './sandbox-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolLedgerEntry {
  /** Compound key: `${repo}:${branch}:${filePath}` */
  key: string;
  /** Repository full name (owner/repo) or 'scratch', includes branch */
  repo: string;
  /** Absolute file path in the sandbox (e.g. /workspace/src/lib/foo.ts) */
  filePath: string;
  /** Extracted symbols */
  symbols: SandboxSymbol[];
  /** Total lines in the file at extraction time */
  totalLines: number;
  /** Timestamp (ms) when symbols were extracted */
  cachedAt: number;
}

export interface SymbolLedgerMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  bulkInvalidations: number;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (standalone — no app-db version bump needed)
// ---------------------------------------------------------------------------

const DB_NAME = 'push-symbol-ledger';
const DB_VERSION = 1;
const STORE_NAME = 'symbols';

let dbPromise: Promise<IDBDatabase> | null = null;

function openSymbolDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open symbol-ledger DB'));
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('repo', 'repo', { unique: false });
        store.createIndex('filePath', 'filePath', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });

  return dbPromise;
}

async function idbPut(entry: SymbolLedgerEntry): Promise<void> {
  try {
    const db = await openSymbolDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort persistence
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openSymbolDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort
  }
}

async function idbDeleteByRepo(repo: string): Promise<void> {
  try {
    const db = await openSymbolDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('repo');
      const req = index.openCursor(IDBKeyRange.only(repo));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort
  }
}

async function idbDeleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    const db = await openSymbolDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of keys) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort
  }
}

async function idbGetAllForRepo(repo: string): Promise<SymbolLedgerEntry[]> {
  try {
    const db = await openSymbolDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const index = tx.objectStore(STORE_NAME).index('repo');
      const req = index.getAll(IDBKeyRange.only(repo));
      tx.oncomplete = () => resolve((req.result as SymbolLedgerEntry[]) ?? []);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SymbolPersistenceLedger
// ---------------------------------------------------------------------------

/** Maximum age for a cached entry before it's considered stale (1 hour). */
const MAX_AGE_MS = 60 * 60 * 1000;

/** Maximum files to include in the system prompt summary. */
const MAX_SUMMARY_FILES = 200;
/** Maximum characters for the summary body. */
const MAX_SUMMARY_CHARS = 4000;

export class SymbolPersistenceLedger {
  /** In-memory fast-path cache. */
  private cache = new Map<string, SymbolLedgerEntry>();
  private _metrics: SymbolLedgerMetrics = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    bulkInvalidations: 0,
  };
  private currentRepo: string = '';

  // -----------------------------------------------------------------------
  // Key helpers
  // -----------------------------------------------------------------------

  private makeKey(filePath: string): string {
    return `${this.currentRepo}:${filePath}`;
  }

  /** Normalize sandbox paths for consistent lookup. */
  private normalizePath(path: string): string {
    // Ensure leading /workspace/ for consistency
    if (!path.startsWith('/workspace/') && !path.startsWith('/')) {
      return `/workspace/${path}`;
    }
    return path;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Set the active repo+branch context. Call on repo selection / sandbox creation.
   * Key format: `${repoFullName}:${branch}` or `'scratch'`.
   */
  setRepo(repo: string): void {
    this.currentRepo = repo;
  }

  /**
   * Load all entries for the current repo from IndexedDB into the in-memory
   * cache. Expired entries are deleted from IndexedDB during hydration to
   * keep the persisted store bounded.
   */
  async hydrate(): Promise<void> {
    if (!this.currentRepo) return;
    const entries = await idbGetAllForRepo(this.currentRepo);
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const entry of entries) {
      if (now - entry.cachedAt > MAX_AGE_MS) {
        expiredKeys.push(entry.key);
        continue;
      }
      this.cache.set(entry.key, entry);
    }
    // Compact expired entries from IndexedDB
    if (expiredKeys.length > 0) {
      void idbDeleteKeys(expiredKeys);
    }
  }

  /** Reset the in-memory cache (on sandbox teardown / branch switch). */
  reset(): void {
    this.cache.clear();
    this._metrics = { hits: 0, misses: 0, invalidations: 0, bulkInvalidations: 0 };
  }

  /** Clear all persisted entries for the current repo (on sandbox teardown). */
  async clearRepo(): Promise<void> {
    if (!this.currentRepo) return;
    // Clear in-memory entries for this repo
    for (const [key, entry] of this.cache.entries()) {
      if (entry.repo === this.currentRepo) {
        this.cache.delete(key);
      }
    }
    await idbDeleteByRepo(this.currentRepo);
  }

  // -----------------------------------------------------------------------
  // Read / Write
  // -----------------------------------------------------------------------

  /**
   * Look up cached symbols for a file. Returns the entry if fresh, or
   * undefined if missing/expired.
   */
  lookup(filePath: string): SymbolLedgerEntry | undefined {
    const path = this.normalizePath(filePath);
    const key = this.makeKey(path);
    const entry = this.cache.get(key);

    if (!entry) {
      this._metrics.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > MAX_AGE_MS) {
      this.cache.delete(key);
      void idbDelete(key);
      this._metrics.misses++;
      return undefined;
    }

    this._metrics.hits++;
    return entry;
  }

  /**
   * Cache symbols for a file. Called after a successful `sandbox_read_symbols`.
   * Caches empty results too so files with no symbols don't keep hitting the sandbox.
   */
  store(filePath: string, symbols: SandboxSymbol[], totalLines: number): void {
    const path = this.normalizePath(filePath);
    const key = this.makeKey(path);
    const entry: SymbolLedgerEntry = {
      key,
      repo: this.currentRepo,
      filePath: path,
      symbols,
      totalLines,
      cachedAt: Date.now(),
    };
    this.cache.set(key, entry);
    void idbPut(entry);
  }

  // -----------------------------------------------------------------------
  // Invalidation
  // -----------------------------------------------------------------------

  /**
   * Invalidate a single file's cached symbols (on edit/write).
   * Always deletes from IndexedDB regardless of in-memory cache state,
   * since hydrate() may not have completed yet.
   */
  invalidate(filePath: string): void {
    const path = this.normalizePath(filePath);
    const key = this.makeKey(path);
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this._metrics.invalidations++;
    }
    // Always delete from IndexedDB — cache may not be fully hydrated
    void idbDelete(key);
  }

  /**
   * Invalidate all cached symbols for the current repo.
   * Used after broad mutations (sandbox_exec, etc.).
   * Always clears IndexedDB regardless of in-memory cache state.
   */
  invalidateAll(): void {
    if (!this.currentRepo) return;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.repo === this.currentRepo) {
        this.cache.delete(key);
      }
    }
    this._metrics.bulkInvalidations++;
    // Always clear IndexedDB — cache may not be fully hydrated
    void idbDeleteByRepo(this.currentRepo);
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Search all cached symbols across the current repo for a name.
   * Returns matching entries with their file paths — the "Where is X?" lookup.
   */
  findSymbol(name: string): Array<{ filePath: string; symbol: SandboxSymbol }> {
    const results: Array<{ filePath: string; symbol: SandboxSymbol }> = [];
    const now = Date.now();
    for (const entry of this.cache.values()) {
      if (entry.repo !== this.currentRepo) continue;
      if (now - entry.cachedAt > MAX_AGE_MS) continue;
      for (const sym of entry.symbols) {
        if (sym.name === name) {
          results.push({ filePath: entry.filePath, symbol: sym });
        }
      }
    }
    return results;
  }

  /**
   * Get a summary of all cached files and their symbol counts.
   * Capped at MAX_SUMMARY_FILES / MAX_SUMMARY_CHARS to prevent prompt bloat.
   */
  getSummary(): string | null {
    const lines: string[] = [];
    const now = Date.now();
    let bodyCharCount = 0;
    let truncated = false;

    for (const entry of this.cache.values()) {
      if (entry.repo !== this.currentRepo) continue;
      if (now - entry.cachedAt > MAX_AGE_MS) continue;

      if (lines.length >= MAX_SUMMARY_FILES) {
        truncated = true;
        break;
      }

      const displayPath = entry.filePath.replace(/^\/workspace\//, '');
      const line = `  ${displayPath}: ${entry.symbols.length} symbols (${entry.totalLines} lines)`;

      if (bodyCharCount + line.length + 1 > MAX_SUMMARY_CHARS) {
        truncated = true;
        break;
      }

      lines.push(line);
      bodyCharCount += line.length + 1;
    }

    if (lines.length === 0) return null;
    return `Symbol cache (${lines.length} files${truncated ? ', truncated' : ''}):\n${lines.join('\n')}`;
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  getMetrics(): SymbolLedgerMetrics {
    return { ...this._metrics };
  }

  get size(): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (entry.repo === this.currentRepo) count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const symbolLedger = new SymbolPersistenceLedger();
