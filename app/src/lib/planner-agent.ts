/**
 * Planner Agent — web-side adapter around `lib/planner-core.ts`.
 *
 * Resolves the active web provider + model and delegates the decomposition
 * logic to the shared core. The prompt, schema, parsing, and formatting all
 * live in `lib/planner-core.ts` so CLI and web stay in sync.
 *
 * Design: fail-open. If the Planner fails, delegation proceeds without
 * a plan — the Coder's own internal planning takes over.
 */

import type { LlmMessage, PushStream } from '@push/lib/provider-contract';
import {
  getActiveProvider,
  isProviderAvailable,
  getProviderPushStream,
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
    stream: getProviderPushStream(activeProvider) as unknown as PushStream<LlmMessage>,
    provider: activeProvider,
    modelId,
    onStatus,
  });
}
