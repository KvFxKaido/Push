/**
 * Characterization tests for the file-backed `VerbatimLog`
 * (LCM Phase 3, CLI durable backend).
 *
 * Pins:
 *   - append/read round-trips the exact original text, untruncated.
 *   - Idempotent on identical (scope, text); distinct texts never share a ref.
 *   - File layout: `<baseDir>/<repo>/<branch>.verbatim.jsonl` (or
 *     `__no_branch.verbatim.jsonl`).
 *   - listByScope soft-matches and orders newest-first.
 *   - pruneOlderThan drops aged entries; survives restart (records persist).
 *   - Malformed JSON lines (a crashed append) are skipped, not fatal.
 *   - Append-only: there is no update/remove of historical entries.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFileVerbatimLog } from '../verbatim-log-file-store.ts';

let baseDir;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-verbatim-'));
});

after(async () => {
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
  await fs.mkdir(baseDir, { recursive: true });
});

const repo = 'owner/repo';

describe('file-backed VerbatimLog', () => {
  it('round-trips the exact original text, untruncated, across a fresh log instance', async () => {
    const log = createFileVerbatimLog({ baseDir });
    const huge = 'x'.repeat(50_000) + '\n  indented\ttab line that must survive';
    const entry = await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: huge });

    // New instance = simulated restart; the durable bytes are still there.
    const reopened = createFileVerbatimLog({ baseDir });
    const read = await reopened.read(entry.ref);
    assert.equal(read?.text, huge);
    assert.equal(read?.byteLen, huge.length);
  });

  it('writes to <repo>/<branch>.verbatim.jsonl and __no_branch for unscoped', async () => {
    const log = createFileVerbatimLog({ baseDir });
    await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: 'on main' });
    await log.append({ scope: { repoFullName: repo }, text: 'no branch' });

    const branchFile = path.join(baseDir, repo, 'main.verbatim.jsonl');
    const noBranchFile = path.join(baseDir, repo, '__no_branch.verbatim.jsonl');
    assert.ok((await fs.readFile(branchFile, 'utf8')).includes('on main'));
    assert.ok((await fs.readFile(noBranchFile, 'utf8')).includes('no branch'));
  });

  it('dedups identical (scope, text) and never shares a ref across distinct texts', async () => {
    const log = createFileVerbatimLog({ baseDir });
    const scope = { repoFullName: repo, branch: 'main' };
    const a = await log.append({ scope, text: 'same' });
    const b = await log.append({ scope, text: 'same' });
    const c = await log.append({ scope, text: 'different' });

    assert.equal(b.ref, a.ref);
    assert.notEqual(c.ref, a.ref);
    assert.equal(await log.size(), 2);
  });

  it('keeps refs globally unique across scope files so read(ref) is unambiguous', async () => {
    const log = createFileVerbatimLog({ baseDir });
    // Two distinct texts in two different scope files. Even if their base refs
    // ever collided, the global probe must hand out distinct refs so read(ref)
    // can never return the wrong scope's bytes.
    const a = await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: 'alpha' });
    const b = await log.append({ scope: { repoFullName: repo, branch: 'feat' }, text: 'beta' });

    assert.notEqual(a.ref, b.ref);
    assert.equal((await log.read(a.ref))?.text, 'alpha');
    assert.equal((await log.read(b.ref))?.text, 'beta');
  });

  it('listByScope soft-matches and orders newest-first', async () => {
    const log = createFileVerbatimLog({ baseDir });
    await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: 'm', now: 1 });
    await log.append({ scope: { repoFullName: repo, branch: 'feat' }, text: 'f', now: 2 });
    await log.append({ scope: { repoFullName: 'other/repo' }, text: 'o', now: 3 });

    const repoOnly = await log.listByScope({ repoFullName: repo });
    assert.deepEqual(
      repoOnly.map((e) => e.text),
      ['f', 'm'],
    );
    const mainOnly = await log.listByScope({ repoFullName: repo, branch: 'main' });
    assert.deepEqual(
      mainOnly.map((e) => e.text),
      ['m'],
    );
  });

  it('prunes entries older than a cutoff via atomic rewrite', async () => {
    const log = createFileVerbatimLog({ baseDir });
    const scope = { repoFullName: repo, branch: 'main' };
    await log.append({ scope, text: 'old', now: 100 });
    await log.append({ scope, text: 'new', now: 200 });

    const removed = await log.pruneOlderThan(150);
    assert.equal(removed, 1);
    assert.equal(await log.size(), 1);
    const remaining = await log.listByScope(scope);
    assert.equal(remaining[0]?.text, 'new');
  });

  it('skips malformed JSON lines rather than failing the read', async () => {
    const log = createFileVerbatimLog({ baseDir });
    const entry = await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: 'good' });
    const file = path.join(baseDir, repo, 'main.verbatim.jsonl');
    await fs.appendFile(file, '{ this is not valid json\n', 'utf8');

    assert.equal((await log.read(entry.ref))?.text, 'good');
    assert.equal(await log.size(), 1);
  });

  it('rejects path-traversal in repoFullName', async () => {
    const log = createFileVerbatimLog({ baseDir });
    await assert.rejects(
      () => Promise.resolve(log.append({ scope: { repoFullName: '../evil' }, text: 'x' })),
      /must not contain|escapes baseDir|relative path/,
    );
  });
});
