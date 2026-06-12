// Tests for `pruneSessions` (cli/session-store.ts) — the selector kernel
// behind `push sessions prune`. Pins:
//   - AND-combination of selectors (a multi-flag prune deletes the
//     intersection, never the union),
//   - dry-run leaves the store untouched while reporting the kill list,
//   - the fresh-run-marker guard (live sessions are never pruned; stale
//     crash markers don't shield a session forever),
//   - empty/age/keep/model selector semantics, including the
//     at-least-one-selector requirement.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSessionState,
  saveSessionState,
  pruneSessions,
  writeRunMarker,
  listSessions,
} from '../session-store.ts';

const DAY_MS = 86_400_000;
const NOW = 1_790_000_000_000;

let tmpDir;
let prevSessionDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-prune-test-'));
  prevSessionDir = process.env.PUSH_SESSION_DIR;
  process.env.PUSH_SESSION_DIR = tmpDir;
});

afterEach(async () => {
  if (prevSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
  else process.env.PUSH_SESSION_DIR = prevSessionDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Seed a persisted session. `withUserMessage: false` produces an "empty"
 * session (system message only — no human turn in the transcript).
 */
async function seedSession({
  provider = 'zen',
  model = 'real-model',
  ageDays = 0,
  withUserMessage = true,
}) {
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }];
  if (withUserMessage) {
    messages.push({ role: 'user', content: 'hello from a real conversation' });
  }
  const state = createSessionState({ provider, model, cwd: tmpDir, messages });
  await saveSessionState(state);
  // Backdate after the save so its timestamp bump doesn't clobber the age.
  const statePath = path.join(tmpDir, state.sessionId, 'state.json');
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
  raw.updatedAt = NOW - ageDays * DAY_MS;
  await fs.writeFile(statePath, JSON.stringify(raw));
  return state.sessionId;
}

describe('pruneSessions', () => {
  it('requires at least one selector', async () => {
    await assert.rejects(
      () => pruneSessions({}, { dryRun: true, now: NOW }),
      /at least one selector/,
    );
  });

  it('dry-run reports the kill list without deleting anything', async () => {
    const oldId = await seedSession({ ageDays: 40 });
    const freshId = await seedSession({ ageDays: 1 });

    const report = await pruneSessions({ olderThanDays: 30 }, { dryRun: true, now: NOW });
    assert.equal(report.dryRun, true);
    assert.deepEqual(
      report.candidates.map((c) => c.sessionId),
      [oldId],
    );
    assert.deepEqual(report.deleted, []);
    assert.ok(report.candidates[0].bytes > 0, 'candidate sizing missing');

    const remaining = (await listSessions()).map((s) => s.sessionId).sort();
    assert.deepEqual(remaining, [freshId, oldId].sort(), 'dry run mutated the store');
  });

  it('deletes matched sessions when not dry-run', async () => {
    const oldId = await seedSession({ ageDays: 40 });
    const freshId = await seedSession({ ageDays: 1 });

    const report = await pruneSessions({ olderThanDays: 30 }, { dryRun: false, now: NOW });
    assert.deepEqual(report.deleted, [oldId]);
    assert.deepEqual(report.failed, []);

    const remaining = (await listSessions()).map((s) => s.sessionId);
    assert.deepEqual(remaining, [freshId]);
  });

  it('selects empty sessions (no human user message) with --empty', async () => {
    const emptyId = await seedSession({ withUserMessage: false });
    await seedSession({ withUserMessage: true });

    const report = await pruneSessions({ empty: true }, { dryRun: true, now: NOW });
    assert.deepEqual(
      report.candidates.map((c) => c.sessionId),
      [emptyId],
    );
  });

  it('matches provider/model against the regex selector', async () => {
    const fixtureA = await seedSession({ provider: 'ollama', model: 'ollama-base' });
    const fixtureB = await seedSession({ provider: 'ollama', model: 'replay-target' });
    await seedSession({ provider: 'zen', model: 'deepseek-v4-flash' });

    const report = await pruneSessions(
      { matchModel: 'ollama-base|replay-target' },
      { dryRun: true, now: NOW },
    );
    assert.deepEqual(report.candidates.map((c) => c.sessionId).sort(), [fixtureA, fixtureB].sort());
  });

  it('keep retains the N most recent and matches the rest', async () => {
    const oldest = await seedSession({ ageDays: 3 });
    const middle = await seedSession({ ageDays: 2 });
    const newest = await seedSession({ ageDays: 1 });

    const report = await pruneSessions({ keep: 1 }, { dryRun: true, now: NOW });
    assert.deepEqual(report.candidates.map((c) => c.sessionId).sort(), [oldest, middle].sort());
    assert.ok(!report.candidates.some((c) => c.sessionId === newest));
  });

  it('ANDs selectors — a multi-flag prune is the intersection', async () => {
    const oldFixture = await seedSession({ provider: 'ollama', model: 'ollama-base', ageDays: 40 });
    await seedSession({ provider: 'ollama', model: 'ollama-base', ageDays: 1 }); // matches model, too fresh
    await seedSession({ provider: 'zen', model: 'real-model', ageDays: 40 }); // old, wrong model

    const report = await pruneSessions(
      { olderThanDays: 30, matchModel: 'ollama-base' },
      { dryRun: true, now: NOW },
    );
    assert.deepEqual(
      report.candidates.map((c) => c.sessionId),
      [oldFixture],
    );
  });

  it('skips sessions with a fresh run marker, prunes past stale crash markers', async () => {
    const liveId = await seedSession({ ageDays: 40 });
    const crashedId = await seedSession({ ageDays: 40 });
    await writeRunMarker(liveId, 'run_live');
    await writeRunMarker(crashedId, 'run_crashed');

    // Backdate the crashed session's marker beyond the active window.
    const crashedMarkerPath = path.join(tmpDir, crashedId, 'run.json');
    const marker = JSON.parse(await fs.readFile(crashedMarkerPath, 'utf8'));
    marker.startedAt = NOW - 2 * DAY_MS;
    await fs.writeFile(crashedMarkerPath, JSON.stringify(marker));
    const liveMarkerPath = path.join(tmpDir, liveId, 'run.json');
    const liveMarker = JSON.parse(await fs.readFile(liveMarkerPath, 'utf8'));
    liveMarker.startedAt = NOW - 60_000;
    await fs.writeFile(liveMarkerPath, JSON.stringify(liveMarker));

    const report = await pruneSessions({ olderThanDays: 30 }, { dryRun: false, now: NOW });
    assert.deepEqual(report.skippedActive, [liveId]);
    assert.deepEqual(report.deleted, [crashedId]);

    const remaining = (await listSessions()).map((s) => s.sessionId);
    assert.deepEqual(remaining, [liveId]);
  });

  it('rejects invalid selector values', async () => {
    await assert.rejects(
      () => pruneSessions({ olderThanDays: -1 }, { dryRun: true, now: NOW }),
      /non-negative/,
    );
    await assert.rejects(
      () => pruneSessions({ keep: 1.5 }, { dryRun: true, now: NOW }),
      /non-negative integer/,
    );
  });
});
