import { useState, useCallback, useEffect } from 'react';
import { loadUsageEntries, appendUsageEntry, clearUsageEntries } from '@/lib/usage-store';

// --- Parsing (exported for tests) ---

export function parseUsageLog(raw: string | null): UsageEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is UsageEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.timestamp === 'number' &&
        Number.isFinite(entry.timestamp) &&
        typeof entry.model === 'string' &&
        typeof entry.inputTokens === 'number' &&
        Number.isFinite(entry.inputTokens) &&
        typeof entry.outputTokens === 'number' &&
        Number.isFinite(entry.outputTokens) &&
        typeof entry.totalTokens === 'number' &&
        Number.isFinite(entry.totalTokens),
    );
  } catch {
    return [];
  }
}

// --- Types ---

export interface UsageEntry {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageStats {
  today: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number };
  thisWeek: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number };
  allTime: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number };
}

// --- Constants ---

// Rough token cost estimates (per 1M tokens) for visibility
// These are estimates — actual costs depend on the provider/plan
const COST_PER_1M_INPUT = 0.15;  // $0.15 per 1M input tokens
const COST_PER_1M_OUTPUT = 0.60; // $0.60 per 1M output tokens

// --- Stats calculation ---

function calculateStats(entries: UsageEntry[]): UsageStats {
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;

  const stats: UsageStats = {
    today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    thisWeek: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    allTime: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
  };

  for (const entry of entries) {
    // All time
    stats.allTime.inputTokens += entry.inputTokens;
    stats.allTime.outputTokens += entry.outputTokens;
    stats.allTime.totalTokens += entry.totalTokens;
    stats.allTime.requests += 1;

    // This week
    if (entry.timestamp >= weekStart) {
      stats.thisWeek.inputTokens += entry.inputTokens;
      stats.thisWeek.outputTokens += entry.outputTokens;
      stats.thisWeek.totalTokens += entry.totalTokens;
      stats.thisWeek.requests += 1;
    }

    // Today
    if (entry.timestamp >= todayStart) {
      stats.today.inputTokens += entry.inputTokens;
      stats.today.outputTokens += entry.outputTokens;
      stats.today.totalTokens += entry.totalTokens;
      stats.today.requests += 1;
    }
  }

  return stats;
}

// --- Estimate cost ---

export function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * COST_PER_1M_INPUT;
  const outputCost = (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT;
  return inputCost + outputCost;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `<$0.01`;
  }
  return `$${cost.toFixed(2)}`;
}

// --- Hook ---

export function useUsageTracking() {
  const [entries, setEntries] = useState<UsageEntry[]>([]);
  const [stats, setStats] = useState<UsageStats>(() => calculateStats([]));

  // Load entries from IndexedDB on mount
  useEffect(() => {
    loadUsageEntries().then((loaded) => {
      setEntries(loaded);
      setStats(calculateStats(loaded));
    });
  }, []);

  // Recalculate stats when entries change
  useEffect(() => {
    setStats(calculateStats(entries));
  }, [entries]);

  const trackUsage = useCallback((
    model: string,
    inputTokens: number,
    outputTokens: number,
  ) => {
    const entry: UsageEntry = {
      timestamp: Date.now(),
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    setEntries((prev) => [...prev, entry]);
    void appendUsageEntry(entry);
  }, []);

  const clearUsage = useCallback(() => {
    setEntries([]);
    void clearUsageEntries();
  }, []);

  const todayCost = estimateCost(stats.today.inputTokens, stats.today.outputTokens);
  const weekCost = estimateCost(stats.thisWeek.inputTokens, stats.thisWeek.outputTokens);
  const allTimeCost = estimateCost(stats.allTime.inputTokens, stats.allTime.outputTokens);

  return {
    stats,
    trackUsage,
    clearUsage,
    costs: {
      today: todayCost,
      thisWeek: weekCost,
      allTime: allTimeCost,
    },
    formatCost,
  };
}
