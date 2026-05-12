/**
 * pushd-device-tokens.ts — Device-token store for the WS pairing flow.
 *
 * Tokens are minted by `push daemon pair` and presented by browser
 * clients in the WS upgrade `Authorization: Bearer <token>` header.
 * The daemon verifies them by SHA-256 + constant-time compare against
 * hashes in ~/.push/run/pushd.tokens (mode 0600, dir mode 0700).
 *
 * Invariants this module enforces:
 *  - The token text is never persisted (only its hash).
 *  - The token text is never returned by any inspection API (only
 *    `mintDeviceToken` ever exposes it, exactly once).
 *  - Error/status messages never include the token text, even in dev.
 *  - The `boundOrigin` is stored as metadata; it is NOT derived from
 *    or embedded in the token text.
 *  - Token-origin binding is immutable; updating an existing token's
 *    origin is intentionally not supported. Revoke + remint instead.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import type { NormalizedOrigin } from './pushd-origin.js';

export type BoundOrigin = 'loopback' | NormalizedOrigin;

export interface DeviceTokenRecord {
  tokenId: string;
  tokenHash: string;
  createdAt: number;
  boundOrigin: BoundOrigin;
  lastUsedAt: number | null;
}

export interface MintResult {
  /** The secret token, formatted as the value to put after `Bearer `. */
  token: string;
  /** Public handle for revocation; safe to print/log. */
  tokenId: string;
  /** The persisted record (no secret). */
  record: DeviceTokenRecord;
}

const TOKEN_PREFIX = 'pushd_';
const TOKEN_ID_PREFIX = 'pdt_';

function getTokensPath(): string {
  if (process.env.PUSHD_TOKENS_PATH) return process.env.PUSHD_TOKENS_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.tokens');
}

function getTokensDir(): string {
  return path.dirname(getTokensPath());
}

async function ensureTokensDir(): Promise<void> {
  const dir = getTokensDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // chmod can fail on platforms without POSIX perms; the recursive
    // mkdir above is best-effort, and the file-level perms below are
    // the real gate.
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function makeTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function makeTokenId(): string {
  return `${TOKEN_ID_PREFIX}${randomBytes(4).toString('hex')}`;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; bail on length first
  // but in O(1) — the length comparison itself is not the timing-leak
  // surface, mismatched-length tokens just shouldn't have happened.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

async function readTokenFile(): Promise<DeviceTokenRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(getTokensPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: DeviceTokenRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<DeviceTokenRecord>;
      if (
        typeof parsed.tokenId === 'string' &&
        typeof parsed.tokenHash === 'string' &&
        typeof parsed.createdAt === 'number' &&
        (parsed.boundOrigin === 'loopback' || typeof parsed.boundOrigin === 'string')
      ) {
        records.push({
          tokenId: parsed.tokenId,
          tokenHash: parsed.tokenHash,
          createdAt: parsed.createdAt,
          boundOrigin: parsed.boundOrigin as BoundOrigin,
          lastUsedAt: typeof parsed.lastUsedAt === 'number' ? parsed.lastUsedAt : null,
        });
      }
    } catch {
      // Skip malformed lines rather than crash the daemon. A corrupted
      // line will surface as "token not found" on the affected device,
      // which the user can fix by re-pairing.
    }
  }
  return records;
}

// Serialize all read-modify-write cycles within this process. Without
// this, a `revoke` that races with a concurrent `touchLastUsed` could
// be lost (both read the same baseline, the touch writes back with the
// revoked record still present). Cross-process races (CLI vs daemon)
// are out of scope for PR 1 — those interleave at human latency.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function writeTokenFileLocked(records: DeviceTokenRecord[]): Promise<void> {
  await ensureTokensDir();
  const tokensPath = getTokensPath();
  // Unique tmp suffix per write — even with the in-process queue,
  // cross-process writers (CLI mint, daemon touch) must not collide
  // on a shared tmp name.
  const tmpPath = `${tokensPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  // Write tmp + rename for atomicity; create with mode 0600 so a reader
  // never sees a wider-permission tmp file mid-write.
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
    // Best-effort cleanup of the unique tmp file if rename failed for
    // any reason — don't leak it next to the real tokens file.
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.chmod(tokensPath, 0o600);
  } catch {
    // see ensureTokensDir
  }
}

/**
 * Mint a new device token bound to `boundOrigin`. The returned `token`
 * is the only time this string is ever exposed; persist it on the
 * client (via the pair UX) immediately.
 */
export async function mintDeviceToken(opts: { boundOrigin: BoundOrigin }): Promise<MintResult> {
  const token = makeTokenSecret();
  const tokenId = makeTokenId();
  const record: DeviceTokenRecord = {
    tokenId,
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    boundOrigin: opts.boundOrigin,
    lastUsedAt: null,
  };
  await serialize(async () => {
    const existing = await readTokenFile();
    existing.push(record);
    await writeTokenFileLocked(existing);
  });
  return { token, tokenId, record };
}

/**
 * Verify a bearer token, returning the matched record or null. Uses
 * constant-time hash compare to avoid leaking which prefix matched.
 *
 * The function never returns or throws strings containing the token
 * text.
 */
export async function verifyDeviceToken(
  token: string | null | undefined,
): Promise<DeviceTokenRecord | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  // Quick syntactic filter — tokens we minted always start with our
  // prefix. A malformed bearer can't match anything in the file.
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const candidateHash = hashToken(token);
  const records = await readTokenFile();
  let match: DeviceTokenRecord | null = null;
  for (const record of records) {
    if (constantTimeStringEqual(record.tokenHash, candidateHash)) {
      match = record;
      // No early break — keeps the inner loop length data-independent.
    }
  }
  return match;
}

/**
 * Revoke a token by its public id. Returns true if a record was
 * removed, false if no matching id existed.
 */
export async function revokeDeviceToken(tokenId: string): Promise<boolean> {
  if (typeof tokenId !== 'string' || !tokenId.startsWith(TOKEN_ID_PREFIX)) return false;
  return serialize(async () => {
    const records = await readTokenFile();
    const next = records.filter((r) => r.tokenId !== tokenId);
    if (next.length === records.length) return false;
    await writeTokenFileLocked(next);
    return true;
  });
}

/**
 * List all device-token metadata. The token text is not stored and is
 * never returned. Safe to print to stdout / a UI.
 */
export async function listDeviceTokens(): Promise<DeviceTokenRecord[]> {
  return readTokenFile();
}

/**
 * Update `lastUsedAt` for a token. Best-effort; failures are
 * swallowed because they shouldn't block a successful WS connection.
 */
export async function touchLastUsed(tokenId: string): Promise<void> {
  try {
    await serialize(async () => {
      const records = await readTokenFile();
      let changed = false;
      for (const r of records) {
        if (r.tokenId === tokenId) {
          r.lastUsedAt = Date.now();
          changed = true;
        }
      }
      if (changed) await writeTokenFileLocked(records);
    });
  } catch {
    // non-fatal
  }
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = {
  hashToken,
  TOKEN_PREFIX,
  TOKEN_ID_PREFIX,
  getTokensPath,
};
