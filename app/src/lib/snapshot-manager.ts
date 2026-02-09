import { downloadFromSandbox, hydrateSnapshotInSandbox } from '@/lib/sandbox-client';

const DB_NAME = 'push-snapshots-db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const CREATED_AT_INDEX = 'createdAt';
const SNAPSHOT_NAME = 'push-workspace-snapshot';

interface SnapshotRecord {
  id: string;
  name: string;
  blob: Blob;
  createdAt: number;
  sizeBytes: number;
}

export interface SnapshotMeta {
  id: string;
  name: string;
  createdAt: number;
  sizeBytes: number;
}

export interface HydrateProgress {
  stage: 'uploading' | 'restoring' | 'validating' | 'done';
  message: string;
}

function openSnapshotDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex(CREATED_AT_INDEX, 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openSnapshotDb().then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      run(store).then(resolve).catch(reject);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.oncomplete = () => db.close();
    });
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to encode snapshot blob'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

export async function createSnapshot(
  workspacePath: string = '/workspace',
  sandboxId?: string,
): Promise<Blob> {
  if (!sandboxId) {
    throw new Error('Sandbox ID is required to create a snapshot');
  }
  const archive = await downloadFromSandbox(sandboxId, workspacePath);
  if (!archive.ok || !archive.archiveBase64) {
    throw new Error(archive.error || 'Snapshot export failed');
  }
  return base64ToBlob(archive.archiveBase64, 'application/gzip');
}

export async function saveSnapshotToIndexedDB(
  name: string,
  blob: Blob,
): Promise<SnapshotMeta> {
  const now = Date.now();
  const record: SnapshotRecord = {
    id: `${now}-${crypto.randomUUID()}`,
    name: name.trim() || SNAPSHOT_NAME,
    blob,
    createdAt: now,
    sizeBytes: blob.size,
  };

  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(record));
    const index = store.index(CREATED_AT_INDEX);
    const all = await requestToPromise(index.getAll());
    const sorted = (all as SnapshotRecord[]).sort((a, b) => b.createdAt - a.createdAt);
    for (const stale of sorted.slice(3)) {
      await requestToPromise(store.delete(stale.id));
    }
  });

  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes,
  };
}

export async function getLatestSnapshotBlob(): Promise<Blob | null> {
  return withStore('readonly', async (store) => {
    const index = store.index(CREATED_AT_INDEX);
    const cursor = await requestToPromise(index.openCursor(null, 'prev'));
    if (!cursor) return null;
    const value = cursor.value as SnapshotRecord;
    return value.blob ?? null;
  });
}

export async function getLatestSnapshotMeta(): Promise<SnapshotMeta | null> {
  return withStore('readonly', async (store) => {
    const index = store.index(CREATED_AT_INDEX);
    const cursor = await requestToPromise(index.openCursor(null, 'prev'));
    if (!cursor) return null;
    const value = cursor.value as SnapshotRecord;
    return {
      id: value.id,
      name: value.name,
      createdAt: value.createdAt,
      sizeBytes: value.sizeBytes,
    };
  });
}

export async function hydrateSnapshot(
  blob: Blob,
  workspacePath: string = '/workspace',
  sandboxId?: string,
  onProgress?: (progress: HydrateProgress) => void,
): Promise<{ ok: boolean; restoredFiles?: number; error?: string }> {
  if (!sandboxId) {
    return { ok: false, error: 'Sandbox ID is required to restore a snapshot' };
  }
  onProgress?.({ stage: 'uploading', message: 'Uploading snapshot...' });
  const archiveBase64 = await blobToBase64(blob);
  onProgress?.({ stage: 'restoring', message: 'Restoring workspace files...' });
  const result = await hydrateSnapshotInSandbox(sandboxId, archiveBase64, workspacePath);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Restore failed' };
  }
  onProgress?.({ stage: 'validating', message: 'Validating restored workspace...' });
  onProgress?.({ stage: 'done', message: 'Snapshot restored.' });
  return { ok: true, restoredFiles: result.restoredFiles };
}
