import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { aggregateStats, formatStats } from '../stats.mjs';
import {
  makeSessionId,
  saveSessionState,
  appendSessionEvent,
  loadSessionEvents,
} from '../session-store.mjs';

// ─── loadSessionEvents ──────────────────────────────────────────

describe('loadSessionEvents', () => {
  let tmpDir;
  let origDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-stats-'));
    origDir = process.env.PUSH_SESSION_DIR;
    process.env.PUSH_SESSION_DIR = path.join(tmpDir, 'sessions');
  });

  after(async () => {
    if (origDir !== undefined) process.env.PUSH_SESSION_DIR = origDir;
    else delete process.env.PUSH_SESSION_DIR;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for missing session', async () => {
    const events = await loadSessionEvents('sess_abc123_def456');
    assert.deepEqual(events, []);
  });

  it('returns events from a real session', async () => {
    const sessionId = makeSessionId();
    const state = {
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'ollama',
      model: 'test',
      cwd: tmpDir,
      rounds: 0,
      eventSeq: 0,
      messages: [],
    };
    await appendSessionEvent(state, 'session_started', { provider: 'ollama' });
    await appendSessionEvent(state, 'user_message', { chars: 10 });

    const events = await loadSessionEvents(sessionId);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'session_started');
    assert.equal(events[1].type, 'user_message');
  });
});

// ─── aggregateStats ─────────────────────────────────────────────

describe('aggregateStats', () => {
  let tmpDir;
  let origDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-stats-'));
    origDir = process.env.PUSH_SESSION_DIR;
    process.env.PUSH_SESSION_DIR = path.join(tmpDir, 'sessions');

    // Create two sessions with different providers
    for (const [provider, model] of [['ollama', 'gemini-3-flash-preview'], ['mistral', 'devstral-small']]) {
      const sessionId = makeSessionId();
      const state = {
        sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider,
        model,
        cwd: tmpDir,
        rounds: 0,
        eventSeq: 0,
        messages: [],
      };
      await appendSessionEvent(state, 'session_started', { provider });
      await appendSessionEvent(state, 'run_complete', { outcome: 'success', rounds: 3 });
      await saveSessionState(state);
    }
  });

  after(async () => {
    if (origDir !== undefined) process.env.PUSH_SESSION_DIR = origDir;
    else delete process.env.PUSH_SESSION_DIR;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('aggregates across all sessions', async () => {
    const { totals, providers } = await aggregateStats();
    assert.equal(totals.sessions, 2);
    assert.equal(totals.runs, 2);
    assert.equal(totals.rounds, 6);
    assert.equal(Object.keys(providers).length, 2);
  });

  it('filters by provider', async () => {
    const { totals } = await aggregateStats({ provider: 'ollama' });
    assert.equal(totals.sessions, 1);
    assert.equal(totals.runs, 1);
  });

  it('filters by model', async () => {
    const { totals } = await aggregateStats({ model: 'devstral-small' });
    assert.equal(totals.sessions, 1);
  });
});

// ─── formatStats ────────────────────────────────────────────────

describe('formatStats', () => {
  it('formats empty stats', () => {
    const text = formatStats({ providers: {}, totals: { sessions: 0 } });
    assert.ok(text.includes('No sessions found'));
  });

  it('formats populated stats', () => {
    const text = formatStats({
      providers: {
        'ollama/test': {
          provider: 'ollama',
          model: 'test',
          sessions: 2,
          runs: 3,
          rounds: 9,
          toolCalls: 15,
          toolErrors: 1,
          malformedCalls: 2,
          outcomes: { success: 2, error: 1 },
          malformedReasons: { json_parse_error: 2 },
        },
      },
      totals: { sessions: 2, runs: 3, rounds: 9, toolCalls: 15, toolErrors: 1, malformedCalls: 2 },
    });
    assert.ok(text.includes('ollama/test'));
    assert.ok(text.includes('Avg rounds/run: 3.0'));
    assert.ok(text.includes('Malformed: 2'));
    assert.ok(text.includes('json_parse_error:2'));
  });
});
