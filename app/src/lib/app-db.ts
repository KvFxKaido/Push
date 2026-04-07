/**
 * Unified IndexedDB database for Push app data.
 *
 * Migrates heavy localStorage consumers into structured object stores
 * with proper indexing. Conversations, model metadata, checkpoints,
 * and usage logs live here instead of serialized JSON blobs in localStorage.
 */

const DB_NAME = 'push-app-db';
const DB_VERSION = 4;

export const STORE = {
  conversations: 'conversations',
  modelMetadata: 'model_metadata',
  checkpoints: 'checkpoints',
  usageLog: 'usage_log',
  runJournal: 'run_journal',
  memoryRecords: 'memory_records',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function normalizeKeyPath(keyPath: string | string[] | null): string {
  if (Array.isArray(keyPath)) return keyPath.join('\u0000');
  return keyPath ?? '';
}

function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options: IDBIndexParameters = {},
): void {
  const desiredKeyPath = normalizeKeyPath(keyPath);
  const desiredUnique = Boolean(options.unique);

  if (store.indexNames.contains(name)) {
    const existing = store.index(name);
    const existingKeyPath = normalizeKeyPath(existing.keyPath);
    if (existingKeyPath === desiredKeyPath && existing.unique === desiredUnique) {
      return;
    }
    store.deleteIndex(name);
  }

  store.createIndex(name, keyPath, options);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open push-app-db'));
    };

    req.onupgradeneeded = () => {
      const db = req.result;
      const upgradeTx = req.transaction;
      if (!upgradeTx) {
        throw new Error('IndexedDB upgrade transaction unavailable');
      }

      // Conversations — one record per conversation
      if (!db.objectStoreNames.contains(STORE.conversations)) {
        const convStore = db.createObjectStore(STORE.conversations, { keyPath: 'id' });
        convStore.createIndex('repoFullName', 'repoFullName', { unique: false });
        convStore.createIndex('lastMessageAt', 'lastMessageAt', { unique: false });
        convStore.createIndex('branch', 'branch', { unique: false });
      }

      // Model metadata — one record per provider
      if (!db.objectStoreNames.contains(STORE.modelMetadata)) {
        db.createObjectStore(STORE.modelMetadata, { keyPath: 'provider' });
      }

      // Checkpoints — one per chat
      if (!db.objectStoreNames.contains(STORE.checkpoints)) {
        const ckStore = db.createObjectStore(STORE.checkpoints, { keyPath: 'chatId' });
        ckStore.createIndex('savedAt', 'savedAt', { unique: false });
      }

      // Usage log — auto-increment ID, indexed by timestamp
      if (!db.objectStoreNames.contains(STORE.usageLog)) {
        const usageStore = db.createObjectStore(STORE.usageLog, { keyPath: 'id', autoIncrement: true });
        usageStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // Run journal — one entry per run, keyed by runId (Track B)
      if (!db.objectStoreNames.contains(STORE.runJournal)) {
        const journalStore = db.createObjectStore(STORE.runJournal, { keyPath: 'runId' });
        journalStore.createIndex('chatId', 'chatId', { unique: false });
        journalStore.createIndex('startedAt', 'startedAt', { unique: false });
      }

      // Memory records — typed artifact memory
      const memStore = db.objectStoreNames.contains(STORE.memoryRecords)
        ? upgradeTx.objectStore(STORE.memoryRecords)
        : db.createObjectStore(STORE.memoryRecords, { keyPath: 'id' });
      ensureIndex(memStore, 'repoFullName', 'scope.repoFullName', { unique: false });
      ensureIndex(memStore, 'chatId', 'scope.chatId', { unique: false });
      ensureIndex(memStore, 'branch', 'scope.branch', { unique: false });
      ensureIndex(memStore, 'kind', 'kind', { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
  });

  return dbPromise;
}

/**
 * Run a callback against an object store in a transaction.
 * Handles DB open, transaction lifecycle, and cleanup.
 */
export async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | IDBRequest[],
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = run(store);
    const request = Array.isArray(result) ? result[result.length - 1] : result;

    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB transaction failed on ${storeName}`));
    tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB transaction aborted on ${storeName}`));
  });
}

/**
 * Get all records from a store.
 */
export async function getAll<T>(storeName: string): Promise<T[]> {
  return withStore<T[]>(storeName, 'readonly', (store) => store.getAll());
}

/**
 * Get a single record by key.
 */
export async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(storeName, 'readonly', (store) => store.get(key));
}

/**
 * Put (upsert) a single record.
 */
export async function put<T>(storeName: string, value: T): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(storeName, 'readwrite', (store) => store.put(value));
}

/**
 * Delete a single record by key.
 */
export async function del(storeName: string, key: IDBValidKey): Promise<void> {
  return withStore<void>(storeName, 'readwrite', (store) => store.delete(key));
}

/**
 * Clear all records from a store.
 */
export async function clear(storeName: string): Promise<void> {
  return withStore<void>(storeName, 'readwrite', (store) => store.clear());
}

/**
 * Count records in a store.
 */
export async function count(storeName: string): Promise<number> {
  return withStore<number>(storeName, 'readonly', (store) => store.count());
}

/**
 * Put multiple records in a single transaction.
 */
export async function putMany<T>(storeName: string, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const value of values) {
      store.put(value);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB batch put failed on ${storeName}`));
  });
}
export async function deleteMany(storeName: string, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const key of keys) {
      store.delete(key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB batch delete failed on ${storeName}`));
  });
}

