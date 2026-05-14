import { beforeEach, describe, expect, it } from 'vitest';
import {
  drainRecentContextMetrics,
  getContextMetrics,
  recordContextMetric,
  resetContextMetrics,
} from './context-metrics';

describe('context-metrics', () => {
  beforeEach(() => {
    resetContextMetrics();
  });

  it('records summarization events with cause', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 95000,
      afterTokens: 82000,
      provider: 'openrouter',
      cause: 'tool_output',
    });

    const snapshot = getContextMetrics();
    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.totalTokensSaved).toBe(13000);
    expect(snapshot.largestReduction).toBe(13000);
    expect(snapshot.maxContextSeen).toBe(95000);
    expect(snapshot.summarization.count).toBe(1);
    expect(snapshot.summarization.totalBefore).toBe(95000);
    expect(snapshot.summarization.totalAfter).toBe(82000);
    expect(snapshot.summarizationCauses.tool_output).toBe(1);
    expect(snapshot.summarizationCauses.long_message).toBe(0);
    expect(snapshot.byProvider.openrouter.count).toBe(1);
  });

  it('records digest drop events with messages dropped', () => {
    recordContextMetric({
      phase: 'digest_drop',
      beforeTokens: 120000,
      afterTokens: 85000,
      provider: 'openrouter',
      messagesDropped: 8,
    });

    const snapshot = getContextMetrics();
    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.totalTokensSaved).toBe(35000);
    expect(snapshot.digestDrop.count).toBe(1);
    expect(snapshot.digestDrop.messagesDropped).toBe(8);
    expect(snapshot.byProvider.openrouter.count).toBe(1);
  });

  it('records hard trim events', () => {
    recordContextMetric({
      phase: 'hard_trim',
      beforeTokens: 150000,
      afterTokens: 100000,
      provider: 'ollama',
      messagesDropped: 14,
    });

    const snapshot = getContextMetrics();
    expect(snapshot.hardTrim.count).toBe(1);
    expect(snapshot.hardTrim.messagesDropped).toBe(14);
    expect(snapshot.totalTokensSaved).toBe(50000);
    expect(snapshot.largestReduction).toBe(50000);
  });

  it('tracks maxContextSeen across multiple events', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 90000,
      afterTokens: 80000,
      provider: 'ollama',
    });
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 120000,
      afterTokens: 85000,
      provider: 'ollama',
    });
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 95000,
      afterTokens: 82000,
      provider: 'ollama',
    });

    const snapshot = getContextMetrics();
    expect(snapshot.maxContextSeen).toBe(120000);
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.largestReduction).toBe(35000);
  });

  it('accumulates across providers', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 90000,
      afterTokens: 80000,
      provider: 'openrouter',
    });
    recordContextMetric({
      phase: 'digest_drop',
      beforeTokens: 100000,
      afterTokens: 85000,
      provider: 'zen',
      messagesDropped: 4,
    });

    const snapshot = getContextMetrics();
    expect(snapshot.totalEvents).toBe(2);
    expect(snapshot.totalTokensSaved).toBe(25000);
    expect(snapshot.byProvider.openrouter.count).toBe(1);
    expect(snapshot.byProvider.zen.count).toBe(1);
    expect(snapshot.byProvider.zen.totalBefore).toBe(100000);
  });

  it('falls back to unknown-provider when provider is missing', () => {
    recordContextMetric({ phase: 'summarization', beforeTokens: 90000, afterTokens: 80000 });

    const snapshot = getContextMetrics();
    expect(snapshot.byProvider['unknown-provider'].count).toBe(1);
  });

  it('returns a defensive copy from getContextMetrics', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 90000,
      afterTokens: 80000,
      provider: 'ollama',
    });

    const snapshot = getContextMetrics();
    snapshot.totalEvents = 99;
    snapshot.byProvider.ollama.count = 42;
    snapshot.summarization.count = 77;

    const fresh = getContextMetrics();
    expect(fresh.totalEvents).toBe(1);
    expect(fresh.byProvider.ollama.count).toBe(1);
    expect(fresh.summarization.count).toBe(1);
  });

  it('resets all metrics', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 90000,
      afterTokens: 80000,
      provider: 'ollama',
      cause: 'mixed',
    });
    resetContextMetrics();

    const snapshot = getContextMetrics();
    expect(snapshot.totalEvents).toBe(0);
    expect(snapshot.totalTokensSaved).toBe(0);
    expect(snapshot.maxContextSeen).toBe(0);
    expect(snapshot.summarizationCauses.mixed).toBe(0);
    expect(Object.keys(snapshot.byProvider)).toHaveLength(0);
  });

  it('clamps negative savings to zero', () => {
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: 80000,
      afterTokens: 90000,
      provider: 'ollama',
    });

    const snapshot = getContextMetrics();
    expect(snapshot.totalTokensSaved).toBe(0);
    expect(snapshot.largestReduction).toBe(0);
  });

  describe('drainRecentContextMetrics', () => {
    beforeEach(() => {
      // Reset both the in-memory metrics and the drain buffer between tests.
      drainRecentContextMetrics();
    });

    it('returns recorded metrics in insertion order and empties the buffer', () => {
      recordContextMetric({
        phase: 'summarization',
        beforeTokens: 90_000,
        afterTokens: 60_000,
        provider: 'openrouter',
        cause: 'tool_output',
      });
      recordContextMetric({
        phase: 'hard_trim',
        beforeTokens: 100_000,
        afterTokens: 88_000,
        messagesDropped: 4,
      });

      const drained = drainRecentContextMetrics();
      expect(drained).toHaveLength(2);
      expect(drained[0].phase).toBe('summarization');
      expect(drained[1].phase).toBe('hard_trim');
      // Buffer is empty after a drain — consume-on-peek semantics.
      expect(drainRecentContextMetrics()).toEqual([]);
    });

    it('returns an empty array when nothing has been recorded', () => {
      expect(drainRecentContextMetrics()).toEqual([]);
    });

    it('discards the oldest entries when the FIFO cap is exceeded', () => {
      // The buffer is capped at MAX_PENDING_CONTEXT_METRICS (64). If a
      // consumer never drains, new entries displace the oldest rather
      // than growing without bound. Verify by overflowing the buffer
      // and asserting the surviving order is contiguous from the
      // overflow start. Copilot low-confidence on PR #545.
      const OVERFLOW = 80;
      for (let i = 0; i < OVERFLOW; i++) {
        recordContextMetric({
          phase: 'summarization',
          beforeTokens: 1000 + i,
          afterTokens: 500,
          cause: 'tool_output',
        });
      }
      const drained = drainRecentContextMetrics();
      expect(drained.length).toBeLessThanOrEqual(64);
      // The retained entries are the most recent ones — the oldest
      // (lowest beforeTokens) got shifted off.
      const firstBefore = drained[0].beforeTokens;
      const lastBefore = drained[drained.length - 1].beforeTokens;
      expect(lastBefore).toBe(1000 + OVERFLOW - 1);
      // Order is preserved within the retained window.
      expect(firstBefore).toBeLessThan(lastBefore);
      // Subsequent drains start empty.
      expect(drainRecentContextMetrics()).toEqual([]);
    });

    it('is cleared by resetContextMetrics', () => {
      // resetContextMetrics() must clear the drain buffer too — otherwise
      // tests that reset metrics between cases can still observe stale
      // compaction entries from before the reset.
      recordContextMetric({
        phase: 'summarization',
        beforeTokens: 90_000,
        afterTokens: 60_000,
        cause: 'tool_output',
      });
      resetContextMetrics();
      expect(drainRecentContextMetrics()).toEqual([]);
    });
  });
});
