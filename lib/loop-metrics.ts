/**
 * loop-metrics.ts — in-memory observability for loop-detection verdicts.
 *
 * The near-duplicate ladder ships DARK (see `lib/loop-detection.ts` and
 * `docs/decisions/Loop Detection — Near-Duplicate Layer.md`): it computes a
 * verdict every turn but only enforces under `PUSH_LOOP_DETECTION=1`. This
 * aggregator records each verdict so we can answer the questions that gate
 * turning enforcement on:
 *
 *   - `darkSuppressed` — how often the ladder WOULD have acted (level is
 *     warn/block/compact/abort but action was suppressed because dark). This
 *     is the would-fire rate; pair it with `recent` to eyeball whether those
 *     were real loops or legitimate iterative edits (the false-positive read).
 *   - `byLevel` / `total` — the denominator (verdicts per turn) for rates.
 *
 * Shared in `lib/` because both the web round loop (`checkLoopBreaker`) and
 * the CLI engine compute the same verdict via the same oracle — the metric
 * belongs next to the policy, not mirrored per surface. Mirrors the in-memory
 * idiom of `cli/edit-metrics.ts` / `cli/context-metrics.ts`: per-scope
 * counters (scope = CLI `sessionId` / web `chatId`) with an aggregate view
 * when scope is omitted, so concurrent `pushd` sessions don't cross-talk.
 */

import type { LoopLevel } from './loop-detection.js';

/** Cap on retained recent samples per scope — bounded so a long run can't grow unbounded. */
export const MAX_RECENT_LOOP_VERDICTS = 50;

const GLOBAL_SCOPE = '__global__';

export interface LoopVerdictSample {
  surface: 'web' | 'cli';
  level: LoopLevel;
  action: LoopLevel;
  enforced: boolean;
  reasons: readonly string[];
  similarity?: number;
  round?: number;
  /** CLI `sessionId` / web `chatId`. Omitted samples land in the global scope. */
  scope?: string;
}

export interface RecordedLoopVerdict extends LoopVerdictSample {
  at: number;
}

export interface LoopMetrics {
  /** Every verdict recorded, including `none` — the per-turn denominator. */
  total: number;
  byLevel: Record<LoopLevel, number>;
  byAction: Record<LoopLevel, number>;
  /** Verdicts whose action actually fired (`action !== 'none'`). */
  enforcedActions: number;
  /** Non-`none` verdicts suppressed because the ladder was dark — the would-fire count. */
  darkSuppressed: number;
  /** Bounded chronological buffer of non-`none` verdicts for inspection. */
  recent: RecordedLoopVerdict[];
}

const metricsByScope = new Map<string, LoopMetrics>();

function zeroLevelMap(): Record<LoopLevel, number> {
  return { none: 0, warn: 0, block: 0, compact: 0, abort: 0 };
}

function zero(): LoopMetrics {
  return {
    total: 0,
    byLevel: zeroLevelMap(),
    byAction: zeroLevelMap(),
    enforcedActions: 0,
    darkSuppressed: 0,
    recent: [],
  };
}

function getOrCreate(scope: string | undefined): LoopMetrics {
  const key = scope ?? GLOBAL_SCOPE;
  let m = metricsByScope.get(key);
  if (!m) {
    m = zero();
    metricsByScope.set(key, m);
  }
  return m;
}

export function recordLoopVerdict(sample: LoopVerdictSample, now: number = Date.now()): void {
  const m = getOrCreate(sample.scope);
  m.total += 1;
  m.byLevel[sample.level] += 1;
  m.byAction[sample.action] += 1;
  if (sample.action !== 'none') {
    m.enforcedActions += 1;
  } else if (sample.level !== 'none') {
    m.darkSuppressed += 1;
  }
  if (sample.level !== 'none') {
    m.recent.push({ ...sample, reasons: [...sample.reasons], at: now });
    if (m.recent.length > MAX_RECENT_LOOP_VERDICTS) m.recent.shift();
  }
}

function clone(m: LoopMetrics): LoopMetrics {
  return {
    total: m.total,
    byLevel: { ...m.byLevel },
    byAction: { ...m.byAction },
    enforcedActions: m.enforcedActions,
    darkSuppressed: m.darkSuppressed,
    recent: m.recent.map((r) => ({ ...r, reasons: [...r.reasons] })),
  };
}

/** Metrics for one scope, or the aggregate across all scopes when omitted. */
export function getLoopMetrics(scope?: string): LoopMetrics {
  if (scope !== undefined) {
    const m = metricsByScope.get(scope);
    return m ? clone(m) : zero();
  }
  const total = zero();
  for (const m of metricsByScope.values()) {
    total.total += m.total;
    total.enforcedActions += m.enforcedActions;
    total.darkSuppressed += m.darkSuppressed;
    for (const level of Object.keys(total.byLevel) as LoopLevel[]) {
      total.byLevel[level] += m.byLevel[level];
      total.byAction[level] += m.byAction[level];
    }
    total.recent.push(...m.recent.map((r) => ({ ...r, reasons: [...r.reasons] })));
  }
  total.recent.sort((a, b) => a.at - b.at);
  if (total.recent.length > MAX_RECENT_LOOP_VERDICTS) {
    total.recent = total.recent.slice(-MAX_RECENT_LOOP_VERDICTS);
  }
  return total;
}

export function resetLoopMetrics(scope?: string): void {
  if (scope === undefined) {
    metricsByScope.clear();
    return;
  }
  metricsByScope.delete(scope);
}
