/**
 * Checkpoint persistence backed by IndexedDB.
 *
 * Replaces per-chat localStorage keys (`run_checkpoint_${chatId}`)
 * with a single IndexedDB object store. Writes are fire-and-forget
 * (best-effort, matching the old localStorage behavior).
 */

import { STORE, get, put, del } from './app-db';
import { safeStorageGet, safeStorageRemove } from './safe-storage';
import type { RunCheckpoint } from '@/types';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';

const LEGACY_KEY_PREFIX = 'run_checkpoint_';

export async function saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
  try {
    await put(STORE.checkpoints, checkpoint);
  } catch {
    console.warn('[CheckpointStore] IndexedDB write failed');
  }
}

export async function loadCheckpoint(chatId: string): Promise<RunCheckpoint | null> {
  try {
    const record = await get<RunCheckpoint>(STORE.checkpoints, chatId);
    if (record) return record;
  } catch {
    // IndexedDB read failed — fall through to localStorage
  }

  // Legacy fallback: check localStorage
  try {
    const raw = safeStorageGet(`${LEGACY_KEY_PREFIX}${chatId}`);
    if (!raw) return null;
    const checkpoint = JSON.parse(raw) as RunCheckpoint;
    // Migrate to IndexedDB and clear localStorage
    void put(STORE.checkpoints, checkpoint).then(() => {
      safeStorageRemove(`${LEGACY_KEY_PREFIX}${chatId}`);
    });
    return checkpoint;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(chatId: string): Promise<void> {
  try {
    await del(STORE.checkpoints, chatId);
  } catch {
    // Best-effort
  }
  // Also clear legacy key if present
  safeStorageRemove(`${LEGACY_KEY_PREFIX}${chatId}`);
}

// ---------------------------------------------------------------------------
// RunCheckpointV1 (Durable Runs Phase 1) — self-contained per-turn records.
// Separate store from the legacy delta checkpoint; both keyed by chatId.
// ---------------------------------------------------------------------------

/** Throws on IndexedDB failure — the capture layer owns the structured log. */
export async function saveCheckpointV1(checkpoint: RunCheckpointV1): Promise<void> {
  await put(STORE.runCheckpointsV1, checkpoint);
}

export async function loadCheckpointV1(chatId: string): Promise<RunCheckpointV1 | null> {
  try {
    return (await get<RunCheckpointV1>(STORE.runCheckpointsV1, chatId)) ?? null;
  } catch {
    return null;
  }
}

export async function clearCheckpointV1(chatId: string): Promise<void> {
  try {
    await del(STORE.runCheckpointsV1, chatId);
  } catch {
    // Best-effort
  }
}
