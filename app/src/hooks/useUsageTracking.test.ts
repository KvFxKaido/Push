import { describe, expect, it } from 'vitest';
import { parseUsageLog } from './useUsageTracking';

describe('parseUsageLog', () => {
  it('returns empty array for null input', () => {
    expect(parseUsageLog(null)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseUsageLog('{not-valid')).toEqual([]);
  });

  it('returns empty array when payload is not an array', () => {
    expect(parseUsageLog('{"timestamp":1}')).toEqual([]);
  });

  it('filters out malformed entries and keeps valid ones', () => {
    const raw = JSON.stringify([
      {
        timestamp: 1000,
        model: 'gemini-3-flash-preview',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      {
        timestamp: 2000,
        model: 'gemini-3-flash-preview',
        inputTokens: 1,
        outputTokens: 1,
      },
      {
        timestamp: Number.POSITIVE_INFINITY,
        model: 'gemini-3-flash-preview',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    ]);

    expect(parseUsageLog(raw)).toEqual([
      {
        timestamp: 1000,
        model: 'gemini-3-flash-preview',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    ]);
  });
});
