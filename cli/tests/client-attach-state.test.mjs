import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readClientAttachState,
  writeClientAttachState,
  makeDebouncedClientAttachWriter,
} from '../client-attach-state.ts';
import { makeSessionId } from '../session-store.ts';

// Sentinel to track PUSH_SESSION_DIR so tests can safely nest mutations.
async function withTmpSessionRoot(label, fn) {
  const original = process.env.PUSH_SESSION_DIR;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `push-client-attach-${label}-`));
  process.env.PUSH_SESSION_DIR = tmp;
  try {
    await fn(tmp);
  } finally {
    if (original === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = original;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('readClientAttachState', () => {
  it('returns a zero-initialized state when no file exists', async () => {
    await withTmpSessionRoot('read-missing', async () => {
      const sessionId = makeSessionId();
      const state = await readClientAttachState(sessionId);
      assert.equal(state.lastSeenSeq, 0);
      assert.equal(state.updatedAt, 0);
    });
  });

  it('returns a zero-initialized state when the file is malformed JSON', async () => {
    await withTmpSessionRoot('read-malformed', async () => {
      const sessionId = makeSessionId();
      const dir = path.join(process.env.PUSH_SESSION_DIR, sessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'client-attach.json'), 'not-json{', 'utf8');

      const state = await readClientAttachState(sessionId);
      assert.equal(state.lastSeenSeq, 0);
    });
  });

  it('coerces non-numeric lastSeenSeq to 0', async () => {
    await withTmpSessionRoot('read-coerce', async () => {
      const sessionId = makeSessionId();
      const dir = path.join(process.env.PUSH_SESSION_DIR, sessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'client-attach.json'),
        JSON.stringify({ lastSeenSeq: 'banana', updatedAt: 'yesterday' }),
        'utf8',
      );

      const state = await readClientAttachState(sessionId);
      assert.equal(state.lastSeenSeq, 0);
      assert.equal(state.updatedAt, 0);
    });
  });

  it('floors fractional lastSeenSeq and clamps negative values', async () => {
    await withTmpSessionRoot('read-clamp', async () => {
      const sessionId = makeSessionId();
      const dir = path.join(process.env.PUSH_SESSION_DIR, sessionId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'client-attach.json'),
        JSON.stringify({ lastSeenSeq: 42.9, updatedAt: Date.now() }),
        'utf8',
      );

      const state = await readClientAttachState(sessionId);
      assert.equal(state.lastSeenSeq, 42);

      await fs.writeFile(
        path.join(dir, 'client-attach.json'),
        JSON.stringify({ lastSeenSeq: -3, updatedAt: Date.now() }),
        'utf8',
      );
      const clamped = await readClientAttachState(sessionId);
      assert.equal(clamped.lastSeenSeq, 0);
    });
  });
});

describe('writeClientAttachState', () => {
  it('creates the session dir on demand and persists the seq', async () => {
    await withTmpSessionRoot('write-create', async () => {
      const sessionId = makeSessionId();
      await writeClientAttachState(sessionId, 17);

      const roundtrip = await readClientAttachState(sessionId);
      assert.equal(roundtrip.lastSeenSeq, 17);
      assert.ok(roundtrip.updatedAt > 0);
    });
  });

  it('overwrites an existing file', async () => {
    await withTmpSessionRoot('write-overwrite', async () => {
      const sessionId = makeSessionId();
      await writeClientAttachState(sessionId, 5);
      await writeClientAttachState(sessionId, 12);
      const roundtrip = await readClientAttachState(sessionId);
      assert.equal(roundtrip.lastSeenSeq, 12);
    });
  });

  it('ignores non-finite or negative values', async () => {
    await withTmpSessionRoot('write-reject', async () => {
      const sessionId = makeSessionId();
      await writeClientAttachState(sessionId, 10);
      await writeClientAttachState(sessionId, Number.NaN);
      await writeClientAttachState(sessionId, -5);
      const roundtrip = await readClientAttachState(sessionId);
      // The valid 10 should still be on disk — the later bad writes are no-ops.
      assert.equal(roundtrip.lastSeenSeq, 10);
    });
  });

  it('writes the file with restrictive permissions', async () => {
    await withTmpSessionRoot('write-mode', async () => {
      const sessionId = makeSessionId();
      await writeClientAttachState(sessionId, 3);
      const filePath = path.join(process.env.PUSH_SESSION_DIR, sessionId, 'client-attach.json');
      const stat = await fs.stat(filePath);
      // Mask off file-type bits; we only care about the permission portion.
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600);
    });
  });
});

describe('makeDebouncedClientAttachWriter', () => {
  it('coalesces rapid schedule calls into a single flushed write', async () => {
    await withTmpSessionRoot('debounced-coalesce', async () => {
      const sessionId = makeSessionId();
      const writer = makeDebouncedClientAttachWriter(sessionId, 10);

      for (let i = 1; i <= 50; i += 1) writer.schedule(i);
      await writer.flush();

      const persisted = await readClientAttachState(sessionId);
      assert.equal(persisted.lastSeenSeq, 50);
    });
  });

  it('flush persists the latest scheduled value even before the timer fires', async () => {
    await withTmpSessionRoot('debounced-flush', async () => {
      const sessionId = makeSessionId();
      const writer = makeDebouncedClientAttachWriter(sessionId, 10_000); // never fires
      writer.schedule(7);
      writer.schedule(9);
      await writer.flush();

      const persisted = await readClientAttachState(sessionId);
      assert.equal(persisted.lastSeenSeq, 9);
    });
  });

  it('flush is a no-op when nothing was scheduled', async () => {
    await withTmpSessionRoot('debounced-empty', async () => {
      const sessionId = makeSessionId();
      const writer = makeDebouncedClientAttachWriter(sessionId, 10);
      await writer.flush();
      const persisted = await readClientAttachState(sessionId);
      assert.equal(persisted.lastSeenSeq, 0);
    });
  });

  it('ignores scheduled values that would regress the last persisted seq', async () => {
    await withTmpSessionRoot('debounced-regress', async () => {
      const sessionId = makeSessionId();
      const writer = makeDebouncedClientAttachWriter(sessionId, 10);
      writer.schedule(20);
      await writer.flush();

      writer.schedule(5);
      await writer.flush();

      const persisted = await readClientAttachState(sessionId);
      assert.equal(persisted.lastSeenSeq, 20);
    });
  });
});
