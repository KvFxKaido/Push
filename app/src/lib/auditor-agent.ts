/**
 * App compatibility wrapper for the shared Auditor agent.
 *
 * The canonical module now lives in `lib/auditor-agent.ts`. This wrapper keeps
 * the Web-side public API intact by resolving provider/model/runtime-memory
 * dependencies at the shell boundary.
 */

import {
  runAuditor as runAuditorLib,
  runAuditorEvaluation as runAuditorEvaluationLib,
  type AuditorEvaluationOptions as LibAuditorEvaluationOptions,
  type AuditorRunOptions as LibAuditorRunOptions,
} from '@push/lib/auditor-agent';
import { providerStreamFnToPushStream } from '@push/lib/provider-contract';
import type { LlmMessage, ProviderStreamFn, PushStream } from '@push/lib/provider-contract';
import type { AuditVerdictCardData, CoderWorkingMemory, MemoryScope } from '@/types';
import { getActiveProvider, getProviderStreamFn, type ActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';
import type { AuditorPromptContext } from './role-context';
import {
  buildAuditorEvaluationMemoryBlock,
  buildAuditorRuntimeContext,
} from './role-memory-context';
import type { AuditorFileContext } from './auditor-file-context';
import type { VerificationPolicy } from './verification-policy';

export type {
  AuditResult,
  AuditorFileContext,
  EvaluationResult,
  HookResult,
} from '@push/lib/auditor-agent';

export interface AuditorRunOptions {
  providerOverride?: ActiveProvider;
  modelOverride?: string | null;
}

function resolveAuditorProvider(options?: AuditorRunOptions): ActiveProvider {
  return options?.providerOverride || getActiveProvider();
}

function resolveAuditorModel(
  provider: ActiveProvider,
  options?: AuditorRunOptions,
): string | undefined {
  const override = options?.modelOverride?.trim();
  if (override) return override;
  if (provider === 'demo') return undefined;
  return getModelForRole(provider, 'auditor')?.id;
}

/**
 * Phase 6 of the PushStream gateway migration (see
 * `docs/decisions/PushStream Gateway Migration.md`): the Auditor iterates
 * `PushStreamEvent`s directly rather than going through the 12-arg
 * callback. Per-provider PushStream implementations aren't all ported yet,
 * so we bridge the existing `ProviderStreamFn` into a PushStream here.
 *
 * `streamOpenRouterChat` internally wraps `openrouterStream` with the
 * adapter; bridging it back yields a PushStream round-trip (events →
 * callbacks → events). Acceptable during migration — the cost is modest
 * for auditor-shaped workloads (single diff → JSON verdict), and keeping
 * one uniform bridge is simpler than dual-wiring a native openrouter path
 * just for the Auditor. Swap for direct `openrouterStream` usage once
 * every provider has a native PushStream (Phase 8).
 *
 * The wrapped PushStream is cached by underlying streamFn identity so
 * concurrent audits with the same provider see the same PushStream — keeps
 * `auditCoalesceKey` deduplication working across calls.
 */
const pushStreamCache = new WeakMap<ProviderStreamFn, PushStream<LlmMessage>>();
function resolveAuditorPushStream(provider: ActiveProvider): LibAuditorRunOptions['stream'] {
  if (provider === 'demo') return undefined;
  const streamFn = getProviderStreamFn(provider)
    .streamFn as unknown as ProviderStreamFn<LlmMessage>;
  let push = pushStreamCache.get(streamFn);
  if (!push) {
    push = providerStreamFnToPushStream(streamFn);
    pushStreamCache.set(streamFn, push);
  }
  return push;
}

export async function runAuditor(
  diff: string,
  onStatus: (phase: string) => void,
  context?: AuditorPromptContext,
  hookResult?: import('@push/lib/auditor-agent').HookResult | null,
  options?: AuditorRunOptions,
  fileContexts?: AuditorFileContext[],
): Promise<{ verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData }> {
  const provider = resolveAuditorProvider(options);
  return runAuditorLib(
    diff,
    {
      provider,
      stream: resolveAuditorPushStream(provider),
      modelId: resolveAuditorModel(provider, options),
      context,
      hookResult,
      fileContexts,
      resolveRuntimeContext: buildAuditorRuntimeContext,
    },
    onStatus,
  );
}

export async function runAuditorEvaluation(
  task: string,
  coderSummary: string,
  workingMemory: CoderWorkingMemory | null,
  diff: string | null,
  onStatus: (phase: string) => void,
  options?: AuditorRunOptions & {
    coderRounds?: number;
    coderMaxRounds?: number;
    criteriaResults?: { id: string; passed: boolean; output: string }[];
    verificationPolicy?: VerificationPolicy;
    memoryScope?: Pick<
      MemoryScope,
      'repoFullName' | 'branch' | 'chatId' | 'taskGraphId' | 'taskId'
    > | null;
  },
): Promise<import('@push/lib/auditor-agent').EvaluationResult> {
  const provider = resolveAuditorProvider(options);
  const stream = resolveAuditorPushStream(provider) as LibAuditorEvaluationOptions['stream'];
  return runAuditorEvaluationLib(
    task,
    coderSummary,
    workingMemory,
    diff,
    {
      provider,
      stream,
      modelId: resolveAuditorModel(provider, options),
      coderRounds: options?.coderRounds,
      coderMaxRounds: options?.coderMaxRounds,
      criteriaResults: options?.criteriaResults,
      verificationPolicy: options?.verificationPolicy,
      memoryScope: options?.memoryScope,
      resolveEvaluationMemoryBlock: buildAuditorEvaluationMemoryBlock,
    },
    onStatus,
  );
}
