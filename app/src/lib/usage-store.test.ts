import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UsageEntry } from '@/hooks/useUsageTracking';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAll = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);

vi.mock('./app-db', () => ({
  STORE: { usageLog: 'usage_log' },
  getAll: (...args: unknown[]) => mockGetAll(...(args as [])),
  put: vi.fn().mockResolvedValue(1),
  clear: vi.fn().mockResolvedValue(undefined),
  putMany: vi.fn().mockResolvedValue(undefined),
}));

let fakeStorage: Record<string, string> = {};

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => fakeStorage[key] ?? null,
  safeStorageRemove: (key: string) => {
    delete fakeStorage[key];
  },
}));

const { loadUsageEntries } = await import('./usage-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    timestamp: Date.now(),
    model: 'gpt-4',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeStorage = {};
  mockGetAll.mockResolvedValue([]);
});

describe('loadUsageEntries — legacy validation', () => {
  it('accepts valid legacy entries', async () => {
    const entry = validEntry();
    fakeStorage['push_usage_log'] = JSON.stringify([entry]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('gpt-4');
  });

  it('rejects entries missing inputTokens', async () => {
    const bad = { timestamp: 1000, model: 'gpt-4', outputTokens: 5, totalTokens: 5 };
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('rejects entries missing outputTokens', async () => {
    const bad = { timestamp: 1000, model: 'gpt-4', inputTokens: 5, totalTokens: 5 };
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('rejects entries missing totalTokens', async () => {
    const bad = { timestamp: 1000, model: 'gpt-4', inputTokens: 5, outputTokens: 5 };
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('rejects entries with Infinity token values', async () => {
    const bad = validEntry({ inputTokens: Infinity });
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('rejects entries with NaN token values', async () => {
    const bad = validEntry({ outputTokens: NaN });
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('rejects entries with non-finite timestamp', async () => {
    const bad = validEntry({ timestamp: Infinity });
    fakeStorage['push_usage_log'] = JSON.stringify([bad]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('keeps valid entries and filters out malformed ones in a mixed array', async () => {
    const good = validEntry({ model: 'claude' });
    const missingTokens = { timestamp: 1000, model: 'gpt-4' };
    const infTokens = validEntry({ model: 'bad', totalTokens: Infinity });

    fakeStorage['push_usage_log'] = JSON.stringify([good, missingTokens, infTokens]);

    const result = await loadUsageEntries();
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('claude');
  });

  it('returns empty array for invalid JSON', async () => {
    fakeStorage['push_usage_log'] = '{broken';
    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });

  it('returns empty array for non-array JSON', async () => {
    fakeStorage['push_usage_log'] = '{"not": "array"}';
    const result = await loadUsageEntries();
    expect(result).toHaveLength(0);
  });
});
