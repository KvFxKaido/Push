/**
 * useDaemonCliSessions.test — pure-helper coverage for the
 * list_sessions response parser. Mirrors the project's hook-testing
 * convention (test exported pure functions; the React state plumbing
 * is exercised at integration time by the screens that mount the
 * hook). The parser is the fragile part — it has to defend against
 * daemon-side schema drift since the rows ride the wire fresh on
 * every refresh.
 */
import { describe, expect, it } from 'vitest';

import { parseListSessionsPayload } from './useDaemonCliSessions';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess_test_abcdef',
    updatedAt: 1_700_000_000_000,
    provider: 'openrouter',
    model: 'claude-3-5-sonnet',
    cwd: '/Users/dev/proj',
    sessionName: 'Review auth middleware',
    lastUserMessage: 'fix the regex',
    mode: 'tui',
    state: 'idle',
    activeRunId: null,
    ...overrides,
  };
}

describe('parseListSessionsPayload', () => {
  it('returns an empty array for missing or malformed payloads', () => {
    expect(parseListSessionsPayload(null)).toEqual([]);
    expect(parseListSessionsPayload(undefined)).toEqual([]);
    expect(parseListSessionsPayload('not-an-object')).toEqual([]);
    expect(parseListSessionsPayload({})).toEqual([]);
    expect(parseListSessionsPayload({ sessions: 'nope' })).toEqual([]);
  });

  it('drops rows missing required fields rather than throwing', () => {
    const out = parseListSessionsPayload({
      sessions: [
        row(),
        { sessionId: '' },
        { updatedAt: 1_700_000_000_000 }, // missing sessionId
        { sessionId: 'sess_other', updatedAt: 'soon' }, // non-number updatedAt
        null,
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('sess_test_abcdef');
  });

  it('filters out headless sessions', () => {
    const out = parseListSessionsPayload({
      sessions: [
        row({ sessionId: 'sess_a', mode: 'tui', updatedAt: 1_700_000_000_000 }),
        row({ sessionId: 'sess_b', mode: 'headless', updatedAt: 1_700_000_002_000 }),
        row({ sessionId: 'sess_c', mode: 'interactive', updatedAt: 1_700_000_001_000 }),
      ],
    });
    // sess_b filtered out; sess_c is more recent so it leads sess_a.
    expect(out.map((s) => s.sessionId)).toEqual(['sess_c', 'sess_a']);
  });

  it('sorts by updatedAt descending so the most recent session wins', () => {
    const out = parseListSessionsPayload({
      sessions: [
        row({ sessionId: 'sess_old', updatedAt: 100 }),
        row({ sessionId: 'sess_newest', updatedAt: 300 }),
        row({ sessionId: 'sess_mid', updatedAt: 200 }),
      ],
    });
    expect(out.map((s) => s.sessionId)).toEqual(['sess_newest', 'sess_mid', 'sess_old']);
  });

  it('defaults mode to interactive when the field is missing or blank', () => {
    // Legacy state.json (pre-#1) wouldn't carry the field on disk;
    // the daemon's listSessions() defaults to 'interactive' on read,
    // but we keep a parser-side fallback too in case a future
    // refactor strips the daemon's coalesce.
    const out = parseListSessionsPayload({
      sessions: [
        row({ sessionId: 'sess_legacy', mode: undefined }),
        row({ sessionId: 'sess_blank', mode: '   ' }),
      ],
    });
    expect(out.map((s) => s.mode)).toEqual(['interactive', 'interactive']);
  });

  it('coerces the running/idle state and preserves activeRunId only when present', () => {
    const out = parseListSessionsPayload({
      sessions: [
        row({ sessionId: 'sess_idle', state: 'idle', activeRunId: null }),
        row({ sessionId: 'sess_running', state: 'running', activeRunId: 'run_xyz' }),
        row({ sessionId: 'sess_unknown', state: 'something_else' }),
      ],
    });
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]));
    expect(byId.sess_idle.state).toBe('idle');
    expect(byId.sess_idle.activeRunId).toBeNull();
    expect(byId.sess_running.state).toBe('running');
    expect(byId.sess_running.activeRunId).toBe('run_xyz');
    expect(byId.sess_unknown.state).toBe('idle');
  });
});
