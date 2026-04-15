import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { computeAdaptation, collectAdaptationSignals, THRESHOLDS } from '../harness-adaptation.ts';
import { recordMalformedToolCall, resetToolCallMetrics } from '../tool-call-metrics.ts';
import { recordWriteFile, resetWriteFileMetrics } from '../edit-metrics.ts';
import { recordContextTrim, resetContextMetrics } from '../context-metrics.ts';

function resetAllMetrics() {
  resetToolCallMetrics();
  resetWriteFileMetrics();
  resetContextMetrics();
}

describe('collectAdaptationSignals', () => {
  beforeEach(() => {
    resetAllMetrics();
  });

  it('returns zero signals when nothing has been recorded', () => {
    const signals = collectAdaptationSignals();
    assert.equal(signals.malformedCallCount, 0);
    assert.equal(signals.contextPressureEvents, 0);
    assert.equal(signals.contextTokensSaved, 0);
    assert.equal(signals.editErrorRate, 0);
    assert.equal(signals.editStaleRate, 0);
  });

  it('accumulates malformed tool calls across reason strings', () => {
    recordMalformedToolCall('json_parse_error');
    recordMalformedToolCall('json_parse_error');
    recordMalformedToolCall('missing_tool');
    const signals = collectAdaptationSignals();
    assert.equal(signals.malformedCallCount, 3);
  });

  it('computes edit error and stale rates from write metrics', () => {
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: true, stale: true });
    const signals = collectAdaptationSignals();
    assert.equal(signals.editErrorRate, 0.25);
    assert.equal(signals.editStaleRate, 0.25);
  });

  it('counts context compression events and tokens saved', () => {
    recordContextTrim({ trimmed: true, beforeTokens: 1000, afterTokens: 500 });
    recordContextTrim({ trimmed: false });
    recordContextTrim({ trimmed: true, beforeTokens: 800, afterTokens: 600 });
    const signals = collectAdaptationSignals();
    assert.equal(signals.contextPressureEvents, 2);
    assert.equal(signals.contextTokensSaved, 700);
  });

  it('ignores trims with missing before/after tokens', () => {
    recordContextTrim({ trimmed: true });
    const signals = collectAdaptationSignals();
    assert.equal(signals.contextPressureEvents, 1);
    assert.equal(signals.contextTokensSaved, 0);
  });
});

describe('computeAdaptation', () => {
  beforeEach(() => {
    resetAllMetrics();
  });

  it('does not adapt when no signals have been recorded', () => {
    const result = computeAdaptation(30);
    assert.equal(result.wasAdapted, false);
    assert.equal(result.adjustedMaxRounds, 30);
    assert.deepEqual(result.reasons, []);
  });

  it('shrinks to 20 when malformed count reaches threshold', () => {
    for (let i = 0; i < THRESHOLDS.MALFORMED_CALL_ESCALATION; i++) {
      recordMalformedToolCall('json_parse_error');
    }
    const result = computeAdaptation(30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 20);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /malformed tool calls/);
  });

  it('does not re-shrink once max rounds has already reached 20 from malformed rule', () => {
    for (let i = 0; i < 5; i++) recordMalformedToolCall('json_parse_error');
    const first = computeAdaptation(30);
    assert.equal(first.adjustedMaxRounds, 20);
    const second = computeAdaptation(first.adjustedMaxRounds);
    assert.equal(second.wasAdapted, false);
    assert.equal(second.adjustedMaxRounds, 20);
  });

  it('shrinks by 5 when edit error rate crosses the 25 percent threshold', () => {
    recordWriteFile({ error: true, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    const result = computeAdaptation(30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 25);
    assert.match(result.reasons[0], /edit error rate/);
  });

  it('floors edit-error-rate reduction at 15', () => {
    recordWriteFile({ error: true, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    const result = computeAdaptation(16);
    assert.equal(result.adjustedMaxRounds, 15);
  });

  it('applies both rules sequentially when both signals escalate', () => {
    for (let i = 0; i < 3; i++) recordMalformedToolCall('json_parse_error');
    recordWriteFile({ error: true, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    recordWriteFile({ error: false, stale: false });
    const result = computeAdaptation(30);
    assert.equal(result.wasAdapted, true);
    assert.equal(result.adjustedMaxRounds, 15);
    assert.equal(result.reasons.length, 2);
  });

  it('never raises the ceiling above the provided current value', () => {
    const result = computeAdaptation(15);
    assert.equal(result.adjustedMaxRounds, 15);
    assert.equal(result.wasAdapted, false);
  });
});
