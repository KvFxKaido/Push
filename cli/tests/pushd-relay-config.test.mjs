/**
 * Tests for `cli/pushd-relay-config.ts` + `pushd-relay-allowlist.ts`
 * (Phase 2.e).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readRelayConfig,
  writeRelayConfig,
  deleteRelayConfig,
  __test__,
} from '../pushd-relay-config.ts';
import { createRelayAllowlistRegistry } from '../pushd-relay-allowlist.ts';

let tmpDir;
const originalEnv = process.env.PUSHD_RELAY_CONFIG_PATH;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-relay-config-'));
  process.env.PUSHD_RELAY_CONFIG_PATH = path.join(tmpDir, 'pushd.relay.json');
});

after(async () => {
  if (originalEnv === undefined) delete process.env.PUSHD_RELAY_CONFIG_PATH;
  else process.env.PUSHD_RELAY_CONFIG_PATH = originalEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(process.env.PUSHD_RELAY_CONFIG_PATH, { force: true });
});

describe('pushd-relay-config', () => {
  it('returns null when no config exists', async () => {
    assert.equal(await readRelayConfig(), null);
  });

  it('roundtrips deploymentUrl + token + enabledAt', async () => {
    const token = `${__test__.TOKEN_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const written = await writeRelayConfig({
      deploymentUrl: 'https://worker.example/api',
      token,
    });
    assert.equal(written.deploymentUrl, 'https://worker.example/api');
    assert.equal(written.token, token);
    assert.equal(typeof written.enabledAt, 'number');
    const read = await readRelayConfig();
    assert.deepEqual(read, written);
  });

  it('rejects tokens without the pushd_relay_ prefix', async () => {
    await assert.rejects(
      () => writeRelayConfig({ deploymentUrl: 'https://x.example', token: 'not_prefixed_xxxx' }),
      /pushd_relay_/,
    );
  });

  it('writes the file with mode 0600', async () => {
    if (process.platform === 'win32') return; // POSIX-only assertion
    await writeRelayConfig({
      deploymentUrl: 'https://w.example',
      token: `${__test__.TOKEN_PREFIX}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    });
    const stat = await fs.stat(__test__.getRelayConfigPath());
    // Mask off the file-type bits and assert the perm bits are 0600.
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('returns null on malformed JSON without throwing', async () => {
    await fs.writeFile(__test__.getRelayConfigPath(), '{ not json', { mode: 0o600 });
    assert.equal(await readRelayConfig(), null);
  });

  it('returns null when token prefix is wrong even if JSON is valid', async () => {
    await fs.writeFile(
      __test__.getRelayConfigPath(),
      JSON.stringify({ deploymentUrl: 'https://x.example', token: 'wrong_prefix', enabledAt: 1 }),
      { mode: 0o600 },
    );
    assert.equal(await readRelayConfig(), null);
  });

  it('deleteRelayConfig is idempotent', async () => {
    await writeRelayConfig({
      deploymentUrl: 'https://x.example',
      token: `${__test__.TOKEN_PREFIX}cccccccccccccccccccccccccccccccc`,
    });
    assert.equal(await deleteRelayConfig(), true);
    assert.equal(await deleteRelayConfig(), false);
    assert.equal(await readRelayConfig(), null);
  });
});

describe('pushd-relay-allowlist', () => {
  it('add / remove / allBearers roundtrip', () => {
    const reg = createRelayAllowlistRegistry();
    reg.add('pdat_a', 'pushd_da_aaa');
    reg.add('pdat_b', 'pushd_da_bbb');
    assert.deepEqual(reg.allBearers(), ['pushd_da_aaa', 'pushd_da_bbb']);
    assert.equal(reg.size(), 2);
    assert.equal(reg.remove('pdat_a'), 'pushd_da_aaa');
    assert.equal(reg.remove('pdat_a'), null);
    assert.deepEqual(reg.allBearers(), ['pushd_da_bbb']);
  });

  it('removeMany returns only the bearers that were registered', () => {
    const reg = createRelayAllowlistRegistry();
    reg.add('pdat_a', 'pushd_da_aaa');
    reg.add('pdat_b', 'pushd_da_bbb');
    const removed = reg.removeMany(['pdat_a', 'pdat_missing', 'pdat_b']);
    assert.deepEqual(removed.sort(), ['pushd_da_aaa', 'pushd_da_bbb']);
    assert.equal(reg.size(), 0);
  });

  it('rejects empty tokenId / bearer', () => {
    const reg = createRelayAllowlistRegistry();
    reg.add('', 'pushd_da_aaa');
    reg.add('pdat_a', '');
    assert.equal(reg.size(), 0);
  });
});
