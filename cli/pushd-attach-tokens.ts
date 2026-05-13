/**
 * pushd-attach-tokens.ts — Device-attach token store. Phase 3 slice 2
 * of the remote-sessions track.
 *
 * Attach tokens are SHORT-LIVED credentials minted from a parent
 * device token. The pairing flow stores the device token in the
 * browser briefly, mints an attach token on first successful WS
 * connect, then clears the device token. Subsequent WS upgrades use
 * the attach token. Revoking the parent device token cascades and
 * invalidates every attach token minted from it.
 *
 * Storage: `~/.push/run/pushd.attach-tokens` (override via
 * `PUSHD_ATTACH_TOKENS_PATH`). NDJSON, mode 0600 / dir mode 0700 —
 * same posture as `pushd.tokens`.
 *
 * TTL semantics: sliding. Each successful `verifyDeviceAttachToken`
 * call refreshes `lastUsedAt`; on the next read, a record whose
 * `lastUsedAt + ttlMs < now` is treated as nonexistent (eviction is
 * lazy, no background sweep). The TTL is configurable via
 * `PUSHD_ATTACH_TOKEN_TTL_MS`; default is 24 hours.
 *
 * Invariants this module enforces:
 *  - Token text is never persisted (only the SHA-256 hash).
 *  - Token text is exposed exactly once — by `mintDeviceAttachToken`.
 *  - Error/status messages never include the token text.
 *  - Every attach token records its `parentTokenId` so cascade-revoke
 *    can find children. Revoking a parent never leaves orphaned
 *    children behind.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import type { BoundOrigin } from './pushd-device-tokens.js';

export interface AttachTokenRecord {
  tokenId: string;
  tokenHash: string;
  /** tokenId of the device token this attach token was minted from. */
  parentTokenId: string;
  /** Origin binding inherited from the parent at mint time. */
  boundOrigin: BoundOrigin;
  createdAt: number;
  /** Updated on each successful verify; drives sliding-TTL eviction. */
  lastUsedAt: number;
}

export interface MintAttachTokenResult {
  /** The secret token, formatted as the value to put after `Bearer `. */
  token: string;
  /** Public handle for revocation; safe to print/log. */
  tokenId: string;
  /** TTL the daemon will honor; surface to the client so it can plan refresh. */
  ttlMs: number;
  /** The persisted record (no secret). */
  record: AttachTokenRecord;
}

const TOKEN_PREFIX = 'pushd_da_';
const TOKEN_ID_PREFIX = 'pdat_';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function getAttachTokenTtlMs(): number {
  const raw = process.env.PUSHD_ATTACH_TOKEN_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

function getAttachTokensPath(): string {
  if (process.env.PUSHD_ATTACH_TOKENS_PATH) return process.env.PUSHD_ATTACH_TOKENS_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.attach-tokens');
}

function getAttachTokensDir(): string {
  return path.dirname(getAttachTokensPath());
}

async function ensureAttachTokensDir(): Promise<void> {
  const dir = getAttachTokensDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // see pushd-device-tokens.ts for why chmod-after-mkdir is tolerated
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function makeTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function makeTokenId(): string {
  // 8 bytes of entropy for the public revocation id — same posture as
  // pdt_ (device tokens). Public handles don't need bearer-grade
  // entropy but avoid birthday collisions at a few thousand mints.
  return `${TOKEN_ID_PREFIX}${randomBytes(8).toString('hex')}`;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

async function readAttachTokenFile(): Promise<AttachTokenRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(getAttachTokensPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: AttachTokenRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AttachTokenRecord>;
      if (
        typeof parsed.tokenId === 'string' &&
        typeof parsed.tokenHash === 'string' &&
        typeof parsed.parentTokenId === 'string' &&
        typeof parsed.createdAt === 'number' &&
        typeof parsed.lastUsedAt === 'number' &&
        (parsed.boundOrigin === 'loopback' || typeof parsed.boundOrigin === 'string')
      ) {
        records.push({
          tokenId: parsed.tokenId,
          tokenHash: parsed.tokenHash,
          parentTokenId: parsed.parentTokenId,
          boundOrigin: parsed.boundOrigin as BoundOrigin,
          createdAt: parsed.createdAt,
          lastUsedAt: parsed.lastUsedAt,
        });
      }
    } catch {
      // Skip malformed lines, same posture as pushd-device-tokens.ts.
    }
  }
  return records;
}

// Serialize all read-modify-write cycles within this process; the
// CLI mints and the daemon's verify both touch `lastUsedAt`, so they
// race even within a single process.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function writeAttachTokenFileLocked(records: AttachTokenRecord[]): Promise<void> {
  await ensureAttachTokensDir();
  const tokensPath = getAttachTokensPath();
  if (records.length === 0) {
    try {
      await fs.unlink(tokensPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  const tmpPath = `${tokensPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const handle = await fs.open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, tokensPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.chmod(tokensPath, 0o600);
  } catch {
    // see ensureAttachTokensDir
  }
}

/**
 * Mint a new device-attach token bound to `parentTokenId`. The
 * returned `token` is the only time this string is ever exposed.
 * The parent device-token id is recorded so cascade revoke can
 * walk children.
 */
export async function mintDeviceAttachToken(opts: {
  parentTokenId: string;
  boundOrigin: BoundOrigin;
}): Promise<MintAttachTokenResult> {
  if (typeof opts.parentTokenId !== 'string' || !opts.parentTokenId) {
    throw new Error('parentTokenId is required');
  }
  const token = makeTokenSecret();
  const tokenId = makeTokenId();
  const now = Date.now();
  const record: AttachTokenRecord = {
    tokenId,
    tokenHash: hashToken(token),
    parentTokenId: opts.parentTokenId,
    boundOrigin: opts.boundOrigin,
    createdAt: now,
    lastUsedAt: now,
  };
  await serialize(async () => {
    const existing = await readAttachTokenFile();
    existing.push(record);
    await writeAttachTokenFileLocked(existing);
  });
  return { token, tokenId, ttlMs: getAttachTokenTtlMs(), record };
}

/**
 * Verify an attach token bearer. Returns the matching record on
 * success (refreshing its `lastUsedAt` as a side effect) or null
 * if the token is unknown, malformed, or has expired (sliding TTL).
 *
 * Constant-time hash compare avoids leaking which prefix matched.
 */
export async function verifyDeviceAttachToken(
  token: string | null | undefined,
): Promise<AttachTokenRecord | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const candidateHash = hashToken(token);
  const ttlMs = getAttachTokenTtlMs();
  return serialize(async () => {
    const records = await readAttachTokenFile();
    const now = Date.now();
    let match: AttachTokenRecord | null = null;
    let matchIndex = -1;
    for (let i = 0; i < records.length; i++) {
      if (constantTimeStringEqual(records[i].tokenHash, candidateHash)) {
        match = records[i];
        matchIndex = i;
        // No early break — keeps the loop body data-independent.
      }
    }
    if (match === null || matchIndex < 0) return null;
    // Sliding-TTL eviction. A token whose lastUsedAt fell more than
    // ttlMs into the past is treated as nonexistent and pruned from
    // the file on this same read. The eviction is lazy: no
    // background sweep, no separate "expired tokens" view. From the
    // caller's perspective, an expired bearer is indistinguishable
    // from an unknown one (and that's intentional — clients should
    // re-pair when expired, same recovery path as revoked).
    if (now - match.lastUsedAt > ttlMs) {
      records.splice(matchIndex, 1);
      await writeAttachTokenFileLocked(records);
      return null;
    }
    // Refresh lastUsedAt + persist. The constant-time compare above
    // already collapsed all rows we needed to inspect, so writing
    // back here is the natural place.
    records[matchIndex] = { ...match, lastUsedAt: now };
    await writeAttachTokenFileLocked(records);
    return records[matchIndex];
  });
}

/**
 * Revoke a single attach token by its public id. Returns `true` if
 * a record was removed, `false` if no matching id existed (or the
 * record had already expired and been swept).
 */
export async function revokeDeviceAttachToken(tokenId: string): Promise<boolean> {
  if (typeof tokenId !== 'string' || !tokenId.startsWith(TOKEN_ID_PREFIX)) return false;
  return serialize(async () => {
    const records = await readAttachTokenFile();
    const next = records.filter((r) => r.tokenId !== tokenId);
    if (next.length === records.length) return false;
    await writeAttachTokenFileLocked(next);
    return true;
  });
}

/**
 * Revoke every attach token that was minted from `parentTokenId`.
 * Called from the device-token revoke path so cascading is automatic
 * — orphaned attach tokens whose parent device token no longer
 * exists must not stay valid.
 *
 * Returns the list of revoked attach-token ids so the caller can
 * fan out a live-disconnect to their WS connections.
 */
export async function revokeAttachTokensByParent(parentTokenId: string): Promise<string[]> {
  if (typeof parentTokenId !== 'string' || !parentTokenId) return [];
  return serialize(async () => {
    const records = await readAttachTokenFile();
    const removed: string[] = [];
    const next = records.filter((r) => {
      if (r.parentTokenId === parentTokenId) {
        removed.push(r.tokenId);
        return false;
      }
      return true;
    });
    if (removed.length === 0) return [];
    await writeAttachTokenFileLocked(next);
    return removed;
  });
}

/**
 * List all attach-token metadata. The token text is not stored and
 * is never returned. Expired records are filtered out lazily on
 * read so the list reflects what `verify` would currently accept.
 */
export async function listDeviceAttachTokens(): Promise<AttachTokenRecord[]> {
  const records = await readAttachTokenFile();
  const ttlMs = getAttachTokenTtlMs();
  const now = Date.now();
  return records.filter((r) => now - r.lastUsedAt <= ttlMs);
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = {
  hashToken,
  TOKEN_PREFIX,
  TOKEN_ID_PREFIX,
  getAttachTokensPath,
  DEFAULT_TTL_MS,
};
