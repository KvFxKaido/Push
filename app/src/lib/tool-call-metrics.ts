/**
 * Lightweight in-memory observability for malformed tool-call attempts.
 *
 * Captures failure reasons by provider/model so we can compare
 * tool-call compliance across backends without external telemetry.
 */

export type MalformedToolCallReason = 'truncated' | 'validation_failed' | 'malformed_json';

export interface MalformedToolCallMetricInput {
  provider?: string;
  model?: string;
  reason: MalformedToolCallReason;
  toolName?: string | null;
}

interface ReasonCounts {
  truncated: number;
  validation_failed: number;
  malformed_json: number;
}

interface ModelMalformedMetrics {
  count: number;
  reasons: ReasonCounts;
  byTool: Record<string, number>;
}

interface ProviderMalformedMetrics {
  count: number;
  reasons: ReasonCounts;
  byModel: Record<string, ModelMalformedMetrics>;
}

export interface MalformedToolCallMetrics {
  count: number;
  reasons: ReasonCounts;
  byProvider: Record<string, ProviderMalformedMetrics>;
}

function emptyReasonCounts(): ReasonCounts {
  return {
    truncated: 0,
    validation_failed: 0,
    malformed_json: 0,
  };
}

function emptyModelMetrics(): ModelMalformedMetrics {
  return {
    count: 0,
    reasons: emptyReasonCounts(),
    byTool: {},
  };
}

function emptyProviderMetrics(): ProviderMalformedMetrics {
  return {
    count: 0,
    reasons: emptyReasonCounts(),
    byModel: {},
  };
}

let metrics: MalformedToolCallMetrics = {
  count: 0,
  reasons: emptyReasonCounts(),
  byProvider: {},
};

function normalizeLabel(value: string | undefined | null, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

export function recordMalformedToolCallMetric(input: MalformedToolCallMetricInput): void {
  const provider = normalizeLabel(input.provider, 'unknown-provider');
  const model = normalizeLabel(input.model, 'unknown-model');
  const tool = normalizeLabel(input.toolName ?? undefined, 'unknown-tool');

  metrics.count++;
  metrics.reasons[input.reason]++;

  if (!metrics.byProvider[provider]) {
    metrics.byProvider[provider] = emptyProviderMetrics();
  }
  const providerMetrics = metrics.byProvider[provider];
  providerMetrics.count++;
  providerMetrics.reasons[input.reason]++;

  if (!providerMetrics.byModel[model]) {
    providerMetrics.byModel[model] = emptyModelMetrics();
  }
  const modelMetrics = providerMetrics.byModel[model];
  modelMetrics.count++;
  modelMetrics.reasons[input.reason]++;
  modelMetrics.byTool[tool] = (modelMetrics.byTool[tool] || 0) + 1;

  console.debug(`[tool-call] malformed provider=${provider} model=${model} reason=${input.reason} tool=${tool}`);
}

export function getMalformedToolCallMetrics(): MalformedToolCallMetrics {
  const byProvider: Record<string, ProviderMalformedMetrics> = {};
  for (const [provider, providerMetrics] of Object.entries(metrics.byProvider)) {
    const byModel: Record<string, ModelMalformedMetrics> = {};
    for (const [model, modelMetrics] of Object.entries(providerMetrics.byModel)) {
      byModel[model] = {
        count: modelMetrics.count,
        reasons: { ...modelMetrics.reasons },
        byTool: { ...modelMetrics.byTool },
      };
    }

    byProvider[provider] = {
      count: providerMetrics.count,
      reasons: { ...providerMetrics.reasons },
      byModel,
    };
  }

  return {
    count: metrics.count,
    reasons: { ...metrics.reasons },
    byProvider,
  };
}

export function resetMalformedToolCallMetrics(): void {
  metrics = {
    count: 0,
    reasons: emptyReasonCounts(),
    byProvider: {},
  };
}
