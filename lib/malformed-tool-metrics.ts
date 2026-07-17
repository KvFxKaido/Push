export interface MalformedToolMetricRecord<TReason extends string = string> {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly reason: TReason;
  readonly toolName?: string | null;
}

export interface ModelMalformedMetrics<TReason extends string = string> {
  count: number;
  reasons: Record<TReason, number>;
  byTool: Record<string, number>;
}

export interface ProviderMalformedMetrics<TReason extends string = string> {
  count: number;
  reasons: Record<TReason, number>;
  byModel: Record<string, ModelMalformedMetrics<TReason>>;
}

export interface MalformedToolCallMetrics<TReason extends string = string> {
  count: number;
  reasons: Record<TReason, number>;
  byProvider: Record<string, ProviderMalformedMetrics<TReason>>;
}

function normalizeLabel(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function reasonCounts<TReason extends string>(
  reasons: readonly TReason[],
): Record<TReason, number> {
  return Object.fromEntries(reasons.map((reason) => [reason, 0])) as Record<TReason, number>;
}

export function createMalformedToolCallMetrics<TReason extends string>(
  reasons: readonly TReason[] = [],
): MalformedToolCallMetrics<TReason> {
  return { count: 0, reasons: reasonCounts(reasons), byProvider: {} };
}

export function cloneMalformedToolCallMetrics<TReason extends string>(
  state: MalformedToolCallMetrics<TReason>,
): MalformedToolCallMetrics<TReason> {
  return {
    count: state.count,
    reasons: { ...state.reasons },
    byProvider: Object.fromEntries(
      Object.entries(state.byProvider).map(([provider, providerState]) => [
        provider,
        {
          count: providerState.count,
          reasons: { ...providerState.reasons },
          byModel: Object.fromEntries(
            Object.entries(providerState.byModel).map(([model, modelState]) => [
              model,
              {
                count: modelState.count,
                reasons: { ...modelState.reasons },
                byTool: { ...modelState.byTool },
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

export function reduceMalformedToolCallMetric<TReason extends string>(
  state: MalformedToolCallMetrics<TReason>,
  input: MalformedToolMetricRecord<TReason>,
): MalformedToolCallMetrics<TReason> {
  const next = cloneMalformedToolCallMetrics(state);
  const provider = normalizeLabel(input.provider, 'unknown-provider');
  const model = normalizeLabel(input.model, 'unknown-model');
  const tool = normalizeLabel(input.toolName, 'unknown-tool');
  next.count += 1;
  next.reasons[input.reason] = (next.reasons[input.reason] ?? 0) + 1;
  const providerState = (next.byProvider[provider] ??= {
    count: 0,
    reasons: reasonCounts(Object.keys(next.reasons) as TReason[]),
    byModel: {},
  });
  providerState.count += 1;
  providerState.reasons[input.reason] = (providerState.reasons[input.reason] ?? 0) + 1;
  const modelState = (providerState.byModel[model] ??= {
    count: 0,
    reasons: reasonCounts(Object.keys(next.reasons) as TReason[]),
    byTool: {},
  });
  modelState.count += 1;
  modelState.reasons[input.reason] = (modelState.reasons[input.reason] ?? 0) + 1;
  modelState.byTool[tool] = (modelState.byTool[tool] ?? 0) + 1;
  return next;
}

export function mergeMalformedToolCallMetrics<TReason extends string>(
  states: readonly MalformedToolCallMetrics<TReason>[],
): MalformedToolCallMetrics<TReason> {
  const allReasons = [
    ...new Set(states.flatMap((state) => Object.keys(state.reasons))),
  ] as TReason[];
  const merged = createMalformedToolCallMetrics<TReason>(allReasons);
  for (const state of states) {
    merged.count += state.count;
    for (const [reason, count] of Object.entries(state.reasons) as Array<[string, number]>) {
      merged.reasons[reason as TReason] = (merged.reasons[reason as TReason] ?? 0) + count;
    }
    for (const [provider, sourceProvider] of Object.entries(state.byProvider)) {
      const targetProvider = (merged.byProvider[provider] ??= {
        count: 0,
        reasons: reasonCounts(allReasons),
        byModel: {},
      });
      targetProvider.count += sourceProvider.count;
      for (const [reason, count] of Object.entries(sourceProvider.reasons) as Array<
        [string, number]
      >) {
        targetProvider.reasons[reason as TReason] =
          (targetProvider.reasons[reason as TReason] ?? 0) + count;
      }
      for (const [model, sourceModel] of Object.entries(sourceProvider.byModel)) {
        const targetModel = (targetProvider.byModel[model] ??= {
          count: 0,
          reasons: reasonCounts(allReasons),
          byTool: {},
        });
        targetModel.count += sourceModel.count;
        for (const [reason, count] of Object.entries(sourceModel.reasons) as Array<
          [string, number]
        >) {
          targetModel.reasons[reason as TReason] =
            (targetModel.reasons[reason as TReason] ?? 0) + count;
        }
        for (const [toolName, count] of Object.entries(sourceModel.byTool)) {
          targetModel.byTool[toolName] = (targetModel.byTool[toolName] ?? 0) + count;
        }
      }
    }
  }
  return merged;
}
