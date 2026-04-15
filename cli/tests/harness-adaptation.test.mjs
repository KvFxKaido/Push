import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAdaptation,
  collectAdaptationSignals,
  resetAdaptationState,
  THRESHOLDS,
} from '../harness-adaptation.ts';
import { recordMalformedToolCall, resetToolCallMetrics } from '../tool-call-metrics.ts';
import { recordWriteFile, resetWriteFileMetrics } from '../edit-metrics.ts';
import { recordContextTrim, resetContextMetrics } from '../context-metrics.ts';

const S = 'test-session';

function resetAllFor(sessionId) {
  resetToolCallMetrics(sessionId);
  resetWriteFileMetrics(sessionId);
  resetContextMetrics(sessionId);
  resetAdaptationState(sessionId);
}

function resetAllGlobal() {
  resetToolCallMetrics();
  resetWriteFileMetrics();
  resetContextMetrics();
  resetAdaptationState();
}

describe('collectAdaptationSignals', () => {
  beforeEach(() => {
    resetAllGlobal();
  });

  it('returns zero signals when nothing has been recorded for the session', () => {
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.malformedCallCount, 0);
    assert.equal(signals.contextPressureEvents, 0);
    assert.equal(signals.contextTokensSaved, 0);
    assert.equal(signals.editErrorRate, 0);
    assert.equal(signals.editStaleRate, 0);
  });

  it('accumulates malformed tool calls across reason strings within one session', () => {
    recordMalformedToolCall('json_parse_error', S);
    recordMalformedToolCall('json_parse_error', S);
    recordMalformedToolCall('missing_tool', S);
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.malformedCallCount, 3);
  });

  it('computes edit error and stale rates independently', () => {
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: true, stale: false });
    recordWriteFile(S, { error: false, stale: true });
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.editErrorRate, 0.25);
    assert.equal(signals.editStaleRate, 0.25);
  });

  it('counts context compression events and tokens saved', () => {
    recordContextTrim(S, { trimmed: true, beforeTokens: 1000, afterTokens: 500 });
    recordContextTrim(S, { trimmed: false });
    recordContextTrim(S, { trimmed: true, beforeTokens: 800, afterTokens: 600 });
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.contextPressureEvents, 2);
    assert.equal(signals.contextTokensSaved, 700);
  });

  it('ignores trims with missing before/after tokens', () => {
    recordContextTrim(S, { trimmed: true });
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.contextPressureEvents, 1);
    assert.equal(signals.contextTokensSaved, 0);
  });

  it('isolates signals between two concurrent sessions', () => {
    const A = 'sess-a';
    const B = 'sess-b';
    recordMalformedToolCall('json_parse_error', A);
    recordMalformedToolCall('json_parse_error', A);
    recordMalformedToolCall('missing_tool', B);

    const signalsA = collectAdaptationSignals(A);
    const signalsB = collectAdaptationSignals(B);
    assert.equal(signalsA.malformedCallCount, 2);
    assert.equal(signalsB.malformedCallCount, 1);
  });
});

describe('computeAdaptation', () => {
  beforeEach(() => {
    resetAllGlobal();
  });

  it('does not adapt when no signals have been recorded', () => {
    const result = computeAdaptation(S, 30);
    assert.equal(result.wasAdapted, false);
    assert.equal(result.adjustedMaxRounds, 30);
    assert.deepEqual(result.reasons, []);
  });

  it('shrinks to 20 when malformed count reaches threshold', () => {
    for (let i = 0; i < THRESHOLDS.MALFORMED_CALL_ESCALATION; i++) {
      recordMalformedToolCall('json_parse_error', S);
    }
    const result = computeAdaptation(S, 30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 20);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /malformed tool calls/);
  });

  it('is idempotent: Rule 1 fires at most once even if called every round', () => {
    for (let i = 0; i < 5; i++) recordMalformedToolCall('json_parse_error', S);
    const first = computeAdaptation(S, 30);
    assert.equal(first.adjustedMaxRounds, 20);
    const second = computeAdaptation(S, first.adjustedMaxRounds);
    assert.equal(second.wasAdapted, false);
    assert.equal(second.adjustedMaxRounds, 20);
  });

  it('shrinks by 5 when edit error rate crosses the 25 percent threshold', () => {
    recordWriteFile(S, { error: true, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    const result = computeAdaptation(S, 30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 25);
    assert.match(result.reasons[0], /edit error rate/);
  });

  it('is idempotent: Rule 2 fires at most once even when called every round', () => {
    recordWriteFile(S, { error: true, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    const first = computeAdaptation(S, 30);
    assert.equal(first.adjustedMaxRounds, 25);
    const second = computeAdaptation(S, first.adjustedMaxRounds);
    assert.equal(second.wasAdapted, false);
    assert.equal(second.adjustedMaxRounds, 25);
    const third = computeAdaptation(S, first.adjustedMaxRounds);
    assert.equal(third.wasAdapted, false);
    assert.equal(third.adjustedMaxRounds, 25);
  });

  it('floors edit-error-rate reduction at 15', () => {
    recordWriteFile(S, { error: true, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    const result = computeAdaptation(S, 16);
    assert.equal(result.adjustedMaxRounds, 15);
  });

  it('applies both rules sequentially when both signals escalate', () => {
    for (let i = 0; i < 3; i++) recordMalformedToolCall('json_parse_error', S);
    recordWriteFile(S, { error: true, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    recordWriteFile(S, { error: false, stale: false });
    const result = computeAdaptation(S, 30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 15);
    assert.equal(result.reasons.length, 2);
  });

  it('never raises the ceiling above the provided current value', () => {
    const result = computeAdaptation(S, 15);
    assert.equal(result.adjustedMaxRounds, 15);
    assert.equal(result.wasAdapted, false);
  });

  it('stale writes alone do not shrink via Rule 2 (error rate excludes stale)', () => {
    // 4 writes, all of them stale — editErrorRate should be 0, editStaleRate 1.0
    recordWriteFile(S, { error: false, stale: true });
    recordWriteFile(S, { error: false, stale: true });
    recordWriteFile(S, { error: false, stale: true });
    recordWriteFile(S, { error: false, stale: true });
    const signals = collectAdaptationSignals(S);
    assert.equal(signals.editErrorRate, 0);
    assert.equal(signals.editStaleRate, 1);
    const result = computeAdaptation(S, 30);
    assert.equal(result.wasAdapted, false);
    assert.equal(result.adjustedMaxRounds, 30);
  });

  it('isolates adaptation state between two sessions', () => {
    const A = 'sess-a';
    const B = 'sess-b';
    for (let i = 0; i < 3; i++) recordMalformedToolCall('json_parse_error', A);
    const resultA = computeAdaptation(A, 30);
    assert.equal(resultA.adjustedMaxRounds, 20);
    // Session B has no signals and must not be affected
    const resultB = computeAdaptation(B, 30);
    assert.equal(resultB.wasAdapted, false);
    assert.equal(resultB.adjustedMaxRounds, 30);
    resetAllFor(A);
    resetAllFor(B);
  });
});
