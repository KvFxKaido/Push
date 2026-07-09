import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipOnWindows } from './test-environment.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set session dir to a temp directory before importing the module
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-test-'));
process.env.PUSH_SESSION_DIR = tmpDir;

const {
  makeSessionId,
  makeRunId,
  makeAttachToken,
  createSessionState,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  listSessions,
  deleteSession,
  getSessionDir,
  validateSessionId,
  isInternalEnvelope,
  rewriteMessagesLog,
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

// ─── makeAttachToken ─────────────────────────────────────────────

describe('makeAttachToken', () => {
  it('produces an att_-prefixed token', () => {
    const token = makeAttachToken();
    assert.match(token, /^att_[0-9a-f]{16}$/);
  });

  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => makeAttachToken()));
    assert.equal(tokens.size, 50);
  });
});

// ─── createSessionState (Universal Session Bearer factory) ────────
//
// The factory is the single mint point for the attach token across all
// three creation surfaces (daemon `handleStartSession`, TUI
// `createFreshSessionState`, CLI `initSession`). These assert the invariant
// the whole bearer design rests on: a session is NEVER born tokenless,
// regardless of what the caller passes.

describe('createSessionState', () => {
  const baseOpts = () => ({
    provider: 'ollama',
    model: 'test-model',
    cwd: '/tmp/test',
    messages: [{ role: 'system', content: 'hi' }],
  });

  it('always mints an att_ attach token at birth', () => {
    const state = createSessionState(baseOpts());
    assert.match(state.attachToken, /^att_[0-9a-f]{16}$/);
  });

  it('mints a fresh token even when the caller passes an empty/whitespace token', () => {
    for (const empty of ['', '   ', undefined]) {
      const state = createSessionState({ ...baseOpts(), attachToken: empty });
      assert.ok(
        typeof state.attachToken === 'string' && state.attachToken.startsWith('att_'),
        `tokenless-by-construction must be unreachable; got ${JSON.stringify(state.attachToken)}`,
      );
    }
  });

  it('honors an explicit non-empty attach token override', () => {
    const state = createSessionState({ ...baseOpts(), attachToken: 'att_pinned' });
    assert.equal(state.attachToken, 'att_pinned');
  });

  it('mints a session id when none is supplied, and honors one when given', () => {
    const minted = createSessionState(baseOpts());
    assert.match(minted.sessionId, SESSION_ID_RE);
    const fixedId = makeSessionId();
    const pinned = createSessionState({ ...baseOpts(), sessionId: fixedId });
    assert.equal(pinned.sessionId, fixedId);
  });

  it('produces unique tokens and ids across calls', () => {
    const states = Array.from({ length: 25 }, () => createSessionState(baseOpts()));
    assert.equal(new Set(states.map((s) => s.attachToken)).size, 25);
    assert.equal(new Set(states.map((s) => s.sessionId)).size, 25);
  });

  it('defaults mode to interactive and honors an explicit mode', () => {
    assert.equal(createSessionState(baseOpts()).mode, 'interactive');
    assert.equal(createSessionState({ ...baseOpts(), mode: 'tui' }).mode, 'tui');
  });

  it('carries the caller fields and a deterministic timestamp when `now` is given', () => {
    const now = 1_700_000_000_000;
    const state = createSessionState({ ...baseOpts(), now, mode: 'headless' });
    assert.equal(state.createdAt, now);
    assert.equal(state.updatedAt, now);
    assert.equal(state.provider, 'ollama');
    assert.equal(state.model, 'test-model');
    assert.equal(state.cwd, '/tmp/test');
    assert.equal(state.rounds, 0);
    assert.equal(state.eventSeq, 0);
  });

  it('round-trips a minted token through save/load (persisted at birth)', async () => {
    const state = createSessionState(baseOpts());
    await saveSessionState(state);
    const loaded = await loadSessionState(state.sessionId);
    assert.equal(loaded.attachToken, state.attachToken);
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

// ─── retired-provider migration on load ──────────────────────────

describe('loadSessionState retired-provider migration', () => {
  it('redirects a removed provider (and its stale model) to the replacement default', async () => {
    const sessionId = makeSessionId();
    await saveSessionState({
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'kilocode',
      model: 'google/gemini-3-flash-preview',
      cwd: '/tmp/test',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    });
    const loaded = await loadSessionState(sessionId);
    // Coerced on read so TUI/daemon resume paths can't crash on
    // PROVIDER_CONFIGS[state.provider] (Codex P2, PR #1382).
    assert.equal(loaded.provider, 'openrouter');
    // The stale model belonged to the removed provider — snapped to the
    // replacement's default (atomic-selection rule).
    assert.equal(loaded.model, 'anthropic/claude-sonnet-4.6:nitro');
  });

  it('redirects removed providers inside roleRouting entries', async () => {
    const sessionId = makeSessionId();
    await saveSessionState({
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test-model',
      cwd: '/tmp/test',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      roleRouting: {
        reviewer: { provider: 'vertex', model: 'gemini-old' },
        coder: { provider: 'ollama', model: 'test-model' },
      },
    });
    const loaded = await loadSessionState(sessionId);
    assert.equal(loaded.roleRouting.reviewer.provider, 'openrouter');
    assert.equal(loaded.roleRouting.reviewer.model, 'anthropic/claude-sonnet-4.6:nitro');
    // Live providers are untouched.
    assert.equal(loaded.roleRouting.coder.provider, 'ollama');
    assert.equal(loaded.roleRouting.coder.model, 'test-model');
  });

  it('leaves sessions on live providers untouched', async () => {
    const sessionId = makeSessionId();
    await saveSessionState({
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'zen',
      model: 'big-pickle',
      cwd: '/tmp/test',
      rounds: 0,
      eventSeq: 0,
      messages: [],
    });
    const loaded = await loadSessionState(sessionId);
    assert.equal(loaded.provider, 'zen');
    assert.equal(loaded.model, 'big-pickle');
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
      // Mode column must be populated for every row so consumers
      // (mobile drawer, picker UIs) can bucket without branching on
      // undefined. Legacy state.json without the field falls back to
      // 'interactive' inside listSessions().
      assert.equal(typeof s.mode, 'string');
      assert.ok(s.mode.length > 0);
    }
    const named = sessions.find((s) => s.sessionId === id2);
    assert.equal(named?.sessionName, 'Review auth middleware');
  });

  it('surfaces the persisted mode on the list row', async () => {
    const idTui = makeSessionId();
    const idHeadless = makeSessionId();
    await saveSessionState({
      sessionId: idTui,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'a',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      mode: 'tui',
    });
    await saveSessionState({
      sessionId: idHeadless,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'a',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      mode: 'headless',
    });

    const sessions = await listSessions();
    const tuiRow = sessions.find((s) => s.sessionId === idTui);
    const headlessRow = sessions.find((s) => s.sessionId === idHeadless);
    assert.equal(tuiRow?.mode, 'tui');
    assert.equal(headlessRow?.mode, 'headless');
  });

  it('defaults legacy sessions without a mode field to interactive', async () => {
    // Simulate a session whose state.json predates the mode field by
    // omitting it from the saveSessionState payload — the slim-state
    // writer drops fields that are undefined, so the resulting state.json
    // matches what a pre-mode CLI version would have left on disk.
    const id = makeSessionId();
    await saveSessionState({
      sessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'a',
      cwd: '/tmp',
      rounds: 0,
      eventSeq: 0,
      messages: [],
      // mode intentionally omitted
    });

    const sessions = await listSessions();
    const row = sessions.find((s) => s.sessionId === id);
    assert.equal(row?.mode, 'interactive');
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
  it('creates session dir with mode 0o700', skipOnWindows, async () => {
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

  it('creates state file with mode 0o600', skipOnWindows, async () => {
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

// ─── Hybrid persistence (messages.jsonl + slim state.json) ───────

describe('saveSessionState — hybrid persistence', () => {
  function freshState(overrides = {}) {
    return {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [],
      ...overrides,
    };
  }

  it('writes messages.jsonl on save and strips messages from state.json', async () => {
    const state = freshState({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    await saveSessionState(state);

    const dir = getSessionDir(state.sessionId);
    const messagesRaw = await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8');
    const lines = messagesRaw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { role: 'user', content: 'hello' });
    assert.deepEqual(JSON.parse(lines[1]), { role: 'assistant', content: 'hi' });

    const stateRaw = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    const onDiskState = JSON.parse(stateRaw);
    assert.equal('messages' in onDiskState, false, 'state.json should not carry messages');
  });

  it('appends only new messages on subsequent saves (no full rewrite)', async () => {
    const state = freshState({ messages: [{ role: 'user', content: 'a' }] });
    await saveSessionState(state);
    state.messages.push({ role: 'assistant', content: 'b' });
    state.messages.push({ role: 'user', content: 'c' });
    await saveSessionState(state);

    const dir = getSessionDir(state.sessionId);
    const lines = (await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).content, 'c');
  });

  it('rewrites messages.jsonl when length shrinks (compaction path)', async () => {
    const state = freshState({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    await saveSessionState(state);
    // Simulate compaction: replace messages with a smaller array.
    state.messages = [{ role: 'user', content: '[CONTEXT DIGEST] summary' }];
    await saveSessionState(state);

    const dir = getSessionDir(state.sessionId);
    const lines = (await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).content, '[CONTEXT DIGEST] summary');
  });

  it('handles empty session (no messages, no log file)', async () => {
    const state = freshState();
    await saveSessionState(state);
    const dir = getSessionDir(state.sessionId);
    const stateRaw = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    const onDiskState = JSON.parse(stateRaw);
    assert.equal('messages' in onDiskState, false);
    // messages.jsonl may not exist when there were no messages to write.

    const loaded = await loadSessionState(state.sessionId);
    assert.deepEqual(loaded.messages, []);
  });
});

describe('loadSessionState — hybrid persistence', () => {
  it('round-trips messages through messages.jsonl', async () => {
    const id = makeSessionId();
    const original = {
      sessionId: id,
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };
    await saveSessionState(original);

    const loaded = await loadSessionState(id);
    assert.deepEqual(loaded.messages, original.messages);
  });

  it('migrates legacy state.json with embedded messages on first save after load', async () => {
    // Simulate a pre-PR 4 session: state.json contains messages inline,
    // no messages.jsonl exists. Loading should hydrate from the embedded
    // array, and the next save should write the log + strip state.json.
    const id = makeSessionId();
    const dir = getSessionDir(id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const legacyState = {
      sessionId: id,
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'user', content: 'legacy-1' },
        { role: 'assistant', content: 'legacy-2' },
      ],
    };
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(legacyState), 'utf8');

    const loaded = await loadSessionState(id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].content, 'legacy-1');

    // Save once: this should migrate the embedded array into messages.jsonl
    // and strip the messages key from state.json.
    await saveSessionState(loaded);

    const messagesRaw = await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8');
    const lines = messagesRaw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const stateRaw = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    assert.equal('messages' in JSON.parse(stateRaw), false);

    // A second load should still see the same messages.
    const reloaded = await loadSessionState(id);
    assert.deepEqual(reloaded.messages, legacyState.messages);
  });
});

describe('listSessions — preview from messages.jsonl', () => {
  it('extracts lastUserMessage from the log when state.json is slim', async () => {
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first user message' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second user message' },
      ],
    };
    await saveSessionState(state);

    const list = await listSessions();
    const row = list.find((entry) => entry.sessionId === state.sessionId);
    assert.ok(row, 'session should appear in list');
    assert.equal(row.lastUserMessage, 'second user message');
  });
});

describe('rewriteMessagesLog', () => {
  it('truncates and re-emits the log, then writes slim state.json', async () => {
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    };
    await saveSessionState(state);
    state.messages = [{ role: 'user', content: 'replaced' }];
    await rewriteMessagesLog(state);

    const dir = getSessionDir(state.sessionId);
    const lines = (await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).content, 'replaced');
  });
});

describe('saveSessionState — in-place mutation defenses', () => {
  it('detects same-length edit at messages[0] via fingerprint and rewrites', async () => {
    // Simulates the system-prompt refresh case: messages[0] is replaced
    // in place without changing array length. The length-only fast path
    // would skip the log; the fingerprint check should force a rewrite.
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'system', content: 'old-sys' },
        { role: 'user', content: 'hi' },
      ],
    };
    await saveSessionState(state);
    state.messages[0] = { role: 'system', content: 'new-sys' };
    await saveSessionState(state);

    const dir = getSessionDir(state.sessionId);
    const lines = (await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).content, 'new-sys');
    assert.equal(JSON.parse(lines[1]).content, 'hi');
  });

  it('detects same-length edit at the tail via fingerprint and rewrites', async () => {
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    };
    await saveSessionState(state);
    state.messages[1] = { role: 'user', content: 'b-edited' };
    await saveSessionState(state);

    const dir = getSessionDir(state.sessionId);
    const lines = (await fs.readFile(path.join(dir, 'messages.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).content, 'b-edited');
  });

  it('skips the log on a true no-op save (no message changes)', async () => {
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    };
    await saveSessionState(state);
    const dir = getSessionDir(state.sessionId);
    const messagesPath = path.join(dir, 'messages.jsonl');
    const firstStat = await fs.stat(messagesPath);
    // Save again with no message changes — only state.json should be
    // touched. messages.jsonl mtime/size should be stable.
    state.workingMemory = { plan: 'updated' };
    await saveSessionState(state);
    const secondStat = await fs.stat(messagesPath);
    assert.equal(firstStat.size, secondStat.size);
    assert.equal(firstStat.mtimeMs, secondStat.mtimeMs);
  });
});

describe('loadMessagesLog — partial-line tolerance', () => {
  it('drops a malformed final line that is missing its terminating newline', async () => {
    // Simulates a crash mid-appendFile: the last message's JSON is
    // partially written (e.g. truncated mid-string). Earlier lines are
    // committed-by-newline and should still load cleanly.
    const id = makeSessionId();
    const dir = getSessionDir(id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // First save lays down a clean log; then we append a partial line.
    const state = {
      sessionId: id,
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
    };
    await saveSessionState(state);
    const messagesPath = path.join(dir, 'messages.jsonl');
    // Tack on a truncated JSON fragment (no closing brace, no newline).
    await fs.appendFile(messagesPath, '{"role":"user","content":"thr', 'utf8');

    const loaded = await loadSessionState(id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].content, 'one');
    assert.equal(loaded.messages[1].content, 'two');
  });

  it('throws on a malformed middle line (real corruption, not crash recovery)', async () => {
    const id = makeSessionId();
    const dir = getSessionDir(id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const messagesPath = path.join(dir, 'messages.jsonl');
    // First line valid; second line garbage; third line valid + trailing
    // newline. The final newline means the corruption is mid-file, not
    // at the tail — that's a real data integrity issue we should
    // surface rather than silently dropping middle messages.
    await fs.writeFile(
      messagesPath,
      `${JSON.stringify({ role: 'user', content: 'one' })}\n` +
        'this-is-not-json\n' +
        `${JSON.stringify({ role: 'user', content: 'three' })}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({
        sessionId: id,
        eventSeq: 0,
        updatedAt: 0,
        cwd: '/tmp',
        provider: 'ollama',
        model: 'test',
        rounds: 0,
        sessionName: '',
        workingMemory: {},
      }),
      'utf8',
    );

    await assert.rejects(
      () => loadSessionState(id),
      (err) => err instanceof SyntaxError || err.name === 'SyntaxError',
    );
  });
});

describe('listSessions — tail-read preview', () => {
  it('returns the right preview without reading the full log', async () => {
    // Build a session with a long-ish transcript so the tail-read path
    // is exercised. Even with the full file present, the preview should
    // surface the most recent human user message.
    const state = {
      sessionId: makeSessionId(),
      eventSeq: 0,
      updatedAt: 0,
      cwd: '/tmp',
      provider: 'ollama',
      model: 'test',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first user' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: '[TOOL_RESULT]\nfile.ts\n[/TOOL_RESULT]' },
        { role: 'user', content: 'most recent user' },
      ],
    };
    await saveSessionState(state);

    const list = await listSessions();
    const row = list.find((entry) => entry.sessionId === state.sessionId);
    assert.ok(row);
    assert.equal(row.lastUserMessage, 'most recent user');
  });
});
