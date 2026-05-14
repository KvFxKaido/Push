/**
 * Lightweight in-memory observability for context management operations.
 *
 * Tracks how often each compression phase fires, how many tokens are
 * saved, and which providers cause the most context pressure — all
 * without external dependencies or persistent storage.
 */

export type ContextPhase = 'summarization' | 'digest_drop' | 'hard_trim';

export type SummarizationCause = 'tool_output' | 'long_message' | 'mixed';

export interface ContextMetricInput {
  phase: ContextPhase;
  beforeTokens: number;
  afterTokens: number;
  provider?: string;
  messagesDropped?: number;
  cause?: SummarizationCause;
}

interface PhaseMetrics {
  count: number;
  totalBefore: number;
  totalAfter: number;
  messagesDropped: number;
}

interface ProviderContextMetrics {
  count: number;
  totalBefore: number;
  totalAfter: number;
}

export interface ContextMetrics {
  /** Total compression events across all phases */
  totalEvents: number;
  /** Total tokens reclaimed across all events */
  totalTokensSaved: number;
  /** Largest single-pass reduction */
  largestReduction: number;
  /** Highest context size seen before any compression */
  maxContextSeen: number;

  /** Per-phase breakdown */
  summarization: PhaseMetrics;
  digestDrop: PhaseMetrics;
  hardTrim: PhaseMetrics;

  /** Why summarization triggered */
  summarizationCauses: Record<SummarizationCause, number>;

  /** Per-provider breakdown */
  byProvider: Record<string, ProviderContextMetrics>;
}

function emptyPhaseMetrics(): PhaseMetrics {
  return { count: 0, totalBefore: 0, totalAfter: 0, messagesDropped: 0 };
}

function emptyCauseCounts(): Record<SummarizationCause, number> {
  return { tool_output: 0, long_message: 0, mixed: 0 };
}

function emptyMetrics(): ContextMetrics {
  return {
    totalEvents: 0,
    totalTokensSaved: 0,
    largestReduction: 0,
    maxContextSeen: 0,
    summarization: emptyPhaseMetrics(),
    digestDrop: emptyPhaseMetrics(),
    hardTrim: emptyPhaseMetrics(),
    summarizationCauses: emptyCauseCounts(),
    byProvider: {},
  };
}

let metrics: ContextMetrics = emptyMetrics();

function normalizeProvider(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || 'unknown-provider';
}

function phaseForInput(phase: ContextPhase): 'summarization' | 'digestDrop' | 'hardTrim' {
  if (phase === 'digest_drop') return 'digestDrop';
  if (phase === 'hard_trim') return 'hardTrim';
  return 'summarization';
}

/**
 * FIFO buffer of recent compaction events, drained by
 * `chat-stream-round` after each assistant turn so they can be
 * surfaced as `context.compaction` run events. Two notes:
 *
 *   - Module-level (not per-chat). The same buffer collects events
 *     from all concurrent chats. `chat-stream-round` drains it once
 *     per turn, attributing whatever's there to the current chat.
 *     Cross-chat misattribution is bounded and only happens when two
 *     chats stream concurrently AND one of them triggers compaction
 *     between the other's `streamChat` call and drain — rare enough
 *     that the per-chat plumbing it'd require isn't worth the
 *     complexity for this audit-trail use case.
 *   - The buffer is capped to prevent unbounded growth if a consumer
 *     never drains. New events past the cap displace the oldest.
 */
const MAX_PENDING_CONTEXT_METRICS = 64;
const _pendingContextMetrics: ContextMetricInput[] = [];

export function drainRecentContextMetrics(): ContextMetricInput[] {
  if (_pendingContextMetrics.length === 0) return [];
  const out = _pendingContextMetrics.slice();
  _pendingContextMetrics.length = 0;
  return out;
}

export function recordContextMetric(input: ContextMetricInput): void {
  const provider = normalizeProvider(input.provider);
  const saved = Math.max(0, input.beforeTokens - input.afterTokens);
  const dropped = input.messagesDropped ?? 0;

  // Push onto the drain buffer. `chat-stream-round` reads it after
  // each turn and emits a `context.compaction` run event per entry.
  _pendingContextMetrics.push(input);
  if (_pendingContextMetrics.length > MAX_PENDING_CONTEXT_METRICS) {
    _pendingContextMetrics.shift();
  }

  metrics.totalEvents++;
  metrics.totalTokensSaved += saved;
  metrics.largestReduction = Math.max(metrics.largestReduction, saved);
  metrics.maxContextSeen = Math.max(metrics.maxContextSeen, input.beforeTokens);

  // Phase bucket
  const phaseKey = phaseForInput(input.phase);
  const phase = metrics[phaseKey];
  phase.count++;
  phase.totalBefore += input.beforeTokens;
  phase.totalAfter += input.afterTokens;
  phase.messagesDropped += dropped;

  // Summarization cause
  if (input.phase === 'summarization' && input.cause) {
    metrics.summarizationCauses[input.cause]++;
  }

  // Provider bucket
  if (!metrics.byProvider[provider]) {
    metrics.byProvider[provider] = { count: 0, totalBefore: 0, totalAfter: 0 };
  }
  const providerMetrics = metrics.byProvider[provider];
  providerMetrics.count++;
  providerMetrics.totalBefore += input.beforeTokens;
  providerMetrics.totalAfter += input.afterTokens;

  console.debug(
    `[context] ${input.phase} provider=${provider} ${input.beforeTokens}→${input.afterTokens} tokens (saved ${saved})${dropped ? ` dropped=${dropped}` : ''}`,
  );
}

export function getContextMetrics(): ContextMetrics {
  const byProvider: Record<string, ProviderContextMetrics> = {};
  for (const [key, pm] of Object.entries(metrics.byProvider)) {
    byProvider[key] = { ...pm };
  }

  return {
    totalEvents: metrics.totalEvents,
    totalTokensSaved: metrics.totalTokensSaved,
    largestReduction: metrics.largestReduction,
    maxContextSeen: metrics.maxContextSeen,
    summarization: { ...metrics.summarization },
    digestDrop: { ...metrics.digestDrop },
    hardTrim: { ...metrics.hardTrim },
    summarizationCauses: { ...metrics.summarizationCauses },
    byProvider,
  };
}

export function resetContextMetrics(): void {
  metrics = emptyMetrics();
  // Clear the drain buffer too so tests that reset between cases can't
  // observe stale entries from prior cases. Copilot on PR #545.
  _pendingContextMetrics.length = 0;
}
