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

export function recordContextMetric(input: ContextMetricInput): void {
  const provider = normalizeProvider(input.provider);
  const saved = Math.max(0, input.beforeTokens - input.afterTokens);
  const dropped = input.messagesDropped ?? 0;

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
}
