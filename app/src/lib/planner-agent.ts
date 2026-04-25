/**
 * Planner Agent — web-side adapter around `lib/planner-core.ts`.
 *
 * Resolves the active web provider + model and delegates the decomposition
 * logic to the shared core. Phase 6 of the PushStream gateway migration
 * moved the Planner off its custom `PlannerStreamFn` adapter shape — the
 * core now consumes `PushStream<LlmMessage>` events directly. The prompt,
 * schema, parsing, and formatting still live in `lib/planner-core.ts` so
 * CLI and web stay in sync.
 *
 * Design: fail-open. If the Planner fails, delegation proceeds without
 * a plan — the Coder's own internal planning takes over.
 */

import {
  providerStreamFnToPushStream,
  type LlmMessage,
  type ProviderStreamFn,
  type PushStream,
} from '@push/lib/provider-contract';
import {
  getActiveProvider,
  isProviderAvailable,
  getProviderStreamFn,
  type ActiveProvider,
} from './orchestrator';
import { resolveProviderSpecificModel } from './provider-selection';
import { getModelForRole } from './providers';
import {
  runPlannerCore,
  formatPlannerBrief,
  type PlannerFeature,
  type PlannerFeatureList,
} from '@push/lib/planner-core';

export { formatPlannerBrief };
export type { PlannerFeature, PlannerFeatureList };

/**
 * Bridged-PushStream cache, keyed by underlying `ProviderStreamFn` identity.
 * Mirrors the Auditor wrapper pattern — the Planner has no coalescing today,
 * but keeping the cache means concurrent calls for the same provider see
 * the same `PushStream` object. Once every provider has a native PushStream
 * (Phase 8 / 9), the bridge is deletable and this cache can move with it.
 */
const pushStreamCache = new WeakMap<ProviderStreamFn, PushStream<LlmMessage>>();
function resolvePlannerPushStream(provider: ActiveProvider): PushStream<LlmMessage> {
  const streamFn = getProviderStreamFn(provider)
    .streamFn as unknown as ProviderStreamFn<LlmMessage>;
  let push = pushStreamCache.get(streamFn);
  if (!push) {
    push = providerStreamFnToPushStream(streamFn);
    pushStreamCache.set(streamFn, push);
  }
  return push;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface PlannerOptions {
  providerOverride?: ActiveProvider;
  modelOverride?: string | null;
}

/**
 * Run the planner pre-pass to decompose a task into features.
 * Returns null on any failure (fail-open — Coder proceeds without a plan).
 */
export async function runPlanner(
  task: string,
  files: string[],
  onStatus: (phase: string) => void,
  options?: PlannerOptions,
): Promise<PlannerFeatureList | null> {
  const requestedProvider =
    options?.providerOverride && isProviderAvailable(options.providerOverride)
      ? options.providerOverride
      : null;
  const activeProvider = requestedProvider || getActiveProvider();
  if (activeProvider === 'demo') return null;

  const roleModel = getModelForRole(activeProvider, 'coder'); // Planner uses the same model slot as Coder
  const modelId =
    resolveProviderSpecificModel(
      activeProvider,
      options?.modelOverride,
      options?.providerOverride,
    ) || roleModel?.id;

  return runPlannerCore({
    task,
    files,
    stream: resolvePlannerPushStream(activeProvider),
    provider: activeProvider,
    modelId,
    onStatus,
  });
}
