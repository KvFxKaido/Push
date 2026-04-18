/**
 * Characterization tests for the file-backed `ContextMemoryStore`
 * (Gap 3 Step 3, Commit 1).
 *
 * Pins:
 *   - All `ContextMemoryStore` interface methods behave correctly
 *     against a fresh tmpdir.
 *   - File layout: records land in
 *     `<baseDir>/<repoFullName>/<branch>.jsonl` (or
 *     `<baseDir>/<repoFullName>/__no_branch.jsonl` for records without
 *     a branch).
 *   - Scope-based deletion (clearByRepo, clearByBranch) preserves
 *     out-of-scope records.
 *   - pruneExpired honors the per-kind TTLs defined in
 *     `lib/memory-persistence-policy.ts`.
 *   - Serialization: concurrent writes to the same file don't
 *     interleave and lose data.
 *   - Malformed JSON lines (from a hypothetical crashed write) are
 *     skipped rather than failing the whole read.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFileMemoryStore } from '../context-memory-file-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let baseDir;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-memstore-'));
});

after(async () => {
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean slate between tests. Rebuild the directory rather than
  // reusing the mkdtemp result across tests so each test sees an
  // empty baseDir.
  await fs.rm(baseDir, { recursive: true, force: true });
  await fs.mkdir(baseDir, { recursive: true });
});

let recordCounter = 0;

function makeRecord(overrides = {}) {
  recordCounter++;
  return {
    id: `rec-${recordCounter}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'finding',
    summary: 'Test summary',
    scope: { repoFullName: 'owner/repo', branch: 'main' },
    source: { kind: 'explorer', label: 'Test source', createdAt: Date.now() },
    freshness: 'fresh',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic write + read round-trip
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — basic write + read', () => {
  it('round-trips a single record through write + get', async () => {
    const store = createFileMemoryStore({ baseDir });
    const record = makeRecord({ summary: 'round-trip sentinel' });

    await store.write(record);
    const retrieved = await store.get(record.id);

    assert.equal(retrieved?.id, record.id);
    assert.equal(retrieved?.summary, 'round-trip sentinel');
  });

  it('returns undefined for a get on an unknown id', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.write(makeRecord());
    const retrieved = await store.get('does-not-exist');
    assert.equal(retrieved, undefined);
  });

  it('list returns every written record', async () => {
    const store = createFileMemoryStore({ baseDir });
    const r1 = makeRecord();
    const r2 = makeRecord();
    const r3 = makeRecord();
    await store.writeMany([r1, r2, r3]);

    const all = await store.list();
    const ids = all.map((r) => r.id).sort();
    assert.deepEqual(ids, [r1.id, r2.id, r3.id].sort());
  });

  it('list applies the predicate', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.write(makeRecord({ kind: 'finding' }));
    await store.write(makeRecord({ kind: 'task_outcome' }));
    await store.write(makeRecord({ kind: 'finding' }));

    const findings = await store.list((r) => r.kind === 'finding');
    assert.equal(findings.length, 2);
    assert.ok(findings.every((r) => r.kind === 'finding'));
  });

  it('size reflects the number of stored records', async () => {
    const store = createFileMemoryStore({ baseDir });
    assert.equal(await store.size(), 0);
    await store.write(makeRecord());
    await store.write(makeRecord());
    assert.equal(await store.size(), 2);
  });

  it('works against a baseDir that does not exist yet', async () => {
    const fresh = path.join(baseDir, 'nested', 'does-not-yet-exist');
    const store = createFileMemoryStore({ baseDir: fresh });
    // All read ops should return empty / undefined without throwing.
    assert.equal(await store.size(), 0);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('anything'), undefined);
    // First write creates the directory.
    const record = makeRecord();
    await store.write(record);
    assert.equal(await store.size(), 1);
    const retrieved = await store.get(record.id);
    assert.equal(retrieved?.id, record.id);
  });
});

// ---------------------------------------------------------------------------
// File layout
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — on-disk file layout', () => {
  it('writes branch-scoped records to <repo>/<branch>.jsonl', async () => {
    const store = createFileMemoryStore({ baseDir });
    const record = makeRecord({ scope: { repoFullName: 'owner/repo', branch: 'main' } });
    await store.write(record);

    const expected = path.join(baseDir, 'owner', 'repo', 'main.jsonl');
    const text = await fs.readFile(expected, 'utf8');
    assert.ok(text.includes(record.id));
    assert.ok(text.endsWith('\n'), 'JSONL file should end with a newline');
  });

  it('writes records without a branch to <repo>/__no_branch.jsonl', async () => {
    const store = createFileMemoryStore({ baseDir });
    const record = makeRecord({ scope: { repoFullName: 'owner/repo' } });
    await store.write(record);

    const expected = path.join(baseDir, 'owner', 'repo', '__no_branch.jsonl');
    const text = await fs.readFile(expected, 'utf8');
    assert.ok(text.includes(record.id));
  });

  it('separates records from different branches into different files', async () => {
    const store = createFileMemoryStore({ baseDir });
    const mainRecord = makeRecord({ scope: { repoFullName: 'owner/repo', branch: 'main' } });
    const featRecord = makeRecord({ scope: { repoFullName: 'owner/repo', branch: 'feat-x' } });
    await store.writeMany([mainRecord, featRecord]);

    const mainText = await fs.readFile(path.join(baseDir, 'owner', 'repo', 'main.jsonl'), 'utf8');
    const featText = await fs.readFile(path.join(baseDir, 'owner', 'repo', 'feat-x.jsonl'), 'utf8');
    assert.ok(mainText.includes(mainRecord.id));
    assert.ok(!mainText.includes(featRecord.id));
    assert.ok(featText.includes(featRecord.id));
    assert.ok(!featText.includes(mainRecord.id));
  });

  it('separates records from different repos into different directories', async () => {
    const store = createFileMemoryStore({ baseDir });
    const r1 = makeRecord({ scope: { repoFullName: 'alpha/one', branch: 'main' } });
    const r2 = makeRecord({ scope: { repoFullName: 'beta/two', branch: 'main' } });
    await store.writeMany([r1, r2]);

    const alphaDir = await fs.readdir(path.join(baseDir, 'alpha', 'one'));
    const betaDir = await fs.readdir(path.join(baseDir, 'beta', 'two'));
    assert.deepEqual(alphaDir, ['main.jsonl']);
    assert.deepEqual(betaDir, ['main.jsonl']);
  });
});

// ---------------------------------------------------------------------------
// Update + remove
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — update', () => {
  it('merges a partial patch and returns the merged record', async () => {
    const store = createFileMemoryStore({ baseDir });
    const record = makeRecord({ summary: 'original', detail: 'd1' });
    await store.write(record);

    const merged = await store.update(record.id, { summary: 'updated' });

    assert.equal(merged?.summary, 'updated');
    assert.equal(merged?.detail, 'd1', 'fields not in the patch must be preserved');
    const fromStore = await store.get(record.id);
    assert.equal(fromStore?.summary, 'updated');
    assert.equal(fromStore?.detail, 'd1');
  });

  it('returns undefined when updating an unknown id', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.write(makeRecord());
    const result = await store.update('does-not-exist', { summary: 'x' });
    assert.equal(result, undefined);
  });

  it('does not duplicate the record after update (file still has one line per id)', async () => {
    const store = createFileMemoryStore({ baseDir });
    const record = makeRecord();
    await store.write(record);
    await store.update(record.id, { summary: 'patched-1' });
    await store.update(record.id, { summary: 'patched-2' });

    const all = await store.list();
    assert.equal(all.filter((r) => r.id === record.id).length, 1);
    assert.equal(all.find((r) => r.id === record.id)?.summary, 'patched-2');
  });
});

describe('createFileMemoryStore — remove', () => {
  it('removes a single record and leaves others alone', async () => {
    const store = createFileMemoryStore({ baseDir });
    const keeper = makeRecord();
    const target = makeRecord();
    await store.writeMany([keeper, target]);

    await store.remove(target.id);

    assert.equal(await store.get(target.id), undefined);
    assert.equal((await store.get(keeper.id))?.id, keeper.id);
    assert.equal(await store.size(), 1);
  });

  it('is a no-op when the id is not present', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.write(makeRecord());
    await store.remove('does-not-exist');
    assert.equal(await store.size(), 1);
  });
});

// ---------------------------------------------------------------------------
// Scope-based deletion
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — scope-based deletion', () => {
  it('clear removes every record from every repo', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.writeMany([
      makeRecord({ scope: { repoFullName: 'alpha/one', branch: 'main' } }),
      makeRecord({ scope: { repoFullName: 'beta/two', branch: 'main' } }),
      makeRecord({ scope: { repoFullName: 'alpha/one' } }),
    ]);
    assert.equal(await store.size(), 3);

    await store.clear();
    assert.equal(await store.size(), 0);
  });

  it('clearByRepo removes only records in the named repo', async () => {
    const store = createFileMemoryStore({ baseDir });
    const alpha = makeRecord({ scope: { repoFullName: 'alpha/one', branch: 'main' } });
    const beta = makeRecord({ scope: { repoFullName: 'beta/two', branch: 'main' } });
    await store.writeMany([alpha, beta]);

    await store.clearByRepo('alpha/one');

    assert.equal(await store.get(alpha.id), undefined);
    assert.equal((await store.get(beta.id))?.id, beta.id);
  });

  it('clearByBranch removes only records in the named (repo, branch) pair', async () => {
    const store = createFileMemoryStore({ baseDir });
    const mainRec = makeRecord({ scope: { repoFullName: 'owner/repo', branch: 'main' } });
    const featRec = makeRecord({ scope: { repoFullName: 'owner/repo', branch: 'feat' } });
    const noBranchRec = makeRecord({ scope: { repoFullName: 'owner/repo' } });
    await store.writeMany([mainRec, featRec, noBranchRec]);

    await store.clearByBranch('owner/repo', 'main');

    assert.equal(await store.get(mainRec.id), undefined);
    assert.equal((await store.get(featRec.id))?.id, featRec.id);
    assert.equal((await store.get(noBranchRec.id))?.id, noBranchRec.id);
  });

  it('clearByRepo / clearByBranch are no-ops when the target does not exist', async () => {
    const store = createFileMemoryStore({ baseDir });
    await store.write(makeRecord());
    // Should not throw.
    await store.clearByRepo('nope/nope');
    await store.clearByBranch('nope/nope', 'nope');
    assert.equal(await store.size(), 1);
  });
});

// ---------------------------------------------------------------------------
// pruneExpired honors lib/memory-persistence-policy TTLs
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — pruneExpired', () => {
  it('removes records whose createdAt is past the kind TTL', async () => {
    const store = createFileMemoryStore({ baseDir });
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const freshFinding = makeRecord({
      kind: 'finding',
      source: { kind: 'explorer', label: 'fresh finding', createdAt: now - 1_000 },
    });
    const expiredFinding = makeRecord({
      // finding ttl is 30 days; push createdAt 40 days back so it's expired
      kind: 'finding',
      source: { kind: 'explorer', label: 'old finding', createdAt: now - thirtyDaysMs * 1.5 },
    });
    const freshOutcome = makeRecord({
      kind: 'task_outcome',
      source: { kind: 'coder', label: 'recent outcome', createdAt: now - 1_000 },
    });
    const expiredOutcome = makeRecord({
      // task_outcome ttl is 7 days; push createdAt 10 days back
      kind: 'task_outcome',
      source: { kind: 'coder', label: 'old outcome', createdAt: now - sevenDaysMs * 1.5 },
    });

    await store.writeMany([freshFinding, expiredFinding, freshOutcome, expiredOutcome]);

    const removed = await store.pruneExpired(now);
    assert.equal(removed, 2);

    const remaining = await store.list();
    const remainingIds = remaining.map((r) => r.id).sort();
    assert.deepEqual(remainingIds, [freshFinding.id, freshOutcome.id].sort());
  });

  it('leaves untouched files whose records are all fresh (no unnecessary rewrites)', async () => {
    const store = createFileMemoryStore({ baseDir });
    const fresh = makeRecord({
      source: { kind: 'explorer', label: 'fresh', createdAt: Date.now() },
    });
    await store.write(fresh);

    const file = path.join(baseDir, 'owner', 'repo', 'main.jsonl');
    const mtimeBefore = (await fs.stat(file)).mtimeMs;
    // Wait enough for mtime granularity on typical filesystems (~10ms).
    await new Promise((r) => setTimeout(r, 30));

    const removed = await store.pruneExpired();
    assert.equal(removed, 0);

    const mtimeAfter = (await fs.stat(file)).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'file should not have been rewritten');
  });
});

// ---------------------------------------------------------------------------
// Serialization + durability
// ---------------------------------------------------------------------------

describe('createFileMemoryStore — concurrent-write serialization', () => {
  it('parallel writes to the same file all land without interleaving', async () => {
    const store = createFileMemoryStore({ baseDir });
    const records = Array.from({ length: 20 }, (_, i) => makeRecord({ summary: `parallel-${i}` }));

    // Fire every write without awaiting so the serializer has to
    // queue them. The interface allows either a void or a Promise
    // return, so we wrap to handle both shapes.
    await Promise.all(records.map((r) => Promise.resolve(store.write(r))));

    const all = await store.list();
    const ids = all.map((r) => r.id).sort();
    assert.equal(all.length, records.length);
    assert.deepEqual(ids, records.map((r) => r.id).sort());

    // File should have exactly 20 well-formed JSONL lines.
    const text = await fs.readFile(path.join(baseDir, 'owner', 'repo', 'main.jsonl'), 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, records.length);
    for (const line of lines) {
      // Each line must be parseable JSON (no interleaved / truncated writes).
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.id, 'string');
    }
  });
});

describe('createFileMemoryStore — malformed-line resilience', () => {
  it('skips malformed JSON lines during read (tolerates crashed writes)', async () => {
    const store = createFileMemoryStore({ baseDir });
    const good = makeRecord({ summary: 'real record' });
    await store.write(good);

    // Simulate a crashed write by appending a partial JSON line.
    const file = path.join(baseDir, 'owner', 'repo', 'main.jsonl');
    await fs.appendFile(file, '{"id":"partial","kind":"fin\n', 'utf8');

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, good.id);

    // A new write after the malformed line should land cleanly and
    // be readable. The malformed line remains in the file — that's
    // a known trade-off; pruneExpired or update can clean it up by
    // rewriting atomically.
    const after = makeRecord({ summary: 'after the crash' });
    await store.write(after);
    const allAfter = await store.list();
    assert.equal(allAfter.length, 2);
    assert.ok(allAfter.some((r) => r.id === after.id));
  });
});
