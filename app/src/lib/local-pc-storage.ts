/**
 * local-pc-storage.ts — Persists paired-device records for the Local
 * PC workspace mode.
 *
 * Backed by IndexedDB rather than localStorage. The async surface
 * makes opportunistic XSS exfiltration of the bearer token harder
 * than a synchronous `localStorage.getItem` would (an injected script
 * needs to await the IDB transaction), and the structured store lets
 * a future UI manage multiple paired devices without a JSON-blob
 * migration. Today only one record exists at a time; the storage
 * shape is just slightly ahead of the UI.
 *
 * Token discipline: this module is the only intentional writer of
 * the bearer beyond the in-memory `LocalPcBinding`. Callers must
 * never echo it into console output, telemetry, redux devtools, or
 * error-reporter payloads.
 */
import { STORE, clear, get, getAll, put } from './app-db';

/**
 * One paired pushd. Mirrors the inline binding carried on a
 * `kind: 'local-pc'` WorkspaceSession, plus pairing-time metadata.
 *
 * `id` is the keyPath. We mint it at pair time so the UI can show
 * (and a future multi-device list can manage) a stable handle.
 */
export interface PairedDeviceRecord {
  /** Stable client-side id; not derived from the token. */
  id: string;
  port: number;
  /**
   * Bearer token used for WS upgrades. Phase 3 slice 2: after the
   * pairing flow successfully mints a device-attach token, this field
   * is REPLACED with the attach token (`pushd_da_...`) and the
   * durable device token is wiped from IndexedDB. The two kinds are
   * indistinguishable from the upgrade-header carrier's POV — both
   * travel as `Authorization: Bearer <token>` or
   * `Sec-WebSocket-Protocol: bearer.<token>`. The daemon's WS auth
   * tries attach first, falls back to device. Storage doesn't need
   * to differentiate.
   *
   * Never log, never copy outside this module.
   */
  token: string;
  /**
   * Phase 3 slice 2: when `token` is a device-attach token, this is
   * the matching attach tokenId (`pdat_...`). When `token` is still
   * the durable device token (briefly, during the pairing window
   * before the first mint), this is undefined. Lets a future UI
   * surface "this device hasn't completed the security handoff yet"
   * without inspecting the secret.
   */
  attachTokenId?: string;
  /**
   * Token id printed by `push daemon pair`. Optional in PR 3b — the
   * web pair flow doesn't have a way to fetch the matching id from
   * the daemon yet. See LocalPcBinding for the follow-up.
   */
  tokenId?: string;
  /** Origin the CLI bound the token to at mint time. */
  boundOrigin: string;
  /** Wall-clock ms when the user pasted + confirmed. */
  pairedAt: number;
  /** Wall-clock ms of the last successful WS open. */
  lastUsedAt?: number;
}

const PAIRED_DEVICE_ID = 'local-pc-default';

/**
 * Mint a stable device id for the (currently single) paired record.
 * Centralised so the pairing panel doesn't need to invent one and
 * a future multi-device UI can swap in `crypto.randomUUID()` here.
 */
export function mintPairedDeviceId(): string {
  return PAIRED_DEVICE_ID;
}

/** Read the active paired device, if any. */
export async function getPairedDevice(): Promise<PairedDeviceRecord | null> {
  const record = await get<PairedDeviceRecord>(STORE.pairedDevices, PAIRED_DEVICE_ID);
  if (record) return record;
  // Defensive: if a future UI lands an alternate id before we update
  // this read path, surface the first record so the workspace screen
  // can still resume. Today this path is unreachable but cheap.
  const all = await getAll<PairedDeviceRecord>(STORE.pairedDevices);
  return all[0] ?? null;
}

/** Persist or overwrite the active paired device. */
export async function setPairedDevice(record: PairedDeviceRecord): Promise<void> {
  await put(STORE.pairedDevices, record);
}

/** Forget the paired device (Unpair / Re-pair). Idempotent. */
export async function clearPairedDevice(): Promise<void> {
  // Wipe the whole store rather than just the known id — keeps any
  // stray records from earlier schema revisions from lingering.
  await clear(STORE.pairedDevices);
}

/**
 * Stamp `lastUsedAt` on the active record. Best-effort: callers fire
 * and forget; we never block the connection lifecycle on storage.
 */
export async function touchLastUsed(id: string, ts: number = Date.now()): Promise<void> {
  const record = await get<PairedDeviceRecord>(STORE.pairedDevices, id);
  if (!record) return;
  await put(STORE.pairedDevices, { ...record, lastUsedAt: ts });
}

/**
 * Phase 3 slice 2: replace the stored bearer with a device-attach
 * token. Called after the chat layer's first successful WS open mints
 * one. The durable device token is overwritten — that's intentional;
 * the device token's only remaining purpose was bootstrapping this
 * attach token, and keeping it around would defeat the slice's
 * blast-radius reduction goal. If the attach token later expires or
 * is revoked, the user re-pairs to get a fresh device token.
 */
export async function upgradeToAttachToken(
  id: string,
  opts: { token: string; attachTokenId: string },
): Promise<void> {
  const record = await get<PairedDeviceRecord>(STORE.pairedDevices, id);
  if (!record) return;
  await put(STORE.pairedDevices, {
    ...record,
    token: opts.token,
    attachTokenId: opts.attachTokenId,
  });
}
