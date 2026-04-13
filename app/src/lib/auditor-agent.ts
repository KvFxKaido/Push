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

function resolveAuditorStreamFn(provider: ActiveProvider): LibAuditorRunOptions['streamFn'] {
  if (provider === 'demo') return undefined;
  return getProviderStreamFn(provider).streamFn as unknown as LibAuditorRunOptions['streamFn'];
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
      streamFn: resolveAuditorStreamFn(provider),
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
  const streamFn =
    provider === 'demo'
      ? undefined
      : (getProviderStreamFn(provider)
          .streamFn as unknown as LibAuditorEvaluationOptions['streamFn']);
  return runAuditorEvaluationLib(
    task,
    coderSummary,
    workingMemory,
    diff,
    {
      provider,
      streamFn,
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
