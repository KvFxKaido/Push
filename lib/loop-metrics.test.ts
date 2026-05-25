import { afterEach, describe, expect, it } from 'vitest';
import {
  getLoopMetrics,
  MAX_RECENT_LOOP_VERDICTS,
  recordLoopVerdict,
  resetLoopMetrics,
} from './loop-metrics.js';

afterEach(() => resetLoopMetrics());

describe('recordLoopVerdict', () => {
  it('counts every verdict in total and byLevel/byAction', () => {
    recordLoopVerdict({
      surface: 'cli',
      level: 'none',
      action: 'none',
      enforced: false,
      reasons: [],
    });
    recordLoopVerdict({
      surface: 'cli',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['x'],
    });
    const m = getLoopMetrics();
    expect(m.total).toBe(2);
    expect(m.byLevel.none).toBe(1);
    expect(m.byLevel.abort).toBe(1);
    expect(m.byAction.abort).toBe(1);
  });

  it('separates enforced actions from dark-suppressed would-fires', () => {
    // Dark warn: level set, action suppressed -> darkSuppressed.
    recordLoopVerdict({
      surface: 'web',
      level: 'warn',
      action: 'none',
      enforced: false,
      reasons: ['near-dup'],
    });
    // Enforced abort: action fired.
    recordLoopVerdict({
      surface: 'cli',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['repeat'],
    });
    const m = getLoopMetrics();
    expect(m.darkSuppressed).toBe(1);
    expect(m.enforcedActions).toBe(1);
  });

  it('buffers only non-none samples', () => {
    recordLoopVerdict({
      surface: 'cli',
      level: 'none',
      action: 'none',
      enforced: false,
      reasons: [],
    });
    recordLoopVerdict({
      surface: 'cli',
      level: 'warn',
      action: 'none',
      enforced: false,
      reasons: ['a'],
    });
    const m = getLoopMetrics();
    expect(m.recent).toHaveLength(1);
    expect(m.recent[0].level).toBe('warn');
  });

  it('bounds the recent buffer', () => {
    for (let i = 0; i < MAX_RECENT_LOOP_VERDICTS + 10; i++) {
      recordLoopVerdict({
        surface: 'cli',
        level: 'warn',
        action: 'none',
        enforced: false,
        reasons: [`r${i}`],
      });
    }
    expect(getLoopMetrics().recent).toHaveLength(MAX_RECENT_LOOP_VERDICTS);
  });

  it('copies reasons so later mutation cannot corrupt the record', () => {
    const reasons = ['mutable'];
    recordLoopVerdict({ surface: 'cli', level: 'warn', action: 'none', enforced: false, reasons });
    reasons.push('added later');
    expect(getLoopMetrics().recent[0].reasons).toEqual(['mutable']);
  });
});

describe('getLoopMetrics scoping', () => {
  it('keeps scopes isolated', () => {
    recordLoopVerdict({
      surface: 'cli',
      scope: 'session-a',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['x'],
    });
    recordLoopVerdict({
      surface: 'cli',
      scope: 'session-b',
      level: 'warn',
      action: 'none',
      enforced: false,
      reasons: ['y'],
    });
    expect(getLoopMetrics('session-a').byLevel.abort).toBe(1);
    expect(getLoopMetrics('session-a').byLevel.warn).toBe(0);
    expect(getLoopMetrics('session-b').byLevel.warn).toBe(1);
  });

  it('aggregates across scopes when scope is omitted', () => {
    recordLoopVerdict({
      surface: 'cli',
      scope: 'session-a',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['x'],
    });
    recordLoopVerdict({
      surface: 'cli',
      scope: 'session-b',
      level: 'warn',
      action: 'none',
      enforced: false,
      reasons: ['y'],
    });
    const all = getLoopMetrics();
    expect(all.total).toBe(2);
    expect(all.byLevel.abort).toBe(1);
    expect(all.byLevel.warn).toBe(1);
    expect(all.recent).toHaveLength(2);
  });

  it('merges aggregate recent in chronological order', () => {
    recordLoopVerdict(
      {
        surface: 'cli',
        scope: 'a',
        level: 'warn',
        action: 'none',
        enforced: false,
        reasons: ['first'],
      },
      100,
    );
    recordLoopVerdict(
      {
        surface: 'web',
        scope: 'b',
        level: 'block',
        action: 'none',
        enforced: false,
        reasons: ['second'],
      },
      200,
    );
    const recent = getLoopMetrics().recent;
    expect(recent.map((r) => r.at)).toEqual([100, 200]);
  });

  it('returns the empty shape for an unknown scope', () => {
    expect(getLoopMetrics('nope').total).toBe(0);
  });
});

describe('resetLoopMetrics', () => {
  it('clears a single scope', () => {
    recordLoopVerdict({
      surface: 'cli',
      scope: 's',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['x'],
    });
    resetLoopMetrics('s');
    expect(getLoopMetrics('s').total).toBe(0);
  });

  it('returned metrics are a copy — mutating them does not affect the store', () => {
    recordLoopVerdict({
      surface: 'cli',
      scope: 's',
      level: 'abort',
      action: 'abort',
      enforced: false,
      reasons: ['x'],
    });
    const snapshot = getLoopMetrics('s');
    snapshot.total = 999;
    snapshot.byLevel.abort = 999;
    expect(getLoopMetrics('s').total).toBe(1);
    expect(getLoopMetrics('s').byLevel.abort).toBe(1);
  });
});
