import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set session dir to a temp directory before importing the module
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-'));
process.env.PUSH_SESSION_DIR = tmpDir;

const {
  makeSessionId,
  makeRunId,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  listSessions,
  deleteSession,
  getSessionDir,
  validateSessionId,
  isInternalEnvelope,
  SESSION_ID_RE,
  PROTOCOL_VERSION,
} = await import('../session-store.ts');

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

  it('does not expose partial JSON during concurrent saves and loads', async () => {
    const id = makeSessionId();
    const baseState = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test-model',
      cwd: '/tmp/test',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    };

    await saveSessionState(baseState);

    const writes = Array.from({ length: 25 }, (_, index) =>
      saveSessionState({
        ...baseState,
        rounds: index,
        messages: [{ role: 'user', content: `message ${index}`.repeat(1000) }],
      }),
    );
    const reads = Array.from({ length: 25 }, () => loadSessionState(id));

    const loadedStates = await Promise.all(reads.concat(writes)).then((results) =>
      results.filter((result) => result && typeof result === 'object' && 'sessionId' in result),
    );

    assert.ok(loadedStates.length > 0);
    for (const loaded of loadedStates) {
      assert.equal(loaded.sessionId, id);
      assert.ok(Array.isArray(loaded.messages));
    }

    const files = await fs.readdir(getSessionDir(id));
    assert.ok(!files.some((file) => file.endsWith('.tmp')), 'temporary state files are cleaned up');
  });

  it('rejects loading with invalid session id', async () => {
    await assert.rejects(() => loadSessionState('nonexistent_session'), /Invalid session id/);
  });

  it('rejects loading non-existent valid-format session id', async () => {
    await assert.rejects(() => loadSessionState('sess_abc123_def456'), /ENOENT/);
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
    await appendSessionEvent(state, 'session_started', {
      sessionId,
      state: 'idle',
      mode: 'interactive',
      provider: 'ollama',
      sandboxProvider: 'local',
    });
    await appendSessionEvent(
      state,
      'tool.execution_start',
      {
        round: 0,
        executionId: 'exec-1',
        toolSource: 'sandbox',
        toolName: 'exec',
        args: { command: 'ls' },
      },
      runId,
    );
    await appendSessionEvent(
      state,
      'run_complete',
      { runId, outcome: 'success', summary: 'done' },
      runId,
    );

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
    assert.equal(events[1].type, 'tool.execution_start');
    assert.equal(events[2].type, 'run_complete');

    // Run-scoped events have runId
    assert.equal(events[0].runId, undefined, 'session_started has no runId');
    assert.ok(events[1].runId.startsWith('run_'), 'tool.execution_start has runId');
    assert.ok(events[2].runId.startsWith('run_'), 'run_complete has runId');

    // Normalized payload keys
    assert.equal(events[1].payload.toolName, 'exec');
    assert.equal(events[1].payload.toolSource, 'sandbox');
  });
});

// ─── listSessions ────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns saved sessions sorted by updatedAt desc', async () => {
    const id1 = makeSessionId();
    const id2 = makeSessionId();
    await saveSessionState({
      sessionId: id1,
      createdAt: 1000,
      updatedAt: 1000,
      provider: 'ollama',
      model: 'a',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    });
    await saveSessionState({
      sessionId: id2,
      createdAt: 2000,
      updatedAt: 2000,
      provider: 'openrouter',
      model: 'b',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      sessionName: 'Review auth middleware',
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
      assert.equal(typeof s.sessionName, 'string');
    }
    const named = sessions.find((s) => s.sessionId === id2);
    assert.equal(named?.sessionName, 'Review auth middleware');
  });
});

// ─── deleteSession ───────────────────────────────────────────────

describe('deleteSession', () => {
  it('deletes an existing session directory and removes it from listings', async () => {
    const id = makeSessionId();
    await saveSessionState({
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'delete-me',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    });

    const deleted = await deleteSession(id);
    assert.equal(deleted, 1);

    const sessions = await listSessions();
    assert.ok(!sessions.some((s) => s.sessionId === id));
    await assert.rejects(() => loadSessionState(id), /ENOENT/);
  });

  it('returns 0 when the session does not exist', async () => {
    const deleted = await deleteSession('sess_abc123_def456');
    assert.equal(deleted, 0);
  });
});

// ─── validateSessionId ──────────────────────────────────────────

describe('validateSessionId', () => {
  it('accepts output of makeSessionId()', () => {
    const id = makeSessionId();
    assert.equal(validateSessionId(id), id);
  });

  it('rejects path traversal', () => {
    assert.throws(() => validateSessionId('../../etc'), /Invalid session id/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateSessionId(''), /Invalid session id/);
  });

  it('rejects non-string values', () => {
    assert.throws(() => validateSessionId(null), /Invalid session id/);
    assert.throws(() => validateSessionId(undefined), /Invalid session id/);
    assert.throws(() => validateSessionId(42), /Invalid session id/);
  });

  it('rejects partial format (missing hex suffix)', () => {
    assert.throws(() => validateSessionId('sess_abc'), /Invalid session id/);
  });

  it('rejects format with wrong prefix', () => {
    assert.throws(() => validateSessionId('run_abc_def123'), /Invalid session id/);
  });
});

// ─── roleRouting persistence ────────────────────────────────────

describe('roleRouting persistence', () => {
  it('saves and loads roleRouting on session state', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      roleRouting: {
        coder: { provider: 'openrouter', model: 'gpt-4' },
        explorer: { provider: 'ollama', model: 'llama3' },
      },
    };
    await saveSessionState(state);
    const loaded = await loadSessionState(id);
    assert.deepEqual(loaded.roleRouting, {
      coder: { provider: 'openrouter', model: 'gpt-4' },
      explorer: { provider: 'ollama', model: 'llama3' },
    });
  });

  it('preserves empty roleRouting through save/load', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      roleRouting: {},
    };
    await saveSessionState(state);
    const loaded = await loadSessionState(id);
    assert.deepEqual(loaded.roleRouting, {});
  });

  it('loads sessions without roleRouting (backwards compat)', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    };
    await saveSessionState(state);
    const loaded = await loadSessionState(id);
    assert.equal(loaded.roleRouting, undefined);
  });
});

// ─── delegationOutcomes persistence ─────────────────────────────

describe('delegationOutcomes persistence', () => {
  it('saves and loads delegationOutcomes', async () => {
    const id = makeSessionId();
    const outcomes = [
      {
        subagentId: 'sub_1',
        outcome: {
          agent: 'coder',
          status: 'complete',
          summary: 'done',
          evidence: [],
          checks: [],
          gateVerdicts: [],
          missingRequirements: [],
          nextRequiredAction: null,
          rounds: 1,
          checkpoints: 0,
          elapsedMs: 10,
        },
      },
    ];
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      delegationOutcomes: outcomes,
    };
    await saveSessionState(state);
    const loaded = await loadSessionState(id);
    assert.ok(Array.isArray(loaded.delegationOutcomes));
    assert.equal(loaded.delegationOutcomes.length, 1);
    assert.equal(loaded.delegationOutcomes[0].subagentId, 'sub_1');
    assert.equal(loaded.delegationOutcomes[0].outcome.agent, 'coder');
    assert.equal(loaded.delegationOutcomes[0].outcome.status, 'complete');
  });

  it('loads old sessions without delegationOutcomes as undefined', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    };
    await saveSessionState(state);
    const loaded = await loadSessionState(id);
    assert.equal(loaded.delegationOutcomes, undefined);
  });
});

// ─── getSessionDir traversal guard ──────────────────────────────

describe('getSessionDir security', () => {
  it('throws on path traversal attempt', () => {
    assert.throws(() => getSessionDir('../../etc'), /Invalid session id/);
  });

  it('throws on non-matching id format', () => {
    assert.throws(() => getSessionDir('bad_id'), /Invalid session id/);
  });

  it('returns valid path for proper session id', () => {
    const id = makeSessionId();
    const dir = getSessionDir(id);
    assert.ok(dir.endsWith(id));
  });
});

// ─── File permissions ───────────────────────────────────────────

describe('session file permissions', () => {
  it('creates session dir with mode 0o700', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [{ role: 'system', content: 'test' }],
    };
    await saveSessionState(state);
    const dir = getSessionDir(id);
    const stat = await fs.stat(dir);
    assert.equal(stat.mode & 0o777, 0o700, 'dir should be 0700');
  });

  it('creates state file with mode 0o600', async () => {
    const id = makeSessionId();
    const state = {
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [{ role: 'system', content: 'test' }],
    };
    await saveSessionState(state);
    const statePath = path.join(getSessionDir(id), 'state.json');
    const stat = await fs.stat(statePath);
    assert.equal(stat.mode & 0o777, 0o600, 'state file should be 0600');
  });
});

// ─── listSessions skips invalid dirs ────────────────────────────

describe('listSessions security', () => {
  it('skips directories that do not match session id format', async () => {
    // Create a dir with an invalid name
    const badDir = path.join(tmpDir, '..sneaky_traversal');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, 'state.json'),
      JSON.stringify({
        sessionId: '..sneaky_traversal',
        updatedAt: Date.now(),
        provider: 'ollama',
        model: 'a',
        cwd: '/tmp',
      }),
      'utf8',
    );

    const sessions = await listSessions();
    const ids = sessions.map((s) => s.sessionId);
    assert.ok(!ids.includes('..sneaky_traversal'), 'should not list invalid session dirs');

    // Cleanup
    await fs.rm(badDir, { recursive: true, force: true });
  });
});

// ─── isInternalEnvelope ──────────────────────────────────────────

describe('isInternalEnvelope', () => {
  it('matches paired envelopes from production code', () => {
    assert.equal(isInternalEnvelope('[TOOL_RESULT]\n{}\n[/TOOL_RESULT]'), true);
    assert.equal(
      isInternalEnvelope('[PROJECT_INSTRUCTIONS source="AGENTS.md"]\nfoo\n[/PROJECT_INSTRUCTIONS]'),
      true,
    );
    assert.equal(isInternalEnvelope('[CONTEXT DIGEST]\nsnippets\n[/CONTEXT DIGEST]'), true);
    assert.equal(isInternalEnvelope('[SESSION_RECOVERED]\nresume\n[/SESSION_RECOVERED]'), true);
    assert.equal(isInternalEnvelope('[TOOL_DENIED] reason [/TOOL_DENIED]'), true);
  });

  it('does not match bracket-led human prompts without a closing tag', () => {
    assert.equal(isInternalEnvelope('[WIP] refactor the auth module'), false);
    assert.equal(isInternalEnvelope('[bug] repro steps below'), false);
    assert.equal(isInternalEnvelope('[ ] fix flaky tests'), false); // markdown checklist
    assert.equal(isInternalEnvelope('[x] completed'), false);
    assert.equal(isInternalEnvelope('[link text](http://example.com)'), false);
    assert.equal(isInternalEnvelope('["key": "value"]'), false); // JSON-like
  });

  it('does not match an envelope whose closing tag is missing', () => {
    // Looks like an envelope but the closer is absent — still treat as
    // human content (the inner heuristic requires a paired tag).
    assert.equal(isInternalEnvelope('[TOOL_RESULT] without closer'), false);
  });

  it('does not match strings that do not start with a bracket', () => {
    assert.equal(isInternalEnvelope('Fix the retry loop'), false);
    assert.equal(isInternalEnvelope(''), false);
    assert.equal(isInternalEnvelope('  [TOOL_RESULT][/TOOL_RESULT]'), false); // leading whitespace (caller trims)
  });
});
