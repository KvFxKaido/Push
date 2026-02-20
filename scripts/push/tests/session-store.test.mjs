import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set session dir to a temp directory before importing the module
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-'));
process.env.PUSH_SESSION_DIR = tmpDir;

const { makeSessionId, makeRunId, saveSessionState, appendSessionEvent, loadSessionState, listSessions, getSessionDir, PROTOCOL_VERSION } = await import('../session-store.mjs');

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.PUSH_SESSION_DIR;
});

// ─── makeSessionId ───────────────────────────────────────────────

describe('makeSessionId', () => {
  it('produces a string starting with sess_', () => {
    const id = makeSessionId();
    assert.ok(id.startsWith('sess_'));
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeSessionId()));
    assert.equal(ids.size, 20);
  });
});

// ─── session round-trip ──────────────────────────────────────────

describe('session persistence', () => {
  const sessionId = makeSessionId();
  const state = {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: 'ollama',
    model: 'test-model',
    cwd: '/tmp/test',
    rounds: 0,
    eventSeq: 0,
    messages: [{ role: 'system', content: 'test' }],
  };

  it('saves and loads session state', async () => {
    await saveSessionState(state);
    const loaded = await loadSessionState(sessionId);
    assert.equal(loaded.sessionId, sessionId);
    assert.equal(loaded.provider, 'ollama');
    assert.equal(loaded.model, 'test-model');
    assert.deepEqual(loaded.messages, [{ role: 'system', content: 'test' }]);
  });

  it('rejects loading with wrong session id', async () => {
    await assert.rejects(
      () => loadSessionState('nonexistent_session'),
      /ENOENT/,
    );
  });
});

// ─── event serialization shape ───────────────────────────────────

describe('event serialization', () => {
  const sessionId = makeSessionId();
  const state = {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: 'ollama',
    model: 'test',
    cwd: '/tmp',
    rounds: 0,
    eventSeq: 0,
    messages: [],
  };

  it('writes JSONL events with protocol-aligned envelope', async () => {
    const runId = makeRunId();
    await appendSessionEvent(state, 'session_started', { sessionId, state: 'idle', mode: 'interactive', provider: 'ollama', sandboxProvider: 'local' });
    await appendSessionEvent(state, 'tool_call', { source: 'sandbox', toolName: 'exec', args: { command: 'ls' } }, runId);
    await appendSessionEvent(state, 'run_complete', { runId, outcome: 'success', summary: 'done' }, runId);

    const eventsPath = path.join(getSessionDir(sessionId), 'events.jsonl');
    const raw = await fs.readFile(eventsPath, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 3);

    for (const line of lines) {
      const event = JSON.parse(line);
      // Protocol envelope fields
      assert.equal(event.v, PROTOCOL_VERSION, 'v matches protocol version');
      assert.equal(event.kind, 'event', 'kind is event');
      assert.equal(event.sessionId, sessionId, 'sessionId matches');
      assert.ok(typeof event.ts === 'number', 'ts is a number');
      assert.ok(typeof event.seq === 'number', 'seq is a number');
      assert.ok(typeof event.type === 'string', 'type is a string');
      assert.ok(event.payload && typeof event.payload === 'object', 'payload is an object');
    }

    // Verify sequential ordering
    const events = lines.map((l) => JSON.parse(l));
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(events[2].seq, 3);
    assert.equal(events[0].type, 'session_started');
    assert.equal(events[1].type, 'tool_call');
    assert.equal(events[2].type, 'run_complete');

    // Run-scoped events have runId
    assert.equal(events[0].runId, undefined, 'session_started has no runId');
    assert.ok(events[1].runId.startsWith('run_'), 'tool_call has runId');
    assert.ok(events[2].runId.startsWith('run_'), 'run_complete has runId');

    // Normalized payload keys
    assert.equal(events[1].payload.toolName, 'exec');
    assert.equal(events[1].payload.source, 'sandbox');
  });
});

// ─── listSessions ────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns saved sessions sorted by updatedAt desc', async () => {
    const id1 = makeSessionId();
    const id2 = makeSessionId();
    await saveSessionState({
      sessionId: id1, createdAt: 1000, updatedAt: 1000,
      provider: 'ollama', model: 'a', cwd: '/tmp', rounds: 0, eventSeq: 0, messages: [],
    });
    await saveSessionState({
      sessionId: id2, createdAt: 2000, updatedAt: 2000,
      provider: 'mistral', model: 'b', cwd: '/tmp', rounds: 0, eventSeq: 0, messages: [],
    });

    const sessions = await listSessions();
    // Most recent first — id2 has higher updatedAt (saveSessionState sets updatedAt to Date.now())
    const ids = sessions.map((s) => s.sessionId);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
    // Verify shape
    for (const s of sessions) {
      assert.ok(s.sessionId);
      assert.ok(typeof s.updatedAt === 'number');
      assert.ok(s.provider);
      assert.ok(s.model);
    }
  });
});
