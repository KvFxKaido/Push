/** Web-shell storage for the shared malformed-tool metric reducer. */

import {
  cloneMalformedToolCallMetrics,
  createMalformedToolCallMetrics,
  reduceMalformedToolCallMetric,
  type MalformedToolCallMetrics as SharedMalformedToolCallMetrics,
  type MalformedToolMetricRecord,
} from '@push/lib/malformed-tool-metrics';

export type MalformedToolCallReason =
  | 'truncated'
  | 'validation_failed'
  | 'malformed_json'
  | 'natural_language_intent';

export type MalformedToolCallMetricInput = MalformedToolMetricRecord<MalformedToolCallReason>;
export type MalformedToolCallMetrics = SharedMalformedToolCallMetrics<MalformedToolCallReason>;

const REASONS: readonly MalformedToolCallReason[] = [
  'truncated',
  'validation_failed',
  'malformed_json',
  'natural_language_intent',
];

let metrics = createMalformedToolCallMetrics(REASONS);

export function recordMalformedToolCallMetric(input: MalformedToolCallMetricInput): void {
  metrics = reduceMalformedToolCallMetric(metrics, input);
  const provider = input.provider?.trim() || 'unknown-provider';
  const model = input.model?.trim() || 'unknown-model';
  const tool = input.toolName?.trim() || 'unknown-tool';
  console.debug(
    `[tool-call] malformed provider=${provider} model=${model} reason=${input.reason} tool=${tool}`,
  );
}

export function getMalformedToolCallMetrics(): MalformedToolCallMetrics {
  return cloneMalformedToolCallMetrics(metrics);
}

export function resetMalformedToolCallMetrics(): void {
  metrics = createMalformedToolCallMetrics(REASONS);
}
