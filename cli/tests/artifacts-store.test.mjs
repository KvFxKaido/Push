/**
 * Roundtrip tests for the CLI flat-JSON artifact store.
 *
 * Each test runs against a fresh `PUSH_ARTIFACTS_DIR` under an OS
 * tempdir so they don't pollute the user's `~/.push/artifacts/` and
 * can run in parallel without colliding.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { CliFlatJsonArtifactStore } from '../artifacts-store.ts';

let tempRoot;
let previousEnv;

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-artifacts-test-'));
  previousEnv = process.env.PUSH_ARTIFACTS_DIR;
  process.env.PUSH_ARTIFACTS_DIR = tempRoot;
});

after(async () => {
  if (previousEnv === undefined) delete process.env.PUSH_ARTIFACTS_DIR;
  else process.env.PUSH_ARTIFACTS_DIR = previousEnv;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean root between tests so file listings are deterministic.
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
});

const SCOPE = { repoFullName: 'acme/widgets', branch: 'main', chatId: 'chat_1' };
const CLI_SCOPE = { repoFullName: 'acme/widgets', branch: 'feat/x' };

function makeMermaid({
  id = `art_${randomBytes(4).toString('hex')}`,
  updatedAt = Date.now(),
} = {}) {
  return {
    id,
    scope: SCOPE,
    author: {
      surface: 'cli',
      role: 'orchestrator',
      runId: 'run_test',
      createdAt: updatedAt,
    },
    title: `Artifact ${id}`,
    status: 'ready',
    updatedAt,
    kind: 'mermaid',
    source: 'graph TD; A-->B',
  };
}

describe('CliFlatJsonArtifactStore', () => {
  it('roundtrips put → get for a single artifact', async () => {
    const store = new CliFlatJsonArtifactStore();
    const record = makeMermaid({ id: 'art_one' });

    await store.put(record);
    const loaded = await store.get(SCOPE, 'art_one');

    assert.deepEqual(loaded, record);
  });

  it('returns null for a missing artifact', async () => {
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(SCOPE, 'art_missing');
    assert.equal(loaded, null);
  });

  it('lists artifacts newest-first', async () => {
    const store = new CliFlatJsonArtifactStore();
    await store.put(makeMermaid({ id: 'art_a', updatedAt: 1000 }));
    await store.put(makeMermaid({ id: 'art_b', updatedAt: 3000 }));
    await store.put(makeMermaid({ id: 'art_c', updatedAt: 2000 }));

    const list = await store.list({ scope: SCOPE });
    assert.deepEqual(
      list.map((r) => r.id),
      ['art_b', 'art_c', 'art_a'],
    );
  });

  it('respects the limit on list', async () => {
    const store = new CliFlatJsonArtifactStore();
    for (let i = 0; i < 5; i++) {
      await store.put(makeMermaid({ id: `art_${i}`, updatedAt: 1000 + i }));
    }
    const list = await store.list({ scope: SCOPE, limit: 2 });
    assert.equal(list.length, 2);
  });

  it('returns an empty list when the scope directory does not exist', async () => {
    const store = new CliFlatJsonArtifactStore();
    const list = await store.list({ scope: { repoFullName: 'unknown/repo', branch: null } });
    assert.deepEqual(list, []);
  });

  it('files CLI-shape scopes (no chatId) under a separate directory than chat scopes', async () => {
    const store = new CliFlatJsonArtifactStore();
    const cliRecord = { ...makeMermaid({ id: 'art_cli' }), scope: CLI_SCOPE };
    const webRecord = makeMermaid({ id: 'art_web' });

    await store.put(cliRecord);
    await store.put(webRecord);

    const cliList = await store.list({ scope: CLI_SCOPE });
    const webList = await store.list({ scope: SCOPE });

    assert.deepEqual(
      cliList.map((r) => r.id),
      ['art_cli'],
    );
    assert.deepEqual(
      webList.map((r) => r.id),
      ['art_web'],
    );
  });

  it('delete is a no-op for missing artifacts', async () => {
    const store = new CliFlatJsonArtifactStore();
    // Should not throw.
    await store.delete(SCOPE, 'art_missing');
  });

  it('delete removes a previously put artifact', async () => {
    const store = new CliFlatJsonArtifactStore();
    const record = makeMermaid({ id: 'art_kill' });
    await store.put(record);
    await store.delete(SCOPE, 'art_kill');
    assert.equal(await store.get(SCOPE, 'art_kill'), null);
  });

  it('throws on a corrupt artifact file rather than swallowing it', async () => {
    const store = new CliFlatJsonArtifactStore();
    // Persist a real artifact so the scope directory exists.
    await store.put(makeMermaid({ id: 'art_ok' }));
    // Then drop a malformed file in the same directory.
    const list = await store.list({ scope: SCOPE });
    const okFilePath = path.join(
      tempRoot,
      // Re-derive the scope directory deterministically from the existing
      // listing rather than re-implementing scopeDirName here.
      (await fs.readdir(tempRoot))[0],
      'art_corrupt.json',
    );
    void list;
    await fs.writeFile(okFilePath, '{ not valid json', 'utf8');

    await assert.rejects(() => store.list({ scope: SCOPE }), /Corrupt artifact file/);
  });
});
