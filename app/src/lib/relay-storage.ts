/**
 * relay-storage.ts — Persists paired-remote records for the Remote
 * (relay) workspace mode. Phase 2.f sibling to `local-pc-storage.ts`.
 *
 * Backed by IndexedDB (store `paired_remotes`). The attach-token
 * bearer rides in this record because the chat-layer hook needs it
 * for every WS dial; same XSS-exfil posture as the loopback store
 * (an injected script has to await an IDB transaction rather than
 * read a synchronous localStorage entry).
 *
 * Schema notes: separate store from `paired_devices` because the
 * field shapes diverge (loopback has `port`, relay has
 * `deploymentUrl + sessionId`). Mixing would force a discriminator
 * on every read; keeping them apart keeps each record narrow.
 *
 * Token discipline: this module is the only intentional writer of
 * the attach-token bearer beyond the in-memory `RelayBinding`.
 * Never echo into console output, telemetry, devtools, or error
 * payloads.
 */
import { STORE, clear, get, getAll, put } from './app-db';

export interface PairedRemoteRecord {
  /** Stable client-side id; not derived from the token. */
  id: string;
  deploymentUrl: string;
  sessionId: string;
  /**
   * Attach-token bearer (`pushd_da_*`). Never log, never copy
   * outside this module + the in-memory `RelayBinding`.
   */
  token: string;
  /** Phase 3 slice 2 attach tokenId, when surfaced by the daemon. */
  attachTokenId?: string;
  /** Parent device tokenId; `push daemon revoke <tokenId>` target. */
  deviceTokenId?: string;
  /** Wall-clock ms when the user pasted + confirmed. */
  pairedAt: number;
  /** Wall-clock ms of the last successful WS open. */
  lastUsedAt?: number;
}

const PAIRED_REMOTE_ID = 'relay-default';

/**
 * Mint a stable id for the (currently single) paired remote record.
 * Centralised so the pairing panel doesn't need to invent one and
 * a future multi-remote UI can swap in `crypto.randomUUID()` here.
 */
export function mintPairedRemoteId(): string {
  return PAIRED_REMOTE_ID;
}

/** Read the active paired remote, if any. */
export async function getPairedRemote(): Promise<PairedRemoteRecord | null> {
  const record = await get<PairedRemoteRecord>(STORE.pairedRemotes, PAIRED_REMOTE_ID);
  if (record) return record;
  // Defensive: surface the first record if a future UI lands an
  // alternate id. Today this path is unreachable but cheap.
  const all = await getAll<PairedRemoteRecord>(STORE.pairedRemotes);
  return all[0] ?? null;
}

/** Persist or overwrite the active paired remote. */
export async function setPairedRemote(record: PairedRemoteRecord): Promise<void> {
  await put(STORE.pairedRemotes, record);
}

/** Forget the paired remote (Unpair / Re-pair). Idempotent. */
export async function clearPairedRemote(): Promise<void> {
  await clear(STORE.pairedRemotes);
}

/**
 * Stamp `lastUsedAt` on the active record. Best-effort; callers fire
 * and forget; we never block the connection lifecycle on storage.
 */
export async function touchPairedRemoteLastUsed(
  id: string,
  ts: number = Date.now(),
): Promise<void> {
  const record = await get<PairedRemoteRecord>(STORE.pairedRemotes, id);
  if (!record) return;
  await put(STORE.pairedRemotes, { ...record, lastUsedAt: ts });
}
