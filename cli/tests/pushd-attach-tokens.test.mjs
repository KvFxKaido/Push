/**
 * pushd-attach-tokens.test.mjs — Coverage for the Phase 3 slice 2
 * device-attach token storage module.
 *
 * Exercises:
 *   - mint exposes the token text exactly once
 *   - verify accepts the secret, rejects unknown/malformed/wrong-prefix
 *   - sliding TTL: verify refreshes lastUsedAt, expired tokens evicted
 *     on next read
 *   - cascade revoke walks every child for a parent device token
 *   - file is mode 0600
 *   - serialized concurrent mints don't lose entries
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mintDeviceAttachToken,
  verifyDeviceAttachToken,
  revokeDeviceAttachToken,
  revokeAttachTokensByParent,
  listDeviceAttachTokens,
  getAttachTokenTtlMs,
  __test__,
} from '../pushd-attach-tokens.ts';

let tmpDir;
let originalTokensEnv;
let originalTtlEnv;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-attach-tokens-test-'));
  originalTokensEnv = process.env.PUSHD_ATTACH_TOKENS_PATH;
  originalTtlEnv = process.env.PUSHD_ATTACH_TOKEN_TTL_MS;
  process.env.PUSHD_ATTACH_TOKENS_PATH = path.join(tmpDir, 'pushd.attach-tokens');
});

afterEach(async () => {
  if (originalTokensEnv === undefined) delete process.env.PUSHD_ATTACH_TOKENS_PATH;
  else process.env.PUSHD_ATTACH_TOKENS_PATH = originalTokensEnv;
  if (originalTtlEnv === undefined) delete process.env.PUSHD_ATTACH_TOKEN_TTL_MS;
  else process.env.PUSHD_ATTACH_TOKEN_TTL_MS = originalTtlEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('mintDeviceAttachToken + verifyDeviceAttachToken', () => {
  it('round-trips a freshly minted token', async () => {
    const { token, tokenId, ttlMs, record } = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    assert.match(token, /^pushd_da_/);
    assert.match(tokenId, /^pdat_/);
    assert.equal(typeof ttlMs, 'number');
    assert.equal(record.parentTokenId, 'pdt_parent_1');
    assert.equal(record.boundOrigin, 'loopback');
    const verified = await verifyDeviceAttachToken(token);
    assert.ok(verified, 'verify accepts the freshly minted token');
    assert.equal(verified.tokenId, tokenId);
    assert.equal(verified.parentTokenId, 'pdt_parent_1');
  });

  it('rejects an unknown token', async () => {
    await mintDeviceAttachToken({ parentTokenId: 'pdt_parent_1', boundOrigin: 'loopback' });
    const result = await verifyDeviceAttachToken('pushd_da_AAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(result, null);
  });

  it('rejects null/empty/wrong-prefix tokens', async () => {
    assert.equal(await verifyDeviceAttachToken(null), null);
    assert.equal(await verifyDeviceAttachToken(''), null);
    assert.equal(await verifyDeviceAttachToken('pushd_AAAAAAAAAA'), null);
    assert.equal(await verifyDeviceAttachToken('not-a-token'), null);
  });

  it('refreshes lastUsedAt on each successful verify (sliding TTL)', async () => {
    const { token, tokenId } = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const before = (await listDeviceAttachTokens()).find((r) => r.tokenId === tokenId);
    assert.ok(before, 'token exists in list pre-verify');
    // Sleep just enough for Date.now to advance, then verify and
    // confirm lastUsedAt moved forward.
    await new Promise((r) => setTimeout(r, 10));
    await verifyDeviceAttachToken(token);
    const after = (await listDeviceAttachTokens()).find((r) => r.tokenId === tokenId);
    assert.ok(after, 'token still present after verify');
    assert.ok(after.lastUsedAt > before.lastUsedAt, 'lastUsedAt advanced');
  });
});

describe('TTL eviction (sliding)', () => {
  it('evicts a record whose lastUsedAt is older than ttlMs and returns null', async () => {
    // Set a tiny TTL so the test can sleep past it without padding.
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = '20';
    const { token, tokenId } = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    // First verify succeeds and refreshes lastUsedAt.
    assert.ok(await verifyDeviceAttachToken(token));
    // Wait past TTL, then verify again — should be evicted.
    await new Promise((r) => setTimeout(r, 50));
    const expired = await verifyDeviceAttachToken(token);
    assert.equal(expired, null, 'expired token should not verify');
    // listDeviceAttachTokens filters expired records too, but the
    // evict happens lazily on verify — list after verify should be
    // empty.
    const list = await listDeviceAttachTokens();
    assert.equal(
      list.some((r) => r.tokenId === tokenId),
      false,
    );
  });

  it('respects the env override on PUSHD_ATTACH_TOKEN_TTL_MS', () => {
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = '12345';
    assert.equal(getAttachTokenTtlMs(), 12345);
  });

  it('falls back to default TTL for invalid env values', () => {
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = 'not-a-number';
    assert.equal(getAttachTokenTtlMs(), __test__.DEFAULT_TTL_MS);
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = '-1';
    assert.equal(getAttachTokenTtlMs(), __test__.DEFAULT_TTL_MS);
  });
});

describe('revokeDeviceAttachToken + revokeAttachTokensByParent', () => {
  it('revokes a single attach token by id', async () => {
    const a = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const removed = await revokeDeviceAttachToken(a.tokenId);
    assert.equal(removed, true);
    assert.equal(await verifyDeviceAttachToken(a.token), null);
  });

  it('returns false when the tokenId does not exist', async () => {
    assert.equal(await revokeDeviceAttachToken('pdat_does_not_exist'), false);
  });

  it('returns false for malformed token ids (wrong prefix)', async () => {
    assert.equal(await revokeDeviceAttachToken('something_weird'), false);
    assert.equal(await revokeDeviceAttachToken(''), false);
  });

  it('cascade-revokes every attach token sharing a parentTokenId', async () => {
    const a = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const b = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const c = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_2',
      boundOrigin: 'loopback',
    });
    const revokedIds = await revokeAttachTokensByParent('pdt_parent_1');
    assert.equal(revokedIds.length, 2);
    assert.ok(revokedIds.includes(a.tokenId));
    assert.ok(revokedIds.includes(b.tokenId));
    // Attach token for pdt_parent_2 must NOT be touched.
    assert.ok(await verifyDeviceAttachToken(c.token));
    // The revoked ones must be gone.
    assert.equal(await verifyDeviceAttachToken(a.token), null);
    assert.equal(await verifyDeviceAttachToken(b.token), null);
  });

  it('returns an empty list when no children exist for the parent', async () => {
    const revokedIds = await revokeAttachTokensByParent('pdt_does_not_exist');
    assert.deepEqual(revokedIds, []);
  });
});

describe('listDeviceAttachTokens', () => {
  it('returns persisted records (filtered to non-expired)', async () => {
    const a = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const list = await listDeviceAttachTokens();
    assert.equal(
      list.some((r) => r.tokenId === a.tokenId),
      true,
    );
  });

  it('hides records older than the TTL', async () => {
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = '20';
    const a = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    await new Promise((r) => setTimeout(r, 50));
    const list = await listDeviceAttachTokens();
    assert.equal(
      list.some((r) => r.tokenId === a.tokenId),
      false,
    );
  });
});

describe('file permissions + concurrency', () => {
  it('persists with mode 0600', async () => {
    await mintDeviceAttachToken({ parentTokenId: 'pdt_parent_1', boundOrigin: 'loopback' });
    const stat = await fs.stat(process.env.PUSHD_ATTACH_TOKENS_PATH);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('serializes concurrent mints without losing entries', async () => {
    const parents = ['pdt_a', 'pdt_b', 'pdt_c', 'pdt_d', 'pdt_e'];
    const results = await Promise.all(
      parents.map((parent) =>
        mintDeviceAttachToken({ parentTokenId: parent, boundOrigin: 'loopback' }),
      ),
    );
    const list = await listDeviceAttachTokens();
    assert.equal(list.length, parents.length);
    const persisted = list.map((r) => r.tokenId).sort();
    const minted = results.map((r) => r.tokenId).sort();
    assert.deepEqual(persisted, minted);
  });
});
