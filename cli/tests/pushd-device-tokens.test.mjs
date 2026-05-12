import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  mintDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  listDeviceTokens,
  touchLastUsed,
  __test__,
} from '../pushd-device-tokens.ts';

let tmpDir;
let tokensPath;
const originalEnv = process.env.PUSHD_TOKENS_PATH;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-tokens-'));
  tokensPath = path.join(tmpDir, 'pushd.tokens');
  process.env.PUSHD_TOKENS_PATH = tokensPath;
});

after(async () => {
  if (originalEnv === undefined) delete process.env.PUSHD_TOKENS_PATH;
  else process.env.PUSHD_TOKENS_PATH = originalEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(tokensPath, { force: true });
});

describe('mintDeviceToken', () => {
  it('returns a token, tokenId, and persisted record', async () => {
    const result = await mintDeviceToken({ boundOrigin: 'loopback' });
    assert.ok(result.token.startsWith(__test__.TOKEN_PREFIX), 'token has expected prefix');
    assert.ok(result.tokenId.startsWith(__test__.TOKEN_ID_PREFIX), 'id has expected prefix');
    assert.equal(result.record.boundOrigin, 'loopback');
    assert.equal(result.record.lastUsedAt, null);
    assert.ok(result.record.createdAt > 0);
  });

  it('does NOT persist the token text — only the hash', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const fileContent = await fs.readFile(tokensPath, 'utf8');
    assert.ok(!fileContent.includes(token), 'token text must not appear on disk');
  });

  it('stores boundOrigin verbatim for non-loopback bindings', async () => {
    const origin = 'https://push.zen-dev.com';
    const { record } = await mintDeviceToken({ boundOrigin: origin });
    assert.equal(record.boundOrigin, origin);
  });

  it('writes the tokens file with mode 0600', async () => {
    await mintDeviceToken({ boundOrigin: 'loopback' });
    const stat = await fs.stat(tokensPath);
    // Mask to mode bits; we only assert the 0o077 group/other bits are zero.
    const groupOtherBits = stat.mode & 0o077;
    assert.equal(
      groupOtherBits,
      0,
      `file should not be group/other-readable; got ${stat.mode.toString(8)}`,
    );
  });

  it('each mint generates a fresh token and id', async () => {
    const a = await mintDeviceToken({ boundOrigin: 'loopback' });
    const b = await mintDeviceToken({ boundOrigin: 'loopback' });
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.tokenId, b.tokenId);
  });
});

describe('verifyDeviceToken', () => {
  it('returns the record for a freshly minted token', async () => {
    const { token, tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const record = await verifyDeviceToken(token);
    assert.ok(record);
    assert.equal(record.tokenId, tokenId);
    assert.equal(record.boundOrigin, 'loopback');
  });

  it('returns null for unknown tokens', async () => {
    await mintDeviceToken({ boundOrigin: 'loopback' });
    const fake = `${__test__.TOKEN_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const record = await verifyDeviceToken(fake);
    assert.equal(record, null);
  });

  it('returns null for null/undefined/empty input', async () => {
    assert.equal(await verifyDeviceToken(null), null);
    assert.equal(await verifyDeviceToken(undefined), null);
    assert.equal(await verifyDeviceToken(''), null);
  });

  it('returns null for tokens without our prefix', async () => {
    await mintDeviceToken({ boundOrigin: 'loopback' });
    assert.equal(await verifyDeviceToken('Bearer something'), null);
    assert.equal(await verifyDeviceToken('att_1234567890abcdef'), null);
  });

  it('verifies multiple tokens independently', async () => {
    const a = await mintDeviceToken({ boundOrigin: 'loopback' });
    const b = await mintDeviceToken({ boundOrigin: 'https://push.zen-dev.com' });
    const recordA = await verifyDeviceToken(a.token);
    const recordB = await verifyDeviceToken(b.token);
    assert.equal(recordA.tokenId, a.tokenId);
    assert.equal(recordB.tokenId, b.tokenId);
    assert.equal(recordB.boundOrigin, 'https://push.zen-dev.com');
  });
});

describe('revokeDeviceToken', () => {
  it('removes the token from the file', async () => {
    const { token, tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const removed = await revokeDeviceToken(tokenId);
    assert.equal(removed, true);
    assert.equal(await verifyDeviceToken(token), null);
  });

  it('returns false for unknown tokenId', async () => {
    await mintDeviceToken({ boundOrigin: 'loopback' });
    assert.equal(await revokeDeviceToken('pdt_doesnotexist'), false);
  });

  it('rejects ids without the expected prefix', async () => {
    await mintDeviceToken({ boundOrigin: 'loopback' });
    assert.equal(await revokeDeviceToken('something_weird'), false);
  });

  it('does not affect other tokens', async () => {
    const a = await mintDeviceToken({ boundOrigin: 'loopback' });
    const b = await mintDeviceToken({ boundOrigin: 'loopback' });
    await revokeDeviceToken(a.tokenId);
    const recordB = await verifyDeviceToken(b.token);
    assert.ok(recordB);
    assert.equal(recordB.tokenId, b.tokenId);
  });
});

describe('listDeviceTokens', () => {
  it('returns metadata for all current tokens, never the secret', async () => {
    const a = await mintDeviceToken({ boundOrigin: 'loopback' });
    const b = await mintDeviceToken({ boundOrigin: 'https://push.zen-dev.com' });
    const records = await listDeviceTokens();
    const ids = records.map((r) => r.tokenId).sort();
    assert.deepEqual(ids, [a.tokenId, b.tokenId].sort());
    // No record carries the bearer in any field.
    for (const r of records) {
      assert.ok(!Object.values(r).some((v) => typeof v === 'string' && v === a.token));
      assert.ok(!Object.values(r).some((v) => typeof v === 'string' && v === b.token));
    }
  });

  it('returns empty array when no tokens exist', async () => {
    const records = await listDeviceTokens();
    assert.deepEqual(records, []);
  });
});

describe('concurrent write serialization', () => {
  it('parallel mint+touch+revoke never throws and preserves invariants', async () => {
    // Reproduces the race the first CI run hit: two writers using the
    // same tmp filename + interleaved read-modify-write. Without
    // serialization + unique tmp names, this throws ENOENT and/or
    // loses revocations.
    const seed = await mintDeviceToken({ boundOrigin: 'loopback' });

    const ops = [];
    for (let i = 0; i < 20; i++) {
      ops.push(mintDeviceToken({ boundOrigin: 'loopback' }));
      ops.push(touchLastUsed(seed.tokenId));
    }
    const results = await Promise.all(ops);
    const minted = results.filter((r) => r && typeof r === 'object' && 'tokenId' in r);
    assert.equal(minted.length, 20);

    // Revoke one of the minted tokens while more touches race. Revoke
    // must stick — that's the security-relevant invariant.
    const target = minted[10];
    const [revoked] = await Promise.all([
      revokeDeviceToken(target.tokenId),
      touchLastUsed(seed.tokenId),
      touchLastUsed(target.tokenId),
      touchLastUsed(seed.tokenId),
    ]);
    assert.equal(revoked, true);

    const after = await listDeviceTokens();
    assert.equal(
      after.find((r) => r.tokenId === target.tokenId),
      undefined,
      'revoked token must not reappear after a racing touch',
    );
    assert.equal(after.length, 20);
  });
});

describe('touchLastUsed', () => {
  it('updates lastUsedAt for an existing token', async () => {
    const { tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const before = (await listDeviceTokens())[0];
    assert.equal(before.lastUsedAt, null);

    await touchLastUsed(tokenId);
    const after = (await listDeviceTokens())[0];
    assert.ok(typeof after.lastUsedAt === 'number');
  });

  it('is a no-op for unknown tokenId', async () => {
    const { tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    await touchLastUsed('pdt_missing');
    const after = (await listDeviceTokens())[0];
    assert.equal(after.tokenId, tokenId);
    assert.equal(after.lastUsedAt, null);
  });
});
