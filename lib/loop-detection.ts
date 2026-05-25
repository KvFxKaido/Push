/**
 * Loop / repetition detection kernel — the single policy oracle that maps
 * loop *signals* (exact repeated calls, near-duplicate writes) to a graded
 * *verdict* (none → warn → block → compact → abort). Shared by the web and
 * CLI round loops so the two surfaces can't re-grow divergent ad-hoc
 * breakers (the CLI previously owned a bespoke `repeatedCalls` batch map in
 * `cli/engine.ts`; the web path owns the exact-match `MutationFailureTracker`
 * in `lib/agent-loop-utils.ts`).
 *
 * Borrowed from Pi-forge's `loop-guard`: a model can dodge an exact-match
 * breaker by re-writing the same file with trivially different content each
 * round (reordered object keys, a renamed local, whitespace). The byte-keyed
 * breaker never trips; a per-path content-similarity check (Jaccard over a
 * tokenized sliding window) catches it. See
 * `docs/decisions/Loop Detection — Near-Duplicate Layer.md`.
 *
 * Rollout discipline: the near-duplicate ladder is DARK by default. When
 * `similarityEnforced` is false, `evaluateLoopState` still computes and
 * reports the similarity `level` (so callers can log/measure it) but never
 * lets it drive `action`. The exact-match breaker is NOT gated — it is the
 * existing behavior being relocated, so it always contributes to `action`.
 */

// ---------------------------------------------------------------------------
// Tunables. These numbers are load-bearing and unvalidated for frontier
// models (Pi-forge tuned them for 35B-at-Q2). Keep them here, co-located,
// and treat them as measurement targets — not settled constants.
// ---------------------------------------------------------------------------

/** Jaccard score at/above which two writes count as "near-duplicate". */
export const SIMILARITY_THRESHOLD = 0.85;
/** Per-path sliding window: how many recent writes a new write is compared to. */
export const SIMILARITY_WINDOW = 10;
/** Near-duplicate streak length that triggers a `warn`. */
export const SIMILARITY_WARN_HITS = 4;
/** Near-duplicate streak length that triggers a `block`. */
export const SIMILARITY_BLOCK_HITS = 6;
/** Number of `block`s in a run before escalating to `compact`. */
export const BLOCKS_BEFORE_COMPACT = 3;
/** Exact repeated-call count that triggers `abort` (the relocated breaker). */
export const EXACT_REPEAT_LIMIT = 3;
/** Cap on token-set size so a giant generated file can't blow memory. */
export const MAX_TOKENS_PER_WRITE = 4000;

// ---------------------------------------------------------------------------
// Tokenization + similarity (pure)
// ---------------------------------------------------------------------------

/**
 * Reduce content to a set of lowercase word tokens. Punctuation and
 * whitespace are split out, so reformatting, reordered object keys, and
 * trailing-comma churn collapse to the same set; a renamed identifier
 * changes exactly one token. Set semantics (not multiset) intentionally
 * ignore repeat counts — we're detecting "the model keeps writing roughly
 * the same thing", not measuring exact textual distance.
 */
export function tokenize(content: string, maxTokens: number = MAX_TOKENS_PER_WRITE): Set<string> {
  const set = new Set<string>();
  if (!content) return set;
  for (const part of content.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (!part) continue;
    set.add(part);
    if (set.size >= maxTokens) break;
  }
  return set;
}

/**
 * Jaccard similarity `|A∩B| / |A∪B|`. Two empty sets are identical (1);
 * one empty against a non-empty is disjoint (0).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Per-path near-duplicate detector (stateful, one instance per run)
// ---------------------------------------------------------------------------

export interface SimilarityObservation {
  /** Best Jaccard score of this write against the path's prior window (0..1). */
  similarity: number;
  /**
   * Length of the current run of near-duplicate writes to this path,
   * counting writes (not gaps). The first write to a path is `1`; each
   * subsequent write whose `similarity >= threshold` increments the run; a
   * below-threshold write resets it to `1`. So `streak >= SIMILARITY_WARN_HITS`
   * means "this path has now seen N writes in a row that barely changed".
   */
  streak: number;
}

export interface SimilarityLoopDetector {
  /** Record a write and return its similarity + current near-duplicate streak. */
  observeWrite(path: string, content: string): SimilarityObservation;
  /** Best similarity of `content` vs the path's window WITHOUT recording it. */
  peekSimilarity(path: string, content: string): number;
  clear(): void;
}

export interface SimilarityLoopDetectorOptions {
  threshold?: number;
  window?: number;
  maxTokens?: number;
}

export function createSimilarityLoopDetector(
  options: SimilarityLoopDetectorOptions = {},
): SimilarityLoopDetector {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const windowSize = options.window ?? SIMILARITY_WINDOW;
  const maxTokens = options.maxTokens ?? MAX_TOKENS_PER_WRITE;

  const windows = new Map<string, Set<string>[]>();
  const streaks = new Map<string, number>();

  const maxAgainstWindow = (key: string, tokens: Set<string>): number => {
    const win = windows.get(key);
    if (!win || win.length === 0) return 0;
    let max = 0;
    for (const prev of win) {
      const score = jaccard(tokens, prev);
      if (score > max) max = score;
    }
    return max;
  };

  return {
    observeWrite(path, content) {
      const key = path.trim();
      const tokens = tokenize(content, maxTokens);
      const similarity = maxAgainstWindow(key, tokens);

      const prevStreak = streaks.get(key) ?? 0;
      const streak = similarity >= threshold ? Math.max(prevStreak, 1) + 1 : 1;
      streaks.set(key, streak);

      const win = windows.get(key) ?? [];
      win.push(tokens);
      if (win.length > windowSize) win.shift();
      windows.set(key, win);

      return { similarity, streak };
    },
    peekSimilarity(path, content) {
      return maxAgainstWindow(path.trim(), tokenize(content, maxTokens));
    },
    clear() {
      windows.clear();
      streaks.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict policy (pure) — the single oracle both surfaces call
// ---------------------------------------------------------------------------

export type LoopLevel = 'none' | 'warn' | 'block' | 'compact' | 'abort';

const LEVEL_ORDER: readonly LoopLevel[] = ['none', 'warn', 'block', 'compact', 'abort'];

function strongest(levels: readonly LoopLevel[]): LoopLevel {
  let max: LoopLevel = 'none';
  for (const level of levels) {
    if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(max)) max = level;
  }
  return max;
}

export interface LoopSignals {
  /** Exact repeated-call signal — the relocated, always-enforced breaker. */
  exactRepeat?: { count: number; limit?: number };
  /** Near-duplicate write signal from `SimilarityLoopDetector.observeWrite`. */
  similarity?: { value: number; streak: number };
  /** How many `block`s have already been issued this run (for compact escalation). */
  blocksIssued?: number;
  /** When false (default), similarity-derived levels are computed but NOT enforced. */
  similarityEnforced?: boolean;
}

export interface LoopVerdict {
  /** Strongest severity the signals indicate, regardless of enforcement. */
  level: LoopLevel;
  /** What to actually do now: the strongest *enforceable* level. */
  action: LoopLevel;
  /** Human-readable explanations for each contributing signal. */
  reasons: string[];
  /** Best near-duplicate similarity seen, if a similarity signal was supplied. */
  similarity?: number;
  /** Whether the similarity ladder was enforced for this verdict. */
  enforced: boolean;
}

/**
 * Combine loop signals into a verdict. Exact repeated calls always
 * contribute to `action` (existing behavior); the near-duplicate ladder
 * contributes to `action` only when `similarityEnforced` is true, but always
 * contributes to the reported `level` so callers can measure it dark.
 */
export function evaluateLoopState(signals: LoopSignals): LoopVerdict {
  const enforced = signals.similarityEnforced ?? false;
  const reasons: string[] = [];
  const contributions: { level: LoopLevel; enforceable: boolean }[] = [];

  if (signals.exactRepeat) {
    const limit = signals.exactRepeat.limit ?? EXACT_REPEAT_LIMIT;
    if (signals.exactRepeat.count >= limit) {
      reasons.push(`exact tool call repeated ${signals.exactRepeat.count}x (limit ${limit})`);
      contributions.push({ level: 'abort', enforceable: true });
    }
  }

  if (signals.similarity && signals.similarity.streak >= SIMILARITY_WARN_HITS) {
    const { value, streak } = signals.similarity;
    let simLevel: LoopLevel = 'warn';
    if (streak >= SIMILARITY_BLOCK_HITS) {
      const blocks = (signals.blocksIssued ?? 0) + 1;
      simLevel = blocks >= BLOCKS_BEFORE_COMPACT ? 'compact' : 'block';
    }
    reasons.push(
      `near-duplicate writes streak ${streak} at ${Math.round(value * 100)}% similarity`,
    );
    contributions.push({ level: simLevel, enforceable: enforced });
  }

  return {
    level: strongest(contributions.map((c) => c.level)),
    action: strongest(contributions.filter((c) => c.enforceable).map((c) => c.level)),
    reasons,
    similarity: signals.similarity?.value,
    enforced,
  };
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

/**
 * Extract the `{ path, content }` a write/edit tool call targets, or null if
 * the call isn't a file write. Recognizes `write_file` (`path` + `content`)
 * and `edit_file` (`path` + `new_string`); the edit form tokenizes the
 * replacement text, which is where repetition shows.
 */
export function writeTargetOf(
  args: Record<string, unknown> | undefined,
): { path: string; content: string } | null {
  if (!args) return null;
  const path =
    typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : null;
  if (!path) return null;
  if (typeof args.content === 'string') return { path, content: args.content };
  if (typeof args.new_string === 'string') return { path, content: args.new_string };
  if (typeof args.newString === 'string') return { path, content: args.newString };
  return null;
}

/**
 * Kill-switch for the near-duplicate ladder. Opt-IN for the dark rollout:
 * enforcement only turns on with `PUSH_LOOP_DETECTION=1`. Guarded for
 * runtimes without `process` (Cloudflare Worker).
 */
export function isSimilarityLoopDetectionEnabled(
  env?: Record<string, string | undefined>,
): boolean {
  const resolved = env ?? (typeof process !== 'undefined' ? process.env : undefined);
  return resolved?.PUSH_LOOP_DETECTION === '1';
}
