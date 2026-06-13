/**
 * App compatibility wrapper for the shared Coder agent.
 *
 * The canonical kernel lives in `lib/coder-agent.ts` (Phase 5D step 2);
 * the browser bindings assembly (capability ledger, turn policy, tool
 * exec/detectors over web services, memory tools, file/symbol ledgers)
 * lives in `./inline-coder-run.ts`'s `runInPageCoderKernel` — extracted
 * there for the Inline Foreground Lane so the delegated arc and the
 * inline lane run the kernel through one assembly point (see
 * `docs/archive/decisions/Inline Foreground Lane — Local While Watched.md`).
 *
 * This wrapper preserves the Web-side public API so existing call sites
 * (`coder-delegation-handler.ts`, `task-graph-delegation-handler.ts`,
 * `coder-agent.test.ts`, `delegation-handoff.integration.test.ts`) keep
 * working unchanged. What remains here is the delegated-arc-specific
 * surface the inline lane deliberately skips:
 *
 *  - signature normalization (envelope form and legacy positional form)
 *  - provider/model resolution (`getActiveProvider`, `getModelForRole`)
 *    + the `'demo'` provider guard
 *  - delegation-brief task preamble (`buildCoderDelegationBrief` +
 *    planner brief + flagged-file preload)
 */

import type {
  AcceptanceCriterion,
  DelegationEnvelope,
  CoderCallbacks,
  CoderResult,
  HarnessProfileSettings,
} from '@/types';
import {
  shouldInjectCoderStateOnToolResult,
  summarizeCoderStateForHandoff,
  type CoderAgentOptions,
  type CoderAfterModelResult,
  type CoderToolExecResult,
} from '@push/lib/coder-agent';
import {
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  invalidateObservationDependencies,
} from '@push/lib/working-memory';
import { normalizeTrimmedRoleAlternation } from '@push/lib/coder-context-trim';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';
import { readFilesForCoderPreload } from './sandbox-tools';
import { buildCoderDelegationBrief } from './role-context';
import { type CorrelationContext } from '@push/lib/correlation-context';
import { type VerificationPolicy } from './verification-policy';
import { runInPageCoderKernel } from './inline-coder-run';

// ---------------------------------------------------------------------------
// Pure-helper re-exports — the Coder agent test suite and useAgentDelegation
// import these from `./coder-agent`. Keep the paths unchanged.
// `generateCheckpointAnswer` moved to `./inline-coder-run` (the checkpoint-
// answerer factory there needs it without an import cycle); re-exported so
// the historical import surface holds.
// ---------------------------------------------------------------------------

export {
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  invalidateObservationDependencies,
  normalizeTrimmedRoleAlternation,
  shouldInjectCoderStateOnToolResult,
  summarizeCoderStateForHandoff,
};

export { generateCheckpointAnswer } from './inline-coder-run';

export type { CoderAgentOptions, CoderAfterModelResult, CoderToolExecResult };

// ---------------------------------------------------------------------------
// runCoderAgent — preserves the original Web-facing signature (envelope form
// and legacy positional form). Normalizes into the structured spec
// `runInPageCoderKernel` consumes, building the delegation-brief preamble on
// the way.
// ---------------------------------------------------------------------------

export async function runCoderAgent(
  taskOrEnvelope: string | DelegationEnvelope,
  sandboxId: string,
  filesOrCallbacks: string[] | CoderCallbacks,
  onStatus?: (phase: string, detail?: string) => void,
  agentsMd?: string,
  signal?: AbortSignal,
  onCheckpoint?: (question: string, context: string) => Promise<string>,
  acceptanceCriteria?: AcceptanceCriterion[],
  onWorkingMemoryUpdate?: (state: import('@/types').CoderWorkingMemory) => void,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
  delegationContext?: {
    intent?: string;
    deliverable?: string;
    knownContext?: string[];
    constraints?: string[];
    branchContext?: { activeBranch: string; defaultBranch: string; protectMain: boolean };
    /**
     * Repo/chat scope for the delegated Coder's memory tools (LCM). Threaded
     * from the orchestrator's session context — NOT the model — so the Coder's
     * `memory_grep`/`memory_expand` reads are bounded to this repo/branch/chat
     * and can't reach another repo's memory. When `repoFullName` is absent,
     * memory tools are not wired (the kernel denies them). Note this is the
     * memory READ scope only; the Coder still runs with `allowedRepo: ''` for
     * GitHub tools by design.
     */
    repoFullName?: string;
    chatId?: string;
    instructionFilename?: string;
    harnessSettings?: HarnessProfileSettings;
    plannerBrief?: string;
    verificationPolicy?: VerificationPolicy;
    declaredCapabilities?: import('./capabilities').Capability[];
    /**
     * Passive correlation tags captured by the caller and threaded into
     * tool-execution spans (`push.chat_id`, `push.execution_id`, etc.).
     * Never alters tool behavior — see `lib/correlation-context.ts`.
     */
    correlation?: CorrelationContext;
    /**
     * Optional run-event sink. Forwarded to the lib kernel so the
     * `assistant.prompt_snapshot` event reaches the chat run-event
     * stream for this delegation. When unset, no event is emitted.
     */
    onRunEvent?: (event: import('@push/lib/runtime-contract').RunEventInput) => void;
    /**
     * Orchestrator-level user goal anchor. When present, rendered as a
     * `[USER_GOAL]` block at the top of the Coder's task preamble so the
     * delegated agent sees the same goal constraint the orchestrator was
     * bound by. See `lib/user-goal-anchor.ts` for the format.
     */
    userGoal?: import('@push/lib/user-goal-anchor').UserGoalAnchor;
    /** Per-task rationale from `TaskGraphNode.addresses`. Rendered as
     *  `Addresses: <text>` alongside the user-goal block. */
    addresses?: string;
  },
): Promise<CoderResult> {
  // --- Normalise: envelope-based call → unified locals ---
  let task: string;
  let files: string[];
  let statusFn: (phase: string, detail?: string) => void;
  let effectiveAgentsMd: string | undefined;
  let effectiveSignal: AbortSignal | undefined;
  let effectiveOnCheckpoint: ((question: string, context: string) => Promise<string>) | undefined;
  let effectiveAcceptanceCriteria: AcceptanceCriterion[] | undefined;
  let effectiveOnWorkingMemoryUpdate:
    | ((state: import('@/types').CoderWorkingMemory) => void)
    | undefined;
  let effectiveProviderOverride: ActiveProvider | undefined;
  let effectiveModelOverride: string | undefined;
  let effectiveDelegationContext: typeof delegationContext;
  let effectiveHarnessSettings: HarnessProfileSettings | undefined;
  let effectivePlannerBrief: string | undefined;
  let envelopeDeclaredCapabilities: import('./capabilities').Capability[] | undefined;

  if (typeof taskOrEnvelope === 'object') {
    const envelope = taskOrEnvelope;
    const callbacks = filesOrCallbacks as CoderCallbacks;
    task = envelope.task;
    files = envelope.files;
    statusFn = callbacks.onStatus;
    effectiveAgentsMd = envelope.projectInstructions;
    effectiveSignal = callbacks.signal;
    effectiveOnCheckpoint = callbacks.onCheckpoint;
    effectiveAcceptanceCriteria = envelope.acceptanceCriteria;
    effectiveOnWorkingMemoryUpdate = callbacks.onWorkingMemoryUpdate;
    effectiveProviderOverride =
      envelope.provider === 'demo' ? undefined : (envelope.provider as ActiveProvider);
    effectiveModelOverride = envelope.model;
    effectiveHarnessSettings = envelope.harnessSettings;
    effectivePlannerBrief = envelope.plannerBrief;
    envelopeDeclaredCapabilities = envelope.declaredCapabilities;
    effectiveDelegationContext = {
      intent: envelope.intent,
      deliverable: envelope.deliverable,
      knownContext: envelope.knownContext,
      constraints: envelope.constraints,
      branchContext: envelope.branchContext,
      instructionFilename: envelope.instructionFilename,
      verificationPolicy: envelope.verificationPolicy,
      correlation: envelope.correlation,
    };
  } else {
    task = taskOrEnvelope;
    files = filesOrCallbacks as string[];
    statusFn = onStatus!;
    effectiveAgentsMd = agentsMd;
    effectiveSignal = signal;
    effectiveOnCheckpoint = onCheckpoint;
    effectiveAcceptanceCriteria = acceptanceCriteria;
    effectiveOnWorkingMemoryUpdate = onWorkingMemoryUpdate;
    effectiveProviderOverride = providerOverride;
    effectiveModelOverride = modelOverride;
    effectiveHarnessSettings = delegationContext?.harnessSettings;
    effectivePlannerBrief = delegationContext?.plannerBrief;
    effectiveDelegationContext = delegationContext;
    envelopeDeclaredCapabilities = delegationContext?.declaredCapabilities;
  }

  // --- Resolve provider/model ---
  const activeProvider = effectiveProviderOverride || getActiveProvider();
  if (activeProvider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }
  const roleModel = getModelForRole(activeProvider, 'coder');
  const coderModelId = effectiveModelOverride || roleModel?.id;

  // --- Build the delegation-brief task preamble ---
  let taskPreamble = buildCoderDelegationBrief({
    task,
    files,
    acceptanceCriteria: effectiveAcceptanceCriteria,
    intent: effectiveDelegationContext?.intent,
    deliverable: effectiveDelegationContext?.deliverable,
    knownContext: effectiveDelegationContext?.knownContext,
    constraints: effectiveDelegationContext?.constraints,
    userGoal: effectiveDelegationContext?.userGoal,
    addresses: effectiveDelegationContext?.addresses,
    provider: activeProvider,
    model: coderModelId,
  } as DelegationEnvelope);
  if (effectivePlannerBrief) {
    taskPreamble += '\n\n' + effectivePlannerBrief;
  }

  // Preload the contents of the files the Orchestrator flagged so the Coder
  // starts with them (and current line hashes) instead of burning its first
  // rounds re-reading what the Orchestrator already saw.
  if (files && files.length > 0) {
    const preloadedFiles = await readFilesForCoderPreload(sandboxId, files);
    if (preloadedFiles) {
      taskPreamble += '\n\n' + preloadedFiles;
    }
  }

  // --- Run the kernel through the shared in-page assembly ---
  return runInPageCoderKernel(
    {
      provider: activeProvider,
      modelId: coderModelId,
      sandboxId,
      taskPreamble,
      declaredCapabilities: envelopeDeclaredCapabilities,
      branchContext: effectiveDelegationContext?.branchContext,
      projectInstructions: effectiveAgentsMd,
      instructionFilename: effectiveDelegationContext?.instructionFilename,
      verificationPolicy: effectiveDelegationContext?.verificationPolicy,
      acceptanceCriteria: effectiveAcceptanceCriteria,
      harnessSettings: effectiveHarnessSettings,
      memoryScope: effectiveDelegationContext?.repoFullName
        ? {
            repoFullName: effectiveDelegationContext.repoFullName,
            branch: effectiveDelegationContext.branchContext?.activeBranch,
            chatId: effectiveDelegationContext.chatId,
          }
        : undefined,
      correlation: effectiveDelegationContext?.correlation,
    },
    {
      onStatus: statusFn,
      signal: effectiveSignal,
      onCheckpointRequest: effectiveOnCheckpoint,
      onWorkingMemoryUpdate: effectiveOnWorkingMemoryUpdate,
      onRunEvent: effectiveDelegationContext?.onRunEvent,
    },
  );
}
